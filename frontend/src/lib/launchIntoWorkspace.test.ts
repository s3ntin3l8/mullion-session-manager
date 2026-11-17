// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchIntoWorkspace } from "./launchIntoWorkspace.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { makeSession, makeWorkspace } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";
import { useDashboardStore } from "../store/index.js";

// #3246 — the launch path for a session started on the phone into another
// workspace: the open is recorded for the chosen workspace (#3033's
// pending-opens route), never for the one being left.
describe("launchIntoWorkspace", () => {
  let calls: string[] = [];
  let unexpected: string[] = [];

  beforeEach(() => {
    calls = [];
    resetStore({
      workspaces: [makeWorkspace({ id: 1 }), makeWorkspace({ id: 2, name: "B" })],
      activeWorkspaceId: 1,
      viewMode: "list",
    });
    const result = mockFetch({
      "POST /api/workspaces/:id/pending-opens": ({ params, init }) => {
        calls.push(`record ${params.id} ${String(init?.body)}`);
        return jsonResponse(201, {});
      },
      "DELETE /api/workspaces/:id/pending-opens/:sessionId": ({ params }) => {
        calls.push(`withdraw ${params.id} ${params.sessionId}`);
        return new Response(null, { status: 204 });
      },
    });
    unexpected = result.unexpectedCalls;
    vi.stubGlobal("fetch", result.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(unexpected).toEqual([]);
  });

  it("records the pending open for the chosen workspace, leaves A's untouched, and switches to it", async () => {
    launchIntoWorkspace(makeSession({ id: 42 }), 2);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual(['record 2 {"sessionId":42,"referenceSessionId":null}']);
    const state = useDashboardStore.getState();
    expect(state.activeWorkspaceId).toBe(2);
    expect(state.viewMode).toBe("list");
    // The pane opens once the switch has happened (usePostWorkspaceSwitchHighlight).
    expect(state.highlightedPanelId).toBe("session-42");
  });

  it("a failed record still switches: the session opens on the phone either way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    expect(() => launchIntoWorkspace(makeSession({ id: 7 }), 2)).not.toThrow();
    expect(useDashboardStore.getState().activeWorkspaceId).toBe(2);
  });
});
