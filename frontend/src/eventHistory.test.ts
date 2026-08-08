import { describe, it, expect } from "vitest";
import { fromLiveEvent, mergeTimelineEvents, toTimelineEvent } from "./eventHistory.js";
import type { NotificationEvent, StoredEventRow } from "./api.js";

function makeRow(overrides: Partial<StoredEventRow> = {}): StoredEventRow {
  return {
    id: 1,
    sessionId: 1,
    seq: 1,
    kind: "attention",
    ts: 1000,
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

function makeLive(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: 1000,
    payload: { attention: true, signal: "bell" },
    ...overrides,
  };
}

describe("toTimelineEvent", () => {
  it("carries a row's fields through, including its rowId", () => {
    const event = toTimelineEvent(makeRow({ id: 42, seq: 3, ts: 5000, kind: "session_end" }));
    expect(event).toEqual({
      seq: 3,
      kind: "session_end",
      ts: 5000,
      payload: { attention: true, signal: "bell" },
      sessionId: 1,
      rowId: 42,
    });
  });

  it("normalizes a null payload to an empty object", () => {
    const event = toTimelineEvent(makeRow({ payload: null }));
    expect(event?.payload).toEqual({});
  });

  it("preserves a null sessionId (an orphaned row whose session was deleted)", () => {
    const event = toTimelineEvent(makeRow({ sessionId: null }));
    expect(event?.sessionId).toBeNull();
  });

  it("drops a row whose kind isn't in the known union", () => {
    expect(toTimelineEvent(makeRow({ kind: "some_future_kind" }))).toBeNull();
  });
});

describe("fromLiveEvent", () => {
  it("carries a live event's fields through with rowId left undefined", () => {
    const event = fromLiveEvent(makeLive({ seq: 7, sessionId: 2, ts: 9000 }));
    expect(event.rowId).toBeUndefined();
    expect(event.sessionId).toBe(2);
    expect(event.seq).toBe(7);
    expect(event.ts).toBe(9000);
  });
});

describe("mergeTimelineEvents", () => {
  it("sorts the merged result ascending by ts", () => {
    const merged = mergeTimelineEvents(
      [toTimelineEvent(makeRow({ id: 1, seq: 2, ts: 2000 }))!],
      [fromLiveEvent(makeLive({ seq: 1, ts: 1000 }))],
    );
    expect(merged.map((e) => e.ts)).toEqual([1000, 2000]);
  });

  it("dedupes an identical (sessionId, seq, ts, kind) event present in both sources", () => {
    const historyEvent = toTimelineEvent(makeRow({ id: 9, seq: 1, ts: 1000 }))!;
    const liveEvent = fromLiveEvent(makeLive({ seq: 1, ts: 1000 }));
    const merged = mergeTimelineEvents([historyEvent], [liveEvent]);
    expect(merged).toHaveLength(1);
  });

  it("the history copy wins a dedupe collision, carrying its rowId", () => {
    const historyEvent = toTimelineEvent(makeRow({ id: 9, seq: 1, ts: 1000 }))!;
    const liveEvent = fromLiveEvent(makeLive({ seq: 1, ts: 1000 }));
    const merged = mergeTimelineEvents([historyEvent], [liveEvent]);
    expect(merged[0].rowId).toBe(9);
  });

  it("does NOT dedupe a seq collision across a restart (same seq, different ts)", () => {
    // Session.eventSeq resets to 1 after a backend restart for a surviving
    // dtach session (pty-manager.ts) — (sessionId, seq) alone repeats over
    // time, so these two genuinely distinct events must both survive.
    const before = toTimelineEvent(makeRow({ id: 1, seq: 1, ts: 1000, kind: "attention" }))!;
    const after = toTimelineEvent(
      makeRow({ id: 2, seq: 1, ts: 5000, kind: "session_end", payload: {} }),
    )!;
    const merged = mergeTimelineEvents([before, after], []);
    expect(merged).toHaveLength(2);
  });

  it("keeps two orphaned (sessionId: null) rows distinct, sorted by seq as a tiebreak", () => {
    const a = toTimelineEvent(makeRow({ id: 1, sessionId: null, seq: 1, ts: 1000 }))!;
    const b = toTimelineEvent(makeRow({ id: 2, sessionId: null, seq: 2, ts: 1000 }))!;
    const merged = mergeTimelineEvents([a, b], []);
    expect(merged.map((e) => e.rowId)).toEqual([1, 2]);
  });
});
