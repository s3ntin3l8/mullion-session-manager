// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HostPairings } from "./HostPairings.js";
import { useDashboardStore } from "../../store/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { makeHost } from "../../test/fixtures.js";

describe("HostPairings (issue #2449)", () => {
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

  it("shows pending pairing activity and lets the user cancel the code", async () => {
    const user = userEvent.setup();
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
    render(<HostPairings />);
    expect(await screen.findByTestId("pairing-stage-p1")).toHaveTextContent(
      "waiting for the agent",
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
    render(<HostPairings />);
    expect(await screen.findByTestId("pairing-stage-p1")).toHaveTextContent(
      "paired · not reachable yet",
    );
  });
});
