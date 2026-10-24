import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * `runLoginShell` is the helper every agent probe goes through
 * (`agent-detect.ts` finds the CLIs with it; the mcode adapter reads mcode's
 * own version with it). It has to be safe to call from a test that stands in
 * for `spawn`, and safe when its deadline fires.
 */

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runLoginShell } from "../../src/services/login-shell.js";

describe("runLoginShell", () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("resolves the script's stdout", async () => {
    const handlers: Record<string, () => void> = {};
    const stdoutHandlers: Record<string, (chunk: Buffer) => void> = {};
    spawnMock.mockImplementation(() => ({
      stdout: {
        on: (event: string, fn: (chunk: Buffer) => void) => {
          stdoutHandlers[event] = fn;
        },
        off: vi.fn(),
      },
      on: (event: string, fn: () => void) => {
        handlers[event] = fn;
      },
      kill: vi.fn(),
      exitCode: 0,
      signalCode: null,
    }));

    const promise = runLoginShell("echo hello");
    stdoutHandlers.data?.(Buffer.from("hello\n"));
    handlers.close?.();

    expect(await promise).toBe("hello");
  });

  it("resolves null when the shell cannot be launched", async () => {
    spawnMock.mockImplementation(() => ({
      stdout: { on: vi.fn(), off: vi.fn() },
      on: (event: string, fn: () => void) => {
        if (event === "error") fn();
      },
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
    }));

    expect(await runLoginShell("mcode --version")).toBeNull();
  });

  // The regression this pins: on the deadline, the probe kills the child. A
  // stand-in for `spawn` may have no `kill` at all — and an unguarded
  // `child.kill()` inside a TIMER callback throws an UNHANDLED exception,
  // which is fatal to the whole process, not just to the probe. That is
  // exactly what happened when `test/plugins/hooks.test.ts` replaced
  // `node:child_process`'s `spawn` with a stand-in: the full suite reported
  // "TypeError: child.kill is not a function" as an uncaught exception.
  it("resolves null on the deadline without throwing, even for a child with no kill()", async () => {
    vi.useFakeTimers();
    spawnMock.mockImplementation(() => ({
      stdout: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      // No `kill` at all — the shape a test double takes.
      exitCode: null,
      signalCode: null,
    }));

    const promise = runLoginShell("mcode --version");
    const assertion = expect(promise).resolves.toBeNull();

    // Past the probe's 5s deadline AND its 2s SIGKILL escalation.
    await vi.advanceTimersByTimeAsync(8_000);

    await assertion;
  });
});
