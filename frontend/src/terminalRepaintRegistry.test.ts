// @vitest-environment jsdom
//
// jsdom (not the default "node" environment — see vitest.config.ts's own
// comment) because repaintAllTerminals now coalesces via
// requestAnimationFrame, which plain Node has no global for at all (verified
// against this repo's own Node 26 runtime).
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerTerminalRepaint,
  unregisterTerminalRepaint,
  repaintAllTerminals,
} from "./terminalRepaintRegistry.js";

/** Awaits the next animation frame — the coalesced sweep runs inside one, so
 * every test needs to yield to it before asserting on repaint call counts. */
function flushRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("terminalRepaintRegistry", () => {
  // Registrations aren't cleared automatically between tests (module-level
  // Map) — each test below already unregisters what it registers, but start
  // from a clean slate defensively in case an earlier test in the file fails
  // before reaching its own cleanup.
  beforeEach(() => {
    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
    unregisterTerminalRepaint(3);
  });

  it("calls repaint for every registered session", async () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);

    repaintAllTerminals();
    await flushRaf();

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).toHaveBeenCalledTimes(1);

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
  });

  it("skips the excepted session id when it's the only call in the frame — the newly-added panel has nothing to heal yet", async () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);

    repaintAllTerminals(2);
    await flushRaf();

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).not.toHaveBeenCalled();

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
  });

  it("does not call repaint after a session unregisters (unmount)", async () => {
    const repaint = vi.fn();
    registerTerminalRepaint(3, repaint);
    unregisterTerminalRepaint(3);

    repaintAllTerminals();
    await flushRaf();

    expect(repaint).not.toHaveBeenCalled();
  });

  // P5 regression test — the coalescing bug this guards against: naively
  // unioning every coalesced call's exceptSessionId would, for a 3-pane
  // workspace restore where each pane calls repaintAllTerminals(ownId) in
  // the same frame, skip A when repainting (from A's own call), skip B
  // (from B's), skip C (from C's) — i.e. skip all three and heal nothing.
  // Registering exactly two sessions and having each except the OTHER one
  // (the shape a real mount/mount pair produces — each new terminal excepts
  // only itself, so it's actually the sibling that gets excepted here)
  // reproduces the same failure mode with the minimum registry size: a
  // wrong "except the union" implementation would call neither repaint.
  it("still repaints every registered terminal when multiple calls with different exceptSessionIds coalesce into the same frame", async () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);

    // Two independent callers land in the same coalescing window, each
    // excepting a different session — exactly what two terminals mounting
    // back-to-back during a workspace restore produce.
    repaintAllTerminals(1);
    repaintAllTerminals(2);
    await flushRaf();

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).toHaveBeenCalledTimes(1);

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
  });

  it("collapses many calls within the same frame into exactly one sweep per terminal — the O(N²) case", async () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    const repaintC = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);
    registerTerminalRepaint(3, repaintC);

    // Simulates a 3-pane restore: each mount schedules its own call in the
    // same synchronous burst, the way TerminalPane's mount effect and
    // App.tsx's onDidAddPanel handler both do.
    repaintAllTerminals(1);
    repaintAllTerminals(2);
    repaintAllTerminals(3);
    await flushRaf();

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).toHaveBeenCalledTimes(1);
    expect(repaintC).toHaveBeenCalledTimes(1);

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
    unregisterTerminalRepaint(3);
  });
});
