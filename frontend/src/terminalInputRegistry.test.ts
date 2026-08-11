import { describe, it, expect, vi } from "vitest";
import {
  registerTerminalInput,
  unregisterTerminalInput,
  getTerminalInputHandle,
} from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";

function makeHandle(overrides: Partial<TerminalInputHandle> = {}): TerminalInputHandle {
  return {
    sendInput: vi.fn(),
    sendArrow: vi.fn(),
    sendCtrlC: vi.fn(),
    ...overrides,
  };
}

// Each test below uses its own distinct session id(s), never reused across
// tests — a module-level stack (Hermes review, PR #616 round 3) has no
// "force clear regardless of identity" escape hatch by design (see the
// registry's own comment on why unregister requires the exact handle
// reference), so distinct ids sidestep any cross-test leakage risk instead
// of needing defensive cleanup in a beforeEach.
describe("terminalInputRegistry", () => {
  it("returns undefined for a session that was never registered", () => {
    expect(getTerminalInputHandle(999)).toBeUndefined();
  });

  it("returns the exact handle a session registered", () => {
    const handle = makeHandle();
    registerTerminalInput(101, handle);

    expect(getTerminalInputHandle(101)).toBe(handle);

    unregisterTerminalInput(101, handle);
  });

  it("keeps handles for different sessions independent", () => {
    const handleA = makeHandle();
    const handleB = makeHandle();
    registerTerminalInput(102, handleA);
    registerTerminalInput(103, handleB);

    getTerminalInputHandle(102)?.sendInput("\x1b");

    expect(handleA.sendInput).toHaveBeenCalledWith("\x1b");
    expect(handleB.sendInput).not.toHaveBeenCalled();

    unregisterTerminalInput(102, handleA);
    unregisterTerminalInput(103, handleB);
  });

  it("no longer resolves a session once its only registration is unregistered", () => {
    const handle = makeHandle();
    registerTerminalInput(104, handle);
    unregisterTerminalInput(104, handle);

    expect(getTerminalInputHandle(104)).toBeUndefined();
  });

  it("a later registration for the same session takes priority over an earlier one", () => {
    const first = makeHandle();
    const second = makeHandle();
    registerTerminalInput(105, first);
    registerTerminalInput(105, second);

    expect(getTerminalInputHandle(105)).toBe(second);

    unregisterTerminalInput(105, first);
    unregisterTerminalInput(105, second);
  });

  it("exposes sendCtrlC as a distinct method from sendInput", () => {
    const handle = makeHandle();
    registerTerminalInput(106, handle);

    getTerminalInputHandle(106)?.sendCtrlC();

    expect(handle.sendCtrlC).toHaveBeenCalledTimes(1);
    expect(handle.sendInput).not.toHaveBeenCalled();

    unregisterTerminalInput(106, handle);
  });

  // Hermes review, PR #616 round 3 — the actual bug being fixed: Dock.tsx
  // mounts a second TerminalPane for the same sessionId as the session's
  // own main pane. A single-value registry meant the dock monitor's
  // unmount (unregister) deleted the main pane's registration outright,
  // even though the main pane was still alive — leaving the key bar a
  // silent no-op. Identity-guarded stack removal restores it instead.
  describe("same sessionId registered twice (dock monitor + main pane, issue: mobile UI/UX overhaul)", () => {
    it("unregistering the second (dock) registration restores the first (main pane)", () => {
      const main = makeHandle();
      const dock = makeHandle();
      registerTerminalInput(107, main);
      registerTerminalInput(107, dock);
      expect(getTerminalInputHandle(107)).toBe(dock);

      unregisterTerminalInput(107, dock);

      expect(getTerminalInputHandle(107)).toBe(main);

      unregisterTerminalInput(107, main);
    });

    it("unregistering the first (main pane) registration while the second (dock) is still live leaves the dock's handle resolvable", () => {
      const main = makeHandle();
      const dock = makeHandle();
      registerTerminalInput(108, main);
      registerTerminalInput(108, dock);

      unregisterTerminalInput(108, main);

      expect(getTerminalInputHandle(108)).toBe(dock);

      unregisterTerminalInput(108, dock);
    });

    it("resolves to undefined only once both registrations are gone", () => {
      const main = makeHandle();
      const dock = makeHandle();
      registerTerminalInput(109, main);
      registerTerminalInput(109, dock);

      unregisterTerminalInput(109, dock);
      unregisterTerminalInput(109, main);

      expect(getTerminalInputHandle(109)).toBeUndefined();
    });

    it("unregistering a handle that was never registered for that session is a silent no-op", () => {
      const main = makeHandle();
      const stranger = makeHandle();
      registerTerminalInput(110, main);

      unregisterTerminalInput(110, stranger);

      expect(getTerminalInputHandle(110)).toBe(main);

      unregisterTerminalInput(110, main);
    });
  });
});
