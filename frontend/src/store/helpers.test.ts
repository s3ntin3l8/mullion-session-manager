// Issue #1427 — unit coverage for the pure read-cursor-merge and
// dismissed-key-capping helpers behind the server-owned read cursor
// (store/slices/events.ts wires these into startEventsStream's onCursors/
// onSeen handlers and dismissEvent/dismissEvents; see those call sites for
// the integration-level coverage in store.events.test.ts).
import { describe, it, expect } from "vitest";
import {
  applyLiveSeen,
  capDismissedEventKeys,
  DISMISSED_EVENT_KEYS_CAP,
  eventKey,
  mergeCursorsFrame,
  mergeServerCursor,
} from "./helpers.js";

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

  it("treats local === head as still legitimately local, not a restart", () => {
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
