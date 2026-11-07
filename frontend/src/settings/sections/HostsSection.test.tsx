// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostsSection } from "./HostsSection.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost } from "../../test/fixtures.js";
import type { PlacementCapability } from "../../../../src/shared/constants.js";

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

  it("shows an outbound-only host as connected without an address (issue #2572)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h1",
          name: "laptop",
          baseUrl: null,
          health: "online",
          hasMachineIdentity: true,
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText(/connected over the outbound channel/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for the agent/)).not.toBeInTheDocument();
  });

  it("shows a saturated channel's reason on the row, with an explanation on hover (issue #2702)", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "h",
          name: "busy-box",
          health: "degraded",
          healthReason: "channel saturated",
          lastCheckedAt: "2026-01-01T00:00:10.000Z",
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText("channel saturated")).toHaveAttribute(
      "title",
      expect.stringMatching(/every request slot has been busy/),
    );
  });

  it("flags a host with leaked browsers (issue #2641)", () => {
    stubFetch({});
    useDashboardStore.setState({ hosts: [makeHost({ id: "h", name: "ctr", leakedBrowsers: 2 })] });
    render(<HostsSection />);
    expect(screen.getByText("2 leaked browsers")).toBeInTheDocument();
  });

  it("flags a possible duplicate and offers Remove stale host on the older row only (issue #2582)", async () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "old", name: "ctr-old", health: "offline" }),
        makeHost({ id: "new", name: "ctr-new", possibleDuplicateOf: ["old"] }),
      ],
    });
    const user = userEvent.setup();
    render(<HostsSection />);
    expect(screen.getByText(/Possible duplicate of ctr-old/)).toBeInTheDocument();
    const [oldMenu, newMenu] = screen.getAllByRole("button", { name: "More…" });
    await user.click(oldMenu);
    expect(screen.getByText("Remove stale host")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(newMenu);
    expect(screen.queryByText("Remove stale host")).not.toBeInTheDocument();
    expect(screen.getByText("Delete host")).toBeInTheDocument();
  });

  it("shows capability chips, or says capabilities are unknown", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({ id: "h1", name: "mac", capabilities: ["xcode", "android-emulator"] }),
        makeHost({ id: "h2", name: "old", capabilities: null }),
        makeHost({ id: "h3", name: "bare", capabilities: [] }),
        // A newer agent may report an id this build has no label for.
        makeHost({
          id: "h4",
          name: "newer",
          capabilities: ["xcode", "future-cap"] as unknown as PlacementCapability[],
        }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByText("Xcode · future-cap")).toBeInTheDocument();
    expect(screen.getByText("Xcode · Android emulator")).toBeInTheDocument();
    expect(screen.getByText("capabilities unknown")).toBeInTheDocument();
    expect(screen.getByText("no extra capabilities")).toBeInTheDocument();
  });

  it("shows the protocol version, legacy hosts, incompatibility and missing operations", () => {
    stubFetch({});
    useDashboardStore.setState({
      hosts: [
        makeHost({
          id: "ok",
          name: "ok",
          protocol: {
            protocolVersion: 1,
            incompatible: false,
            missingOperations: [],
            missingLaunchOptions: [],
            legacy: false,
          },
        }),
        makeHost({
          id: "old",
          name: "old",
          protocol: {
            protocolVersion: null,
            incompatible: false,
            missingOperations: ["updates"],
            missingLaunchOptions: ["model"],
            legacy: true,
          },
        }),
        makeHost({
          id: "bad",
          name: "bad",
          protocol: {
            protocolVersion: 9,
            incompatible: true,
            missingOperations: [],
            missingLaunchOptions: [],
            legacy: false,
          },
        }),
        makeHost({ id: "unk", name: "unk", protocol: null }),
      ],
    });
    render(<HostsSection />);
    expect(screen.getByTestId("host-protocol-ok")).toHaveTextContent("protocol v1");
    expect(screen.getByTestId("host-protocol-old")).toHaveTextContent(
      "protocol: legacy · missing: updates — update this host · launch options: model unavailable",
    );
    expect(screen.getByTestId("host-protocol-bad")).toHaveTextContent(
      "protocol v9 · incompatible — update this host",
    );
    expect(screen.queryByTestId("host-protocol-unk")).not.toBeInTheDocument();
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
