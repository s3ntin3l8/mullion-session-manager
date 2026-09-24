// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SERVER_INFO_FIXTURE } from "../../test/serverInfoFixture.js";
import { act } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { api } from "../../api/index.js";
import type { BridgeSummary } from "../../api/index.js";
import { computeReorder } from "../../reorder.js";
import type { ReorderItem } from "../../reorder.js";
import { BRIDGES_POLL_MS } from "./BridgesSection.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

// Issue #820 PR7c — same fake-in-memory-backend shape as
// Settings.hosts.test.tsx's own describe block: exercises Settings ->
// Hosts's new BridgesSection against a fake GET/POST/DELETE /api/bridges
// backend, so the real request()/component wiring is what's under test,
// not a mocked store.

describe("Settings -> Hosts -> SSH agent bridges (issue #820 PR7c)", () => {
  let bridgesDb: BridgeSummary[];
  let bridgesShouldFail: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];
  let pairCounter: number;

  beforeEach(() => {
    bridgesDb = [];
    bridgesShouldFail = false;
    pairCounter = 0;

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/bridges": () =>
        bridgesShouldFail
          ? jsonResponse(500, { message: "internal error" })
          : jsonResponse(200, bridgesDb),
      "POST /api/bridges": () => {
        pairCounter += 1;
        const id = `bridge-${pairCounter}`;
        // Mirrors what the real route does (issuePairingCode only — see
        // src/routes/agent-bridge.ts): a freshly-issued pairing row has no
        // live session and has never been seen. Getting this wrong here
        // (an earlier version of this mock set hasLiveSession: true) is
        // exactly what let BridgesSection's "revoked session" mislabel of
        // this same state ship unnoticed — self-review caught it.
        bridgesDb = [
          ...bridgesDb,
          {
            id,
            name: null,
            platform: null,
            lastSeenAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            hasLiveSession: false,
            connected: false,
            // Mirrors trackBridge's own "0" for a freshly-paired bridge
            // (src/routes/agent-bridge.ts) — issuePairingCode's row never
            // got a PATCH /api/bridges/reorder, so it still carries the
            // priority column's default.
            priority: 0,
          },
        ];
        return jsonResponse(200, {
          bridge_id: id,
          pairing_payload: `payload-${id}`,
          expires_at: "2026-01-01T00:10:00.000Z",
        });
      },
      "DELETE /api/bridges/:id": ({ params }) => {
        const before = bridgesDb.length;
        bridgesDb = bridgesDb.filter((b) => b.id !== params.id);
        if (bridgesDb.length === before) return jsonResponse(404, { message: "not found" });
        return jsonResponse(204);
      },
      // Issue #1313 — mirrors PATCH /api/bridges/reorder's own validation
      // and contiguous-reindex (src/routes/agent-bridge.ts /
      // bridge-registry.ts's reorderBridges): reject duplicates or an id
      // that doesn't name a bridge in this fake DB, otherwise reindex
      // `priority` to 0..N-1 in the given order.
      "PATCH /api/bridges/reorder": async ({ init }) => {
        const { ids } = JSON.parse(init?.body as string) as { ids: string[] };
        if (new Set(ids).size !== ids.length) {
          return jsonResponse(400, { message: "ids must not contain duplicates" });
        }
        const existingIds = new Set(bridgesDb.map((b) => b.id));
        for (const id of ids) {
          if (!existingIds.has(id)) return jsonResponse(400, { message: `unknown bridge ${id}` });
        }
        const priorityById = new Map(ids.map((id, index) => [id, index]));
        bridgesDb = bridgesDb
          .map((b) => ({ ...b, priority: priorityById.get(b.id) ?? b.priority }))
          .sort((a, b) => a.priority - b.priority);
        return jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ hosts: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no bridge is paired", async () => {
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    expect(await screen.findByText(/No SSH agent bridges yet/)).toBeInTheDocument();
  });

  // Hermes review, PR #869 — a failed fetch used to fall through to the
  // same "no bridges paired" copy a genuinely empty list gets, reading as
  // confirmed success rather than "couldn't reach the server."
  it("shows a load error instead of the empty state when the list fetch fails", async () => {
    bridgesShouldFail = true;
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    expect(await screen.findByText("Couldn't load SSH agent bridges.")).toBeInTheDocument();
    expect(screen.queryByText(/No SSH agent bridges yet/)).not.toBeInTheDocument();
  });

  it("lists a paired, connected bridge with its name/platform and status", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 0,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("laptop-1")).toBeInTheDocument();
    expect(within(row).getByText("darwin")).toBeInTheDocument();
    expect(within(row).getByText("connected")).toBeInTheDocument();
  });

  it("shows 'last seen' instead of 'connected' once the helper disconnects", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: false,
        priority: 0,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText(/ago$/)).toBeInTheDocument();
    expect(within(row).queryByText("connected")).not.toBeInTheDocument();
  });

  // Self-review (mullion-reviewer) — a freshly-issued, not-yet-redeemed
  // pairing row (exactly what POST /api/bridges creates, and what appears
  // in this list WHILE PairBridgeModal is still open waiting) must never
  // read as "revoked session": DELETE /api/bridges/:id deletes the row
  // outright, so a genuinely revoked bridge disappears from this list
  // entirely — it never shows up with hasLiveSession: false.
  it("labels an unredeemed pairing row 'pairing pending', not 'revoked session'", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: null,
        platform: null,
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: false,
        connected: false,
        priority: 0,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("pairing pending")).toBeInTheDocument();
    expect(within(row).queryByText(/revoked/)).not.toBeInTheDocument();
  });

  it("labels a bridge whose session has lapsed 'session expired'", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: false,
        connected: false,
        priority: 0,
      },
    ];
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    expect(within(row).getByText("session expired")).toBeInTheDocument();
  });

  it("revokes a bridge and removes it from the list", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 0,
      },
    ];
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    const row = await screen.findByTestId("bridge-row-bridge-1");
    // ConfirmButton (Revoke's own guard against a stray click) requires two
    // separate clicks — arm, then confirm — and its accessible name changes
    // to a bare checkmark icon once armed, so this re-uses the SAME element
    // reference for both clicks rather than re-querying by "Revoke" a
    // second time (ConfirmButton.test.tsx's own pattern).
    const revokeButton = within(row).getByRole("button", { name: "Revoke" });
    await user.click(revokeButton);
    await user.click(revokeButton);

    await waitFor(() =>
      expect(screen.queryByTestId("bridge-row-bridge-1")).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridges/bridge-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("pairs a new bridge via the modal and shows the generated payload", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="hosts" />);

    await user.click(await screen.findByText("Pair a new bridge"));

    expect(await screen.findByText("payload-bridge-1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridges",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Issue #1313 — reorder.ts's own header explains why this project's
  // browser automation struggles to drive native HTML5 drag-and-drop
  // reliably, so this verifies the reorder feature at the
  // computeReorder/mutation level instead of simulating drag events:
  // compute what a "drag bridge-3 to the top" gesture would produce (the
  // exact math BridgesSection.tsx's own drag handlers run), send that
  // through the real api.reorderBridges() against the fake PATCH backend
  // above, and confirm the list re-renders in the new order.
  it("reorders bridges by priority via PATCH /api/bridges/reorder and re-renders in the new order", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 0,
      },
      {
        id: "bridge-2",
        name: "laptop-2",
        platform: "win32",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:01.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 1,
      },
      {
        id: "bridge-3",
        name: "laptop-3",
        platform: "linux",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:02.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 2,
      },
    ];

    vi.useFakeTimers();
    try {
      render(<Settings onClose={vi.fn()} initialSection="hosts" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("bridge-row-bridge-1")).toBeInTheDocument();

      // Same math BridgesSection.tsx's reorderedBridgeIds runs: map the
      // current (already priority-sorted) list onto index-based
      // ReorderItems in one ungrouped bucket, then drag index 2
      // ("bridge-3") to index 0 — exactly what dragging its row to the top
      // of the list would compute.
      const items: ReorderItem[] = bridgesDb.map((_, index) => ({
        id: index,
        groupId: null,
        position: index,
      }));
      const updates = computeReorder(items, 2, 0, null);
      const positionByIndex = new Map(items.map((item) => [item.id, item.position]));
      for (const update of updates) positionByIndex.set(update.id, update.position);
      const newIds = bridgesDb
        .map((_, index) => index)
        .sort((a, b) => positionByIndex.get(a)! - positionByIndex.get(b)!)
        .map((index) => bridgesDb[index].id);
      expect(newIds).toEqual(["bridge-3", "bridge-1", "bridge-2"]);

      await act(async () => {
        await api.reorderBridges(newIds);
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/bridges/reorder",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ ids: newIds }) }),
      );

      // The component's own 4s poll (BRIDGES_POLL_MS) picks up the new
      // GET /api/bridges order — bridge-3 now sorts first.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BRIDGES_POLL_MS);
      });

      const rows = screen.getAllByTestId(/^bridge-row-/);
      expect(rows.map((el) => el.dataset.testid)).toEqual([
        "bridge-row-bridge-3",
        "bridge-row-bridge-1",
        "bridge-row-bridge-2",
      ]);
      expect(within(rows[0]).getByText("laptop-3")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // Issue #1313 — the section's own "known trap": it polls every
  // BRIDGES_POLL_MS and refresh() overwrites `bridges` wholesale, so an
  // optimistic reorder that hasn't round-tripped yet must not be clobbered
  // by a poll landing in that window (the draggingRef/reorderingRef guard
  // in BridgesSection.tsx). The reorder test above deliberately bypasses
  // the component's own drag handlers (reorder.ts's own header explains
  // why real HTML5 DnD events aren't simulated here) and drives
  // api.reorderBridges() directly — so it never actually invokes
  // reorderedBridgeIds()/commitReorder(), and can't exercise this guard at
  // all. `fireEvent.dragStart`/`fireEvent.drop` below are NOT the "real
  // HTML5 DnD" that comment warns against — that's about this project's
  // own live-browser automation tooling struggling to drive an actual
  // OS-level drag gesture; a synthetic jsdom dispatch that directly
  // invokes React's onDragStart/onDrop handlers has none of that
  // unreliability and is the standard React Testing Library way to
  // exercise drag handlers.
  it("keeps the optimistic order while a reorder PATCH is in flight, even if a poll lands first (issue #1313's own 'known trap')", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 0,
      },
      {
        id: "bridge-2",
        name: "laptop-2",
        platform: "win32",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:01.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 1,
      },
    ];

    let resolvePatch: (() => void) | undefined;
    const patchGate = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/bridges": () => jsonResponse(200, bridgesDb),
      "PATCH /api/bridges/reorder": async ({ init }) => {
        // The gate holds this response open so a poll can land while the
        // PATCH is still in flight — bridgesDb is deliberately NOT updated
        // until after the gate opens, so a poll landing here returns the
        // STALE (pre-reorder) order. If BridgesSection.tsx's
        // reorderingRef guard were ever removed, that stale GET response
        // would snap the list back — which is exactly what this test
        // asserts does not happen.
        await patchGate;
        const { ids } = JSON.parse(init?.body as string) as { ids: string[] };
        const priorityById = new Map(ids.map((id, index) => [id, index]));
        bridgesDb = bridgesDb
          .map((b) => ({ ...b, priority: priorityById.get(b.id) ?? b.priority }))
          .sort((a, b) => a.priority - b.priority);
        return jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      render(<Settings onClose={vi.fn()} initialSection="hosts" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("bridge-row-bridge-1")).toBeInTheDocument();

      const row1 = screen.getByTestId("bridge-row-bridge-1");
      const handle2 = within(screen.getByTestId("bridge-row-bridge-2")).getByTitle(
        "Drag to reorder",
      );
      const dataTransfer = { setData: vi.fn(), effectAllowed: "" };

      // Drag bridge-2's handle and drop it onto bridge-1's row — the same
      // gesture the earlier test computes by hand, but this time actually
      // firing the component's own onDragStart/onDrop handlers. Fake
      // timers are active (`vi.useFakeTimers()` above), so `waitFor`'s own
      // internal polling can't be used here (it hangs against a faked
      // clock) — every wait in this test instead goes through explicit
      // `act(...vi.advanceTimersByTimeAsync...)`, matching the reorder
      // test above.
      await act(async () => {
        fireEvent.dragStart(handle2, { dataTransfer });
      });
      await act(async () => {
        fireEvent.drop(row1.parentElement!, { dataTransfer });
        await vi.advanceTimersByTimeAsync(0);
      });

      // The optimistic reorder (set synchronously in commitReorder, before
      // the PATCH resolves) is visible immediately.
      let rows = screen.getAllByTestId(/^bridge-row-/);
      expect(rows.map((el) => el.dataset.testid)).toEqual([
        "bridge-row-bridge-2",
        "bridge-row-bridge-1",
      ]);

      // A poll lands while the PATCH is still pending (the gate hasn't
      // opened yet) — must not revert to the stale GET order.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BRIDGES_POLL_MS);
      });
      rows = screen.getAllByTestId(/^bridge-row-/);
      expect(rows.map((el) => el.dataset.testid)).toEqual([
        "bridge-row-bridge-2",
        "bridge-row-bridge-1",
      ]);

      // Let the PATCH resolve and its own .finally() clear the guard.
      resolvePatch!();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      rows = screen.getAllByTestId(/^bridge-row-/);
      expect(rows.map((el) => el.dataset.testid)).toEqual([
        "bridge-row-bridge-2",
        "bridge-row-bridge-1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back to the pre-drag order and shows the server's error when the reorder PATCH fails", async () => {
    bridgesDb = [
      {
        id: "bridge-1",
        name: "laptop-1",
        platform: "darwin",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 0,
      },
      {
        id: "bridge-2",
        name: "laptop-2",
        platform: "win32",
        lastSeenAt: null,
        createdAt: "2026-01-01T00:00:01.000Z",
        hasLiveSession: true,
        connected: true,
        priority: 1,
      },
    ];

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE),
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/bridges": () => jsonResponse(200, bridgesDb),
      "PATCH /api/bridges/reorder": () => jsonResponse(500, { message: "internal error" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      render(<Settings onClose={vi.fn()} initialSection="hosts" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const row1 = screen.getByTestId("bridge-row-bridge-1");
      const handle2 = within(screen.getByTestId("bridge-row-bridge-2")).getByTitle(
        "Drag to reorder",
      );
      const dataTransfer = { setData: vi.fn(), effectAllowed: "" };

      // Fake timers are active — flush via explicit
      // `act(...vi.advanceTimersByTimeAsync...)` rather than `waitFor`
      // (which polls on a real timer and hangs against a faked clock),
      // matching the reorder tests above.
      await act(async () => {
        fireEvent.dragStart(handle2, { dataTransfer });
      });
      await act(async () => {
        fireEvent.drop(row1.parentElement!, { dataTransfer });
        await vi.advanceTimersByTimeAsync(0);
      });

      // Rolls back to the original order once the PATCH rejects, rather
      // than leaving the optimistic (now-wrong) order in place silently.
      const rows = screen.getAllByTestId(/^bridge-row-/);
      expect(rows.map((el) => el.dataset.testid)).toEqual([
        "bridge-row-bridge-1",
        "bridge-row-bridge-2",
      ]);
      expect(screen.getByText("internal error")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
