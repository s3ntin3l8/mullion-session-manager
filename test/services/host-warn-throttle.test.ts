import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_WARN_INTERVAL_MS,
  HostOutcomes,
  noteHostReachable,
  resetHostWarnThrottle,
  warnHostThrottled,
} from "../../src/services/host-warn-throttle.js";

function makeLog() {
  return { warn: vi.fn(), info: vi.fn() };
}

describe("host-warn-throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHostWarnThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetHostWarnThrottle();
  });

  it("logs the first occurrence with the host id and no suppressed count", () => {
    const log = makeLog();
    expect(warnHostThrottled(log, "h1", { projectId: 1 }, "down")).toBe(true);
    expect(log.warn).toHaveBeenCalledWith({ projectId: 1, hostId: "h1" }, "down");
  });

  it("suppresses repeats of the same (host, message) inside the interval", () => {
    const log = makeLog();
    warnHostThrottled(log, "h1", {}, "down");
    vi.advanceTimersByTime(HOST_WARN_INTERVAL_MS - 1);
    expect(warnHostThrottled(log, "h1", {}, "down")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("keys by host and by message independently", () => {
    const log = makeLog();
    warnHostThrottled(log, "h1", {}, "down");
    expect(warnHostThrottled(log, "h2", {}, "down")).toBe(true);
    expect(warnHostThrottled(log, "h1", {}, "other")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it("carries the suppressed count onto the next logged line, then restarts it", () => {
    const log = makeLog();
    warnHostThrottled(log, "h1", {}, "down");
    warnHostThrottled(log, "h1", {}, "down");
    warnHostThrottled(log, "h1", {}, "down");
    vi.advanceTimersByTime(HOST_WARN_INTERVAL_MS);
    expect(warnHostThrottled(log, "h1", {}, "down")).toBe(true);
    expect(log.warn).toHaveBeenLastCalledWith({ hostId: "h1", suppressed: 2 }, "down");

    vi.advanceTimersByTime(HOST_WARN_INTERVAL_MS);
    warnHostThrottled(log, "h1", {}, "down");
    expect(log.warn).toHaveBeenLastCalledWith({ hostId: "h1" }, "down");
  });

  it("logs one info line on recovery, with the suppressed total, and warns again after", () => {
    const log = makeLog();
    warnHostThrottled(log, "h1", {}, "down");
    warnHostThrottled(log, "h1", {}, "down");
    noteHostReachable(log, "h1", "down", "never-logged");
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { hostId: "h1", suppressed: 1, recovered: ["down"] },
      "host reachable again",
    );

    // The next outage is a first occurrence again, with no stale count.
    expect(warnHostThrottled(log, "h1", {}, "down")).toBe(true);
    expect(log.warn).toHaveBeenLastCalledWith({ hostId: "h1" }, "down");
  });

  it("stays silent for a host that never warned, or a message that was not throttled", () => {
    const log = makeLog();
    noteHostReachable(log, "h1", "down");
    warnHostThrottled(log, "h1", {}, "other");
    noteHostReachable(log, "h1", "down");
    expect(log.info).not.toHaveBeenCalled();
    // The unrelated stream is still throttled.
    expect(warnHostThrottled(log, "h1", {}, "other")).toBe(false);
  });

  describe("HostOutcomes", () => {
    it("does not report recovery for a host with a failed item next to a successful one", () => {
      const log = makeLog();
      warnHostThrottled(log, "h1", {}, "down");
      const outcome = new HostOutcomes();
      outcome.failed("h1");
      outcome.ok("h1");
      outcome.settle(log, "down");
      expect(log.info).not.toHaveBeenCalled();
      // Still throttled: the next repeat is swallowed.
      expect(warnHostThrottled(log, "h1", {}, "down")).toBe(false);
    });

    it("reports recovery once for a host whose items all succeeded", () => {
      const log = makeLog();
      warnHostThrottled(log, "h1", {}, "down");
      warnHostThrottled(log, "h2", {}, "down");
      const outcome = new HostOutcomes();
      outcome.ok("h1");
      outcome.ok("h1");
      outcome.failed("h2");
      outcome.settle(log, "down");
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        { hostId: "h1", suppressed: 0, recovered: ["down"] },
        "host reachable again",
      );
    });
  });
});
