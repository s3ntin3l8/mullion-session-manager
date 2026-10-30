// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostsSection } from "./HostsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost } from "../../test/fixtures.js";

// Token rotation and the "waiting for the agent" row state. The rest of the
// section is exercised through its own components' tests.

function stubFetch(opts: { rotate?: () => Response }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/hosts" && method === "GET") {
        return Promise.resolve(jsonResponse(200, useDashboardStore.getState().hosts));
      }
      if (url.endsWith("/rotate-token") && method === "POST" && opts.rotate) {
        return Promise.resolve(opts.rotate());
      }
      // Per-host update status etc.: unavailable here, which the section swallows.
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    }),
  );
  return calls;
}

async function openRotate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More…" }));
  await user.click(screen.getByText("Rotate token"));
  await user.click(screen.getByText("Click again to rotate"));
}

describe("HostsSection token rotation", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h1", name: "win-pc", baseUrl: null })],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a host that has no baseUrl yet as waiting for its agent", () => {
    stubFetch({});
    render(<HostsSection />);
    expect(screen.getByText(/waiting for the agent to register/)).toBeInTheDocument();
  });

  it("shows capability chips, or says capabilities are unknown", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "h1", name: "mac", capabilities: ["xcode", "android-emulator"] }),
        makeHost({ id: "h2", name: "old", capabilities: null }),
        makeHost({ id: "h3", name: "bare", capabilities: [] }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText("Xcode · Android emulator")).toBeInTheDocument();
    expect(screen.getByText("capabilities unknown")).toBeInTheDocument();
    expect(screen.getByText("no extra capabilities")).toBeInTheDocument();
  });

  it("rotates after a second click and shows the new token once", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({ rotate: () => jsonResponse(200, { token: "new-token-abc" }) });
    render(<HostsSection />);

    await openRotate(user);

    expect(await screen.findByText("New token for win-pc")).toBeInTheDocument();
    expect(screen.getAllByText(/new-token-abc/).length).toBeGreaterThan(0);
    expect(calls).toContain("POST /api/hosts/h1/rotate-token");

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("New token for win-pc")).not.toBeInTheDocument();
  });

  it("surfaces a failed rotation instead of showing a token", async () => {
    const user = userEvent.setup();
    stubFetch({ rotate: () => jsonResponse(500, { message: "boom" }) });
    render(<HostsSection />);

    await openRotate(user);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByText(/New token for/)).not.toBeInTheDocument();
  });
});
