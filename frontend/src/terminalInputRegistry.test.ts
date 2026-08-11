import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerTerminalInput,
  unregisterTerminalInput,
  getTerminalInputHandle,
} from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";

describe("terminalInputRegistry", () => {
  // Module-level Map, not cleared automatically between tests — each test
  // below already unregisters what it registers, but start from a clean
  // slate defensively in case an earlier test in the file fails before
  // reaching its own cleanup (same pattern as terminalRepaintRegistry.test.ts).
  beforeEach(() => {
    unregisterTerminalInput(1);
    unregisterTerminalInput(2);
  });

  it("returns undefined for a session that was never registered", () => {
    expect(getTerminalInputHandle(999)).toBeUndefined();
  });

  it("returns the exact handle a session registered", () => {
    const handle: TerminalInputHandle = {
      sendInput: vi.fn(),
      sendArrow: vi.fn(),
    };
    registerTerminalInput(1, handle);

    expect(getTerminalInputHandle(1)).toBe(handle);

    unregisterTerminalInput(1);
  });

  it("keeps handles for different sessions independent", () => {
    const handleA: TerminalInputHandle = { sendInput: vi.fn(), sendArrow: vi.fn() };
    const handleB: TerminalInputHandle = { sendInput: vi.fn(), sendArrow: vi.fn() };
    registerTerminalInput(1, handleA);
    registerTerminalInput(2, handleB);

    getTerminalInputHandle(1)?.sendInput("\x1b");

    expect(handleA.sendInput).toHaveBeenCalledWith("\x1b");
    expect(handleB.sendInput).not.toHaveBeenCalled();

    unregisterTerminalInput(1);
    unregisterTerminalInput(2);
  });

  it("no longer resolves a session once unregistered", () => {
    registerTerminalInput(1, { sendInput: vi.fn(), sendArrow: vi.fn() });
    unregisterTerminalInput(1);

    expect(getTerminalInputHandle(1)).toBeUndefined();
  });

  it("a later registration for the same session replaces the earlier one", () => {
    const first: TerminalInputHandle = { sendInput: vi.fn(), sendArrow: vi.fn() };
    const second: TerminalInputHandle = { sendInput: vi.fn(), sendArrow: vi.fn() };
    registerTerminalInput(1, first);
    registerTerminalInput(1, second);

    expect(getTerminalInputHandle(1)).toBe(second);

    unregisterTerminalInput(1);
  });
});
