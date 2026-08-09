import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { NotificationEvent } from "../../src/services/pty-manager.js";

// Issue #213 (roadmap 4.7) — direct, fake-timer unit tests of the
// debounce/ceiling write path and the fixed-cadence retention sweep, against
// a `fakeApp()`-shaped object (no full buildApp()/real PTY spawn) — same
// split/testing style test/services/task-watcher.test.ts uses for
// src/plugins/task-watcher.ts's own startTaskWatcher.

const mockGetStoredSettings = vi.hoisted(() => vi.fn());
const mockInsertSessionEvents = vi.hoisted(() => vi.fn());
const mockSweepOldSessionEvents = vi.hoisted(() => vi.fn());
const mockSweepSessionEventCap = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

vi.mock("../../src/services/event-history.js", () => ({
  insertSessionEvents: mockInsertSessionEvents,
  sweepOldSessionEvents: mockSweepOldSessionEvents,
  sweepSessionEventCap: mockSweepSessionEventCap,
}));

const {
  startEventWriter,
  startEventRetentionSweep,
  EVENT_FLUSH_DEBOUNCE_MS,
  EVENT_FLUSH_CEILING_MS,
  EVENT_RETENTION_SWEEP_INTERVAL_MS,
} = await import("../../src/services/event-store.js");

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    seq: 1,
    sessionId: 42,
    kind: "status_change",
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

function fakeApp(sessionsSettings: {
  eventPersistence: boolean;
  eventRetentionDays: number;
  // Optional, defaulting to 0 (unlimited/disabled) — most fakeApp() call
  // sites in this file predate this setting and don't care about it.
  eventRetentionPerSession?: number;
}): {
  app: FastifyInstance;
  emit: (event: NotificationEvent) => void;
} {
  mockGetStoredSettings.mockReturnValue({
    sessions: { eventRetentionPerSession: 0, ...sessionsSettings },
  });
  const listeners: Array<(event: NotificationEvent) => void> = [];
  const app = {
    pty: {
      onEvent: vi.fn((cb: (event: NotificationEvent) => void) => {
        listeners.push(cb);
        return () => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      }),
    },
    db: {},
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyInstance;
  return { app, emit: (event) => listeners.forEach((l) => l(event)) };
}

describe("startEventWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInsertSessionEvents.mockReset();
    mockGetStoredSettings.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to app.pty.onEvent at construction (emit-time capture, not read-time)", () => {
    const { app } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    expect(app.pty.onEvent).toHaveBeenCalledTimes(1);
  });

  it("does not write when eventPersistence is off, even after the debounce fires", () => {
    const { app, emit } = fakeApp({ eventPersistence: false, eventRetentionDays: 30 });
    startEventWriter(app);
    emit(makeEvent());
    vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS);
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
  });

  it("batches buffered events and writes them once the debounce fires when persistence is on", () => {
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    emit(makeEvent({ seq: 1 }));
    emit(makeEvent({ seq: 2 }));
    expect(mockInsertSessionEvents).not.toHaveBeenCalled(); // not yet — debounce hasn't fired
    vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS);
    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(1);
    expect(mockInsertSessionEvents.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it("resets the trailing-edge debounce on every new event, delaying the flush", () => {
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    emit(makeEvent());
    vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS - 1000);
    emit(makeEvent()); // resets the 5s debounce
    vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS - 1000);
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("the hard ceiling timer forces a flush even if events never stop arriving", () => {
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    // Keep resetting the 5s debounce every 4s (never letting it fire alone)
    // for longer than the 30s ceiling — the ceiling must still force a flush.
    const tickMs = 4_000;
    const ticks = Math.ceil(EVENT_FLUSH_CEILING_MS / tickMs) + 1;
    for (let i = 0; i < ticks; i++) {
      emit(makeEvent({ seq: i + 1 }));
      vi.advanceTimersByTime(tickMs);
    }
    expect(mockInsertSessionEvents).toHaveBeenCalled();
  });

  it("logs, never throws, when the DB write fails", () => {
    mockInsertSessionEvents.mockImplementation(() => {
      throw new Error("boom");
    });
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    emit(makeEvent());
    expect(() => vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS)).not.toThrow();
    expect(app.log.error).toHaveBeenCalled();
  });

  // Regression test (review feedback): the eventPersistence settings read
  // must be OUTSIDE the try/catch that wraps insertSessionEvents. If a
  // settings-read failure fell into that catch, the per-row retry loop
  // would write the whole batch anyway with no re-check of the setting at
  // all — breaking the "opt-in, default off" contract on this one error
  // path. Fail closed instead: drop the batch, log, never write it.
  it("fails closed (drops the batch, never writes) when reading eventPersistence itself throws", () => {
    // getStoredSettings is only called inside flush() (and the retention
    // sweep, unused here) — never at startEventWriter construction — so
    // it's safe to make every call throw from the start.
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    mockGetStoredSettings.mockImplementation(() => {
      throw new Error("settings table unreadable");
    });
    startEventWriter(app);
    emit(makeEvent());
    expect(() => vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS)).not.toThrow();
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
      expect.stringContaining("dropping batch"),
    );
  });

  it("retries per-row on a batch failure, so ONE bad row doesn't drop the whole cross-session batch", () => {
    mockInsertSessionEvents.mockImplementation((_db: unknown, events: NotificationEvent[]) => {
      if (events.length > 1) throw new Error("batch boom"); // the initial whole-batch attempt
      if (events[0].seq === 2) throw new Error("row boom"); // only this one row is unpersistable
    });
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    startEventWriter(app);
    emit(makeEvent({ seq: 1 }));
    emit(makeEvent({ seq: 2 }));
    emit(makeEvent({ seq: 3 }));
    vi.advanceTimersByTime(EVENT_FLUSH_DEBOUNCE_MS);

    // 1 whole-batch attempt (throws) + 3 per-row retries = 4 calls total —
    // seq 1 and seq 3 must each get their own successful call.
    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(4);
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3, dropped: 1 }),
      expect.stringContaining("retried per-row"),
    );
  });

  it("cleanup unsubscribes, clears both timers, and flushes once more", () => {
    const { app, emit } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    const stop = startEventWriter(app);
    emit(makeEvent());
    stop();
    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(1);

    // Further events after stop() must never reach the writer — the
    // subscription itself is gone (unsubscribe() was called), so a further
    // flush (even from a lingering timer) must never fire either.
    mockInsertSessionEvents.mockClear();
    emit(makeEvent());
    vi.advanceTimersByTime(EVENT_FLUSH_CEILING_MS + 1000);
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
  });

  it("cleanup with an empty buffer does not call insertSessionEvents at all", () => {
    const { app } = fakeApp({ eventPersistence: true, eventRetentionDays: 30 });
    const stop = startEventWriter(app);
    stop();
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
  });
});

describe("startEventRetentionSweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSweepOldSessionEvents.mockReset();
    mockSweepSessionEventCap.mockReset();
    mockGetStoredSettings.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runNow() runs neither sweep when both settings are <= 0", async () => {
    const { app } = fakeApp({
      eventPersistence: false,
      eventRetentionDays: 0,
      eventRetentionPerSession: 0,
    });
    const sweep = startEventRetentionSweep(app);
    await sweep.runNow();
    expect(mockSweepOldSessionEvents).not.toHaveBeenCalled();
    expect(mockSweepSessionEventCap).not.toHaveBeenCalled();
    sweep.stop();
  });

  it("runNow() sweeps immediately against the currently persisted retentionDays", async () => {
    mockSweepOldSessionEvents.mockReturnValue(3);
    const { app } = fakeApp({ eventPersistence: false, eventRetentionDays: 14 });
    const sweep = startEventRetentionSweep(app);
    await sweep.runNow();
    expect(mockSweepOldSessionEvents).toHaveBeenCalledWith(app.db, 14);
    sweep.stop();
  });

  // Issue #213's own body asked for both an age bound and a per-session
  // count bound — two independent settings, so each gets its own
  // `<= 0` no-op check rather than one short-circuiting the other.
  it("runNow() sweeps the per-session cap independently of eventRetentionDays", async () => {
    mockSweepOldSessionEvents.mockReturnValue(0);
    mockSweepSessionEventCap.mockReturnValue(7);
    const { app } = fakeApp({
      eventPersistence: false,
      eventRetentionDays: 0, // age sweep off
      eventRetentionPerSession: 200, // count cap on
    });
    const sweep = startEventRetentionSweep(app);
    await sweep.runNow();
    expect(mockSweepOldSessionEvents).not.toHaveBeenCalled();
    expect(mockSweepSessionEventCap).toHaveBeenCalledWith(app.db, 200);
    sweep.stop();
  });

  it("runNow() runs BOTH sweeps in the same tick when both settings are on", async () => {
    mockSweepOldSessionEvents.mockReturnValue(1);
    mockSweepSessionEventCap.mockReturnValue(1);
    const { app } = fakeApp({
      eventPersistence: false,
      eventRetentionDays: 30,
      eventRetentionPerSession: 100,
    });
    const sweep = startEventRetentionSweep(app);
    await sweep.runNow();
    expect(mockSweepOldSessionEvents).toHaveBeenCalledWith(app.db, 30);
    expect(mockSweepSessionEventCap).toHaveBeenCalledWith(app.db, 100);
    sweep.stop();
  });

  it("re-arms on the fixed cadence regardless of retentionDays' own magnitude", async () => {
    mockSweepOldSessionEvents.mockReturnValue(0);
    // A large retentionDays must NOT translate into a long cadence — the
    // cadence is a fixed constant, independent of this setting (see the
    // module's own header comment on why).
    const { app } = fakeApp({ eventPersistence: false, eventRetentionDays: 3650 });
    startEventRetentionSweep(app);
    await vi.advanceTimersByTimeAsync(EVENT_RETENTION_SWEEP_INTERVAL_MS);
    expect(mockSweepOldSessionEvents).toHaveBeenCalledTimes(1);
  });

  it("stop() prevents further ticks", async () => {
    mockSweepOldSessionEvents.mockReturnValue(0);
    const { app } = fakeApp({ eventPersistence: false, eventRetentionDays: 5 });
    const sweep = startEventRetentionSweep(app);
    sweep.stop();
    await vi.advanceTimersByTimeAsync(EVENT_RETENTION_SWEEP_INTERVAL_MS * 2);
    expect(mockSweepOldSessionEvents).not.toHaveBeenCalled();
  });

  it("logs, never throws, when the sweep itself fails", async () => {
    mockSweepOldSessionEvents.mockImplementation(() => {
      throw new Error("sweep boom");
    });
    const { app } = fakeApp({ eventPersistence: false, eventRetentionDays: 30 });
    const sweep = startEventRetentionSweep(app);
    await expect(sweep.runNow()).resolves.toBeUndefined();
    expect(app.log.error).toHaveBeenCalled();
    sweep.stop();
  });

  it("logs, never throws, when the per-session cap sweep itself fails", async () => {
    mockSweepSessionEventCap.mockImplementation(() => {
      throw new Error("cap sweep boom");
    });
    const { app } = fakeApp({
      eventPersistence: false,
      eventRetentionDays: 0,
      eventRetentionPerSession: 100,
    });
    const sweep = startEventRetentionSweep(app);
    await expect(sweep.runNow()).resolves.toBeUndefined();
    expect(app.log.error).toHaveBeenCalled();
    sweep.stop();
  });
});
