// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PairDesktopSection } from "./PairDesktopSection.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost } from "../../test/fixtures.js";

const CODE = "ab".repeat(32);

describe("PairDesktopSection (issue #2449)", () => {
  let pairings: unknown[];
  beforeEach(() => {
    pairings = [];
    useDashboardStore.setState({
      hosts: [makeHost({ id: "h1", name: "mac-mini", health: "offline" })],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/host-pairings" && method === "POST") {
          pairings = [
            {
              id: "p1",
              label: null,
              state: "pending",
              expires_at: new Date(Date.now() + 600_000).toISOString(),
              created_at: new Date().toISOString(),
              host_id: null,
            },
          ];
          return Promise.resolve(
            jsonResponse(200, {
              id: "p1",
              pairing_link: `mullion://pair?url=http%3A%2F%2Fp.test&code=${CODE}`,
              url: "http://p.test",
              code: CODE,
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            }),
          );
        }
        if (url === "/api/host-pairings" && method === "GET") {
          return Promise.resolve(jsonResponse(200, pairings));
        }
        if (url === "/api/host-pairings/p1" && method === "DELETE") {
          pairings = [{ ...(pairings[0] as object), state: "revoked" }];
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the link, the download/retry path and manual fallback, then lets the user cancel", async () => {
    const user = userEvent.setup();
    render(<PairDesktopSection />);
    await user.click(screen.getByText("Generate pairing link"));
    expect(await screen.findByText("Open in Helper")).toHaveAttribute(
      "href",
      `mullion://pair?url=http%3A%2F%2Fp.test&code=${CODE}`,
    );
    expect(screen.getByText(/Helper not installed/)).toBeInTheDocument();
    expect(screen.getByText(CODE)).toBeInTheDocument();
    expect(await screen.findByTestId("pairing-stage-p1")).toHaveTextContent(
      "waiting for the Helper",
    );
    await user.click(screen.getByText("Cancel"));
    await vi.waitFor(() => expect(screen.queryByTestId("pairing-row-p1")).toBeNull());
  });

  it("distinguishes paired from connected", async () => {
    pairings = [
      {
        id: "p1",
        label: null,
        state: "paired",
        expires_at: "2030-01-01T00:00:00Z",
        created_at: "2030-01-01T00:00:00Z",
        host_id: "h1",
      },
    ];
    render(<PairDesktopSection />);
    expect(await screen.findByTestId("pairing-stage-p1")).toHaveTextContent(
      "paired · not reachable yet",
    );
  });
});
