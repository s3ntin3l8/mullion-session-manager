// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import type { Host } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch, type RouteTable } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

describe("Settings -> Hosts outbound channel status & unbind", () => {
  let hostsDb: Array<Host & { hasProjects: boolean }>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    hostsDb = [
      {
        id: "remote-1",
        name: "home-server",
        baseUrl: "http://192.168.1.20:4000",
        isLocal: false,
        hasToken: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        health: "pending",
        lastSeenAt: null,
        lastCheckedAt: null,
        drained: false,
        role: "worker",
        hasProjects: true,
        channel: {
          bound: true,
          connectedAt: null,
          ready: false,
          carriedOperations: [],
          status: "bound to the outbound channel, not connected",
        },
      },
    ];

    ({ fetchMock, unexpectedCalls } = mockFetch(baseRoutes()));
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ hosts: [] });
  });

  function baseRoutes(): RouteTable {
    return {
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, hostsDb),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/bridges": () => jsonResponse(200, []),
      "GET /api/host-pairings": () => jsonResponse(200, []),
      "GET /api/hosts/:id/update": () =>
        jsonResponse(200, { upToDate: true, status: { phase: "idle" } }),
      "POST /api/hosts/:id/unbind": ({ params }) => {
        const host = hostsDb.find((h) => h.id === params.id);
        if (host && host.channel) {
          host.channel = {
            bound: false,
            connectedAt: null,
            ready: false,
            carriedOperations: [],
            status: "not connected",
          };
        }
        return jsonResponse(200, { ok: true });
      },
    };
  }

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows 'bound to the outbound channel, not connected' warning and lets user unbind", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("host-row-remote-1");
    expect(
      await within(row).findByText("bound to the outbound channel, not connected"),
    ).toBeInTheDocument();

    const unbindButton = within(row).getByRole("button", { name: "Unbind" });
    expect(unbindButton).toBeInTheDocument();

    await user.click(unbindButton);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosts/remote-1/unbind",
      expect.objectContaining({ method: "POST" }),
    );

    // After unbinding, the warning text and button are no longer shown
    await waitFor(() => {
      expect(
        within(row).queryByText("bound to the outbound channel, not connected"),
      ).not.toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: "Unbind" })).not.toBeInTheDocument();
    });
  });
});
