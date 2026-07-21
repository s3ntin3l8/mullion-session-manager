import { describe, it, expect, vi } from "vitest";
import {
  registerTerminalRepaint,
  unregisterTerminalRepaint,
  repaintAllTerminals,
} from "./terminalRepaintRegistry.js";

describe("terminalRepaintRegistry", () => {
  it("calls repaint for every registered session", () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);

    repaintAllTerminals();

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).toHaveBeenCalledTimes(1);

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
  });

  it("skips the excepted session id — the newly-added panel has nothing to heal yet", () => {
    const repaintA = vi.fn();
    const repaintB = vi.fn();
    registerTerminalRepaint(1, repaintA);
    registerTerminalRepaint(2, repaintB);

    repaintAllTerminals(2);

    expect(repaintA).toHaveBeenCalledTimes(1);
    expect(repaintB).not.toHaveBeenCalled();

    unregisterTerminalRepaint(1);
    unregisterTerminalRepaint(2);
  });

  it("does not call repaint after a session unregisters (unmount)", () => {
    const repaint = vi.fn();
    registerTerminalRepaint(3, repaint);
    unregisterTerminalRepaint(3);

    repaintAllTerminals();

    expect(repaint).not.toHaveBeenCalled();
  });
});
