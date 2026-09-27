// @vitest-environment jsdom
// Issue #1427 — dismissedEventKeys persistence. Mirrors mute.test.ts's own
// convention: exercises the real store's dismissEvent/dismissEvents actions
// end to end, asserting both the in-memory state AND the localStorage
// write (persistedState.ts's readDismissedEventKeys/writeDismissedEventKeys),
// so a dismissal survives a reload.
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./index.js";
import { eventKey } from "./helpers.js";
import { readDismissedEventKeys } from "../lib/persistedState.js";
import type { NotificationEvent } from "../api/index.js";

const STORAGE_KEY = "crs.dismissedEventKeys";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 1,
    kind: "attention",
    ts: 1000,
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({ events: {}, dismissedEventKeys: {} });
});

describe("dismissedEventKeys persistence (issue #1427)", () => {
  it("persists a single dismiss to localStorage", () => {
    useDashboardStore.setState({ events: { 1: [event({ seq: 5, ts: 2000 })] } });

    useDashboardStore.getState().dismissEvent(1, 5);

    const key = eventKey(1, 5, 2000);
    expect(useDashboardStore.getState().dismissedEventKeys[key]).toBe(true);
    expect(readDismissedEventKeys()).toEqual({ [key]: true });
    expect(localStorage.getItem(STORAGE_KEY)).toContain(key);
  });

  it("persists a batched dismissEvents call", () => {
    useDashboardStore.setState({
      events: { 1: [event({ seq: 1, ts: 1000 }), event({ seq: 2, ts: 2000 })] },
    });

    useDashboardStore.getState().dismissEvents(1, [1, 2]);

    const stored = readDismissedEventKeys();
    expect(stored[eventKey(1, 1, 1000)]).toBe(true);
    expect(stored[eventKey(1, 2, 2000)]).toBe(true);
  });

  it("survives a fresh read after being written (simulated reload)", () => {
    useDashboardStore.setState({ events: { 1: [event({ seq: 3, ts: 3000 })] } });
    useDashboardStore.getState().dismissEvent(1, 3);

    // A "reload" is just a fresh read of the same localStorage-backed
    // helper the slice's own initializer calls.
    expect(readDismissedEventKeys()).toEqual({ [eventKey(1, 3, 3000)]: true });
  });

  it("caps stored dismissals at 500, evicting the oldest first", () => {
    const events = Array.from({ length: 510 }, (_, i) => event({ seq: i, ts: i }));
    useDashboardStore.setState({ events: { 1: events } });

    const seqs = events.map((e) => e.seq);
    useDashboardStore.getState().dismissEvents(1, seqs);

    const stored = readDismissedEventKeys();
    expect(Object.keys(stored)).toHaveLength(500);
    expect(stored[eventKey(1, 0, 0)]).toBeUndefined();
    expect(stored[eventKey(1, 509, 509)]).toBe(true);
  });
});
