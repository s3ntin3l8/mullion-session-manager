// Issue #1427 — unit coverage for the pure read-cursor-merge and
// dismissed-key-capping helpers behind the server-owned read cursor
// (store/slices/events.ts wires these into startEventsStream's onCursors/
// onSeen handlers and dismissEvent/dismissEvents; see those call sites for
// the integration-level coverage in store.events.test.ts).
import { describe, it, expect } from "vitest";
import {
  addEvent,
  adoptServerCursors,
  applyLiveSeen,
  capDismissedEventKeys,
  DISMISSED_EVENT_KEYS_CAP,
  eventKey,
  mergeCursorsFrame,
  mergeServerCursor,
} from "./helpers.js";
import type { NotificationEvent } from "../api/index.js";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 5,
    kind: "attention",
    ts: 1000,
    payload: {},
    ...overrides,
  };
}

describe("mergeServerCursor (issue #1427)", () => {
  it("takes the higher of local and server when local is within the server's head", () => {
    expect(mergeServerCursor(3, { seen: 5, head: 10 })).toBe(5);
    expect(mergeServerCursor(7, { seen: 5, head: 10 })).toBe(7);
  });

  it("adopts the server's (lower) cursor when local sits above the server's head — a restart", () => {
    // Local claims to have seen seq 50, but the server has never emitted
    // past seq 10 in this process's lifetime — its own counters reset.
    expect(mergeServerCursor(50, { seen: 2, head: 10 })).toBe(2);
  });

  it("treats local === head as still legitimately local, not a restart — trusts local even over a lower server.seen", () => {
    // Hermes review, PR #1460 — the exact boundary: local(10) === head(10),
    // and the server itself hasn't been told anything was seen yet
    // (server.seen is 0). Falls through to Math.max(local, server.seen),
    // i.e. trusts local — see mergeServerCursor's own doc comment for why
    // that's correct in a bootId-confirmed same-incarnation call: `local`
    // being 10 here can only mean it was legitimately set against event
    // seq 10 while it existed, not a coincidental match to a reset
    // counter.
    expect(mergeServerCursor(10, { seen: 0, head: 10 })).toBe(10);
    expect(mergeServerCursor(10, { seen: 3, head: 10 })).toBe(10);
  });
});

describe("mergeCursorsFrame (issue #1427)", () => {
  it("merges every session present in the cursors frame", () => {
    const merged = mergeCursorsFrame(
      { 1: 3, 2: 50 },
      { 1: { seen: 5, head: 10 }, 2: { seen: 2, head: 10 } },
    );
    expect(merged).toEqual({ 1: 5, 2: 2 });
  });

  it("leaves a session absent from the cursors frame untouched", () => {
    // Session 9 belongs to a remote host, or isn't tracked by this
    // process at all — PtyManager.listCursors only covers local sessions.
    const merged = mergeCursorsFrame({ 9: 40 }, { 1: { seen: 5, head: 10 } });
    expect(merged).toEqual({ 9: 40, 1: 5 });
  });

  it("adopts the server's value for a session never locally seen before", () => {
    const merged = mergeCursorsFrame({}, { 1: { seen: 5, head: 10 } });
    expect(merged).toEqual({ 1: 5 });
  });

  it("parses string keys (the wire's JSON object keys) into numeric session ids", () => {
    const merged = mergeCursorsFrame({}, { "42": { seen: 1, head: 1 } });
    expect(merged).toEqual({ 42: 1 });
  });
});

// Issue #1459 — the frontend receives one independent `cursors` frame per
// enrolled host (routes/events.ts's relayRemoteEventsHost re-emits a
// separate, hostId-tagged frame per remote host, alongside the primary's
// own local one). store/slices/events.ts's onCursors handler applies
// mergeCursorsFrame/adoptServerCursors once per frame, sequentially,
// against the SAME shared `lastSeenSeq` record — these two functions
// already leave any session id absent from a given frame untouched
// (asserted individually above), which is exactly what makes that
// composable: applying frame A then frame B must never let B clobber a
// session A already resolved, and vice versa.
describe("mergeCursorsFrame/adoptServerCursors compose across independent per-host frames (issue #1459)", () => {
  it("a local frame followed by a remote host's frame: each only touches its own sessions", () => {
    // Simulates onCursors firing once for the primary's own local frame
    // (session 1), then once more for remote-host-a's frame (session 100) —
    // two independent calls threaded through the same lastSeenSeq record,
    // exactly as store/slices/events.ts's shared `set()` calls do.
    let lastSeenSeq: Record<number, number> = { 1: 2, 100: 40 };
    lastSeenSeq = mergeCursorsFrame(lastSeenSeq, { 1: { seen: 5, head: 10 } });
    expect(lastSeenSeq).toEqual({ 1: 5, 100: 40 });

    lastSeenSeq = mergeCursorsFrame(lastSeenSeq, { 100: { seen: 45, head: 50 } });
    expect(lastSeenSeq).toEqual({ 1: 5, 100: 45 });
  });

  it("a remote host's adopt (confirmed restart) leaves an already-merged LOCAL session's cursor untouched", () => {
    let lastSeenSeq: Record<number, number> = { 1: 5, 100: 40 };
    // Local frame merges normally first.
    lastSeenSeq = mergeCursorsFrame(lastSeenSeq, { 1: { seen: 5, head: 5 } });
    expect(lastSeenSeq[1]).toBe(5);

    // remote-a's own restart forces an adopt for session 100 only —
    // session 1 (this frame doesn't mention it at all) stays exactly as the
    // local merge left it.
    lastSeenSeq = adoptServerCursors(lastSeenSeq, { 100: { seen: 0, head: 60 } });
    expect(lastSeenSeq).toEqual({ 1: 5, 100: 0 });
  });

  it("two different remote hosts' frames, applied independently, never clobber each other's sessions", () => {
    let lastSeenSeq: Record<number, number> = {};
    lastSeenSeq = mergeCursorsFrame(lastSeenSeq, { 200: { seen: 3, head: 3 } }); // remote-a
    lastSeenSeq = mergeCursorsFrame(lastSeenSeq, { 300: { seen: 7, head: 7 } }); // remote-b
    expect(lastSeenSeq).toEqual({ 200: 3, 300: 7 });

    // remote-a alone restarts — remote-b's session is absent from this
    // frame and must be left exactly as it was.
    lastSeenSeq = adoptServerCursors(lastSeenSeq, { 200: { seen: 0, head: 9 } });
    expect(lastSeenSeq).toEqual({ 200: 0, 300: 7 });
  });
});

describe("adoptServerCursors (issue #1427)", () => {
  it("adopts the server's value unconditionally, even when it's lower than local", () => {
    // The whole point: mergeServerCursor's numeric heuristic can't always
    // tell a restart apart from ordinary growth once the server's new head
    // has caught up past the old local cursor — this is the branch that
    // fires once the cursors frame's bootId itself proves a restart
    // happened, bypassing that ambiguity entirely.
    const adopted = adoptServerCursors({ 5: 5 }, { 5: { seen: 0, head: 10 } });
    expect(adopted).toEqual({ 5: 0 });
  });

  it("leaves a session absent from the cursors frame untouched", () => {
    const adopted = adoptServerCursors({ 9: 40 }, { 1: { seen: 5, head: 10 } });
    expect(adopted).toEqual({ 9: 40, 1: 5 });
  });
});

describe("addEvent dedupe across a backend restart (issue #1427)", () => {
  it("keeps a brand-new post-restart event that happens to share a seq with an old one", () => {
    // The scenario mergeServerCursor's own doc comment describes: the
    // server's eventSeq resets to 0 on restart, so a genuinely new event
    // can collide on seq with something already buffered locally. Deduping
    // on seq alone (the pre-#1427 behavior) would silently drop this.
    const before = { 5: [event({ seq: 1, ts: 1000 })] };
    const after = addEvent(before, event({ seq: 1, ts: 5000 }));
    expect(after[5]).toHaveLength(2);
  });

  it("still dedupes a genuine replay of the same event (same seq AND ts)", () => {
    const before = { 5: [event({ seq: 1, ts: 1000 })] };
    const after = addEvent(before, event({ seq: 1, ts: 1000 }));
    expect(after[5]).toHaveLength(1);
  });
});

describe("applyLiveSeen (issue #1427)", () => {
  it("advances the cursor for a live cross-client seen broadcast", () => {
    expect(applyLiveSeen({ 1: 2 }, 1, 5)).toEqual({ 1: 5 });
  });

  it("is monotonic-only — never regresses on a stale/out-of-order broadcast", () => {
    const state = { 1: 5 };
    expect(applyLiveSeen(state, 1, 2)).toBe(state);
  });

  it("initializes a session with no prior cursor", () => {
    expect(applyLiveSeen({}, 3, 1)).toEqual({ 3: 1 });
  });
});

describe("capDismissedEventKeys (issue #1427)", () => {
  it("leaves a record at or under the cap untouched (same reference)", () => {
    const record = { [eventKey(1, 1, 1000)]: true as const };
    expect(capDismissedEventKeys(record)).toBe(record);
  });

  it("evicts the oldest entries (by insertion order) once over the cap", () => {
    const record: Record<string, true> = {};
    for (let i = 0; i < DISMISSED_EVENT_KEYS_CAP + 10; i++) {
      record[eventKey(1, i, i)] = true;
    }
    const capped = capDismissedEventKeys(record);
    expect(Object.keys(capped)).toHaveLength(DISMISSED_EVENT_KEYS_CAP);
    // The 10 oldest (seq 0-9) are gone; the newest survive.
    expect(capped[eventKey(1, 0, 0)]).toBeUndefined();
    expect(capped[eventKey(1, 9, 9)]).toBeUndefined();
    expect(capped[eventKey(1, 10, 10)]).toBe(true);
    expect(capped[eventKey(1, DISMISSED_EVENT_KEYS_CAP + 9, DISMISSED_EVENT_KEYS_CAP + 9)]).toBe(
      true,
    );
  });
});
