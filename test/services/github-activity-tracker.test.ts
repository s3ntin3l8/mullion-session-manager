import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ActivityTracker } from "../../src/services/github-activity-tracker.js";

describe("ActivityTracker", () => {
  let tracker: ActivityTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new ActivityTracker({
      activeIntervalMs: 15_000,
      quietIntervalMs: 60_000,
      activeTimeoutMs: 120_000,
      staleThresholdMs: 300_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getIntervalFor with no recorded activity", () => {
    it("returns quietIntervalMs for an unknown repo", () => {
      expect(tracker.getIntervalFor("o/r")).toBe(60_000);
    });
  });

  describe("recordPollResult", () => {
    it("sets state to active and returns activeIntervalMs when hasActivity is true", () => {
      tracker.recordPollResult("o/r", true);
      expect(tracker.getStateForTests("o/r")).toBe("active");
      expect(tracker.getIntervalFor("o/r")).toBe(15_000);
    });

    it("sets state to quiet for a new repo with no activity", () => {
      tracker.recordPollResult("o/r", false);
      expect(tracker.getStateForTests("o/r")).toBe("quiet");
      expect(tracker.getIntervalFor("o/r")).toBe(60_000);
    });

    it("does not transition from quiet to active when hasActivity is false", () => {
      tracker.recordPollResult("o/r", true);
      expect(tracker.getStateForTests("o/r")).toBe("active");

      tracker.recordPollResult("o/r", false);
      expect(tracker.getStateForTests("o/r")).toBe("active");
      expect(tracker.getIntervalFor("o/r")).toBe(15_000);
    });

    it("does not change state for an existing quiet repo with no activity", () => {
      tracker.recordPollResult("o/r", false);
      expect(tracker.getStateForTests("o/r")).toBe("quiet");

      tracker.recordPollResult("o/r", false);
      expect(tracker.getStateForTests("o/r")).toBe("quiet");
      expect(tracker.getIntervalFor("o/r")).toBe(60_000);
    });

    it("transitions from quiet to active when hasActivity becomes true", () => {
      tracker.recordPollResult("o/r", false);
      tracker.recordPollResult("o/r", true);
      expect(tracker.getStateForTests("o/r")).toBe("active");
    });
  });

  describe("recordWebhook", () => {
    it("sets state to active and records lastWebhookAt", () => {
      tracker.recordWebhook("o/r");
      expect(tracker.getStateForTests("o/r")).toBe("active");
    });

    it("resets stalled repo to active", () => {
      tracker.recordPollResult("o/r", false);
      vi.advanceTimersByTime(310_000);
      expect(tracker.getIntervalFor("o/r")).toBe(30_000);
      expect(tracker.getStateForTests("o/r")).toBe("stalled");

      tracker.recordWebhook("o/r");
      expect(tracker.getStateForTests("o/r")).toBe("active");
      expect(tracker.getIntervalFor("o/r")).toBe(15_000);
    });

    it("updates lastWebhookAt on recordWebhook", () => {
      tracker.recordPollResult("o/r", true);
      vi.advanceTimersByTime(10_000);
      tracker.recordWebhook("o/r");
      expect(tracker.getIntervalFor("o/r")).toBe(15_000);
    });
  });

  describe("stalled state transitions", () => {
    it("enters stalled after staleThresholdMs without webhook activity", () => {
      tracker.recordPollResult("o/r", false);
      expect(tracker.getStateForTests("o/r")).toBe("quiet");

      vi.advanceTimersByTime(310_000);
      expect(tracker.getIntervalFor("o/r")).toBe(30_000);
      expect(tracker.getStateForTests("o/r")).toBe("stalled");
    });

    it("returns aggressive interval when stalled", () => {
      tracker.recordPollResult("o/r", false);
      vi.advanceTimersByTime(310_000);
      expect(tracker.getIntervalFor("o/r")).toBe(30_000);
    });

    it("exit stalled on next active poll result", () => {
      tracker.recordPollResult("o/r", false);
      vi.advanceTimersByTime(310_000);
      tracker.getIntervalFor("o/r");

      tracker.recordPollResult("o/r", true);
      expect(tracker.getStateForTests("o/r")).toBe("active");
      expect(tracker.getIntervalFor("o/r")).toBe(15_000);
    });
  });

  describe("active timeout", () => {
    it("falls back to quiet after activeTimeoutMs without new activity", () => {
      tracker.recordPollResult("o/r", true);
      expect(tracker.getStateForTests("o/r")).toBe("active");

      vi.advanceTimersByTime(130_000);
      expect(tracker.getIntervalFor("o/r")).toBe(60_000);
      expect(tracker.getStateForTests("o/r")).toBe("quiet");
    });
  });
});
