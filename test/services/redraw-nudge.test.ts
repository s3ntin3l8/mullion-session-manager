import { describe, it, expect, vi } from "vitest";
import {
  RedrawNudge,
  NUDGE_REPAINT_GRACE_MS,
  type RedrawNudgeHost,
} from "../../src/services/redraw-nudge.js";

// This module owns only the generic dip/restore/grace-reset timing and
// cancellation mechanics of the redraw-nudge state machine (Milestone 1's
// Risk 1 — Claude's Ink-based TUI needing a real dimension-changing resize,
// not just dtach's `-r winch`, to reliably repaint on attach). It is
// intentionally tested here against a tiny fake host (a plain size record
// plus a resize spy) rather than a real Session/pty. The SESSION-shaped
// behavior tests — suppression gating scrollback capture and attention,
// coalescing overlapping requestRedraw() cycles, a same-size resize() not
// cancelling a pending nudge, etc. — already live in pty-manager.test.ts
// and are unchanged by this extraction; see this PR's description.

// `resize` is a pure spy — unlike a real pty, it does NOT feed back into
// `size`. That mirrors Session: Session.cols/rows are only ever changed by
// an independent Session.resize() call (a real client resize), never by the
// nudge cycle's own dip/restore telling the pty to resize — those are two
// separate things (see RedrawNudgeHost's docstring on why getSize() is read
// live rather than derived from what was last told to resize()). Tests that
// need to simulate a real resize landing mid-cycle mutate `size` directly.
function makeHost(initial: { cols: number; rows: number }) {
  const size = { ...initial };
  const resize = vi.fn();
  const host: RedrawNudgeHost = {
    resize,
    getSize: () => ({ ...size }),
  };
  return { host, resize, size };
}

describe("RedrawNudge", () => {
  it("trigger() does not resize synchronously — the dip is scheduled 300ms out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      expect(resize).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize).toHaveBeenLastCalledWith(80, 12); // max(4, floor(24 / 2))
    } finally {
      vi.useRealTimers();
    }
  });

  it("dip floors at 4 rows even for a very short terminal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize } = makeHost({ cols: 80, rows: 5 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      await vi.advanceTimersByTimeAsync(300);
      expect(resize).toHaveBeenLastCalledWith(80, 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores to the original size 400ms after the dip", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      await vi.advanceTimersByTimeAsync(300);
      expect(resize).toHaveBeenLastCalledWith(80, 12);

      await vi.advanceTimersByTimeAsync(400);
      expect(resize).toHaveBeenCalledTimes(2);
      expect(resize).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without suppressCapture, suppressingOutput never turns true", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      expect(nudge.suppressingOutput).toBe(false);
      await vi.advanceTimersByTimeAsync(300 + 400);
      expect(nudge.suppressingOutput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with suppressCapture, suppressingOutput is true through dip+restore and clears only after the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger(true);
      expect(nudge.suppressingOutput).toBe(true);

      await vi.advanceTimersByTimeAsync(300); // dip fires
      expect(nudge.suppressingOutput).toBe(true);

      await vi.advanceTimersByTimeAsync(400); // restore fires
      expect(nudge.suppressingOutput).toBe(true);

      await vi.advanceTimersByTimeAsync(NUDGE_REPAINT_GRACE_MS - 1);
      expect(nudge.suppressingOutput).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(nudge.suppressingOutput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restore reads the host's CURRENT size live, not the size captured at trigger() time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize, size } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      await vi.advanceTimersByTimeAsync(300);
      expect(resize).toHaveBeenLastCalledWith(80, 12); // dip fired

      // A real, independent resize lands mid-cycle (mirrors Session.resize()
      // being called by a real client resize while a nudge is in flight).
      size.cols = 100;
      size.rows = 40;
      resize.mockClear();

      await vi.advanceTimersByTimeAsync(400); // restore fires
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize).toHaveBeenLastCalledWith(100, 40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() before the dip fires prevents any resize call at all", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger(true);
      nudge.cancel();

      await vi.advanceTimersByTimeAsync(300 + 400 + NUDGE_REPAINT_GRACE_MS);
      expect(resize).not.toHaveBeenCalled();
      expect(nudge.suppressingOutput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second trigger() before the first cycle's dip supersedes it — only one dip/restore pair fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host, resize } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger();
      await vi.advanceTimersByTimeAsync(100); // before the first cycle's 300ms dip
      nudge.trigger();

      // Second cycle's dip fires 300ms after ITS OWN trigger() call (local t=400).
      await vi.advanceTimersByTimeAsync(300);
      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize).toHaveBeenLastCalledWith(80, 12);

      await vi.advanceTimersByTimeAsync(400);
      expect(resize).toHaveBeenCalledTimes(2);
      expect(resize).toHaveBeenLastCalledWith(80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() while a grace-reset is pending clears suppression immediately, not just the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      nudge.trigger(true);
      await vi.advanceTimersByTimeAsync(300 + 400); // dip + restore fired, grace-reset pending
      expect(nudge.suppressingOutput).toBe(true);

      nudge.cancel();
      expect(nudge.suppressingOutput).toBe(false);

      // The (now-cancelled) grace-reset firing later must not throw or
      // double-clear anything observable.
      await vi.advanceTimersByTimeAsync(NUDGE_REPAINT_GRACE_MS);
      expect(nudge.suppressingOutput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancelled cycle's later grace-reset can't clobber a still-in-flight second cycle's suppression", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { host } = makeHost({ cols: 80, rows: 24 });
      const nudge = new RedrawNudge(host);

      // Cycle 1 (t=0): dip@300, restore@700, grace-reset@1200.
      nudge.trigger(true);
      await vi.advanceTimersByTimeAsync(800); // past cycle 1's restore

      // Cycle 2 starts at t=800 — cancels cycle 1's still-pending grace-reset
      // (would have fired at t=1200), then schedules its own: dip@1100,
      // restore@1500, grace@2000.
      nudge.trigger(true);

      // Advance to cycle 1's ORIGINAL (now-cancelled) grace-reset time,
      // t=1200. Cycle 2's own repaint is legitimately still in flight.
      await vi.advanceTimersByTimeAsync(1200 - 800);
      expect(nudge.suppressingOutput).toBe(true);

      // Advance past cycle 2's OWN grace-reset (t=2000).
      await vi.advanceTimersByTimeAsync(2000 - 1200);
      expect(nudge.suppressingOutput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
