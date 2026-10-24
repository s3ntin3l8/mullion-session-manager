import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";

/**
 * `runLoginShell` is the helper every agent probe goes through
 * (`agent-detect.ts` finds the CLIs with it; the mcode adapter reads mcode's
 * own version with it). It has to be safe to call from a test that stands in
 * for `spawn`, and safe when its deadline fires.
 */

const spawnMock = vi.fn();

// The original module is spread through, so anything else in this test's
// module graph that imports from node:child_process still gets the real
// exports — only `spawn` is replaced.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

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

  it("resolves null when the shell printed nothing", async () => {
    const handlers: Record<string, () => void> = {};
    spawnMock.mockImplementation(() => ({
      stdout: { on: vi.fn(), off: vi.fn() },
      on: (event: string, fn: () => void) => {
        handlers[event] = fn;
      },
      kill: vi.fn(),
      exitCode: 0,
      signalCode: null,
    }));

    const promise = runLoginShell("command -v nothing-here");
    handlers.close?.();

    expect(await promise).toBeNull();
  });

  // The deadline path — a kill-less child, an unguarded `child.kill()` inside
  // a timer callback, an UNHANDLED exception — belongs to the shared helper
  // now (issue #1833), so it is tested there:
  // `test/services/shell-spawn.test.ts`.
});
