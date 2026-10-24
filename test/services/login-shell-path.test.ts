import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";
import type * as UserShellEnv from "../../src/services/user-shell-env.js";

/**
 * The interactive-rc PATH (user-shell-env.ts) only reaches the agent probes —
 * and the mcode adapter's version read — through the env `runLoginShell` hands
 * to `spawn`, i.e. `buildSessionEnv()`. Nothing else pins that link: swapping
 * it for `process.env` leaves every other suite green while detection
 * silently stops seeing PATH entries that only ~/.zshrc adds.
 */

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

let userPath: string | null = null;
vi.mock("../../src/services/user-shell-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof UserShellEnv>();
  return { ...actual, getUserShellPath: () => userPath };
});

import { runLoginShell } from "../../src/services/login-shell.js";

describe("runLoginShell env", () => {
  const savedPath = process.env.PATH;

  afterEach(() => {
    // `process.env.PATH = undefined` would store the string "undefined".
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    userPath = null;
    spawnMock.mockReset();
  });

  async function spawnedEnv(): Promise<NodeJS.ProcessEnv> {
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
    const promise = runLoginShell("command -v mcode");
    handlers.close?.();
    await promise;
    return (spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }).env;
  }

  it("hands the probe the resolved interactive PATH, in front of the service PATH", async () => {
    process.env.PATH = "/usr/bin:/bin";
    userPath = "/home/u/.minimax-code/bin:/usr/bin";
    expect((await spawnedEnv()).PATH).toBe("/home/u/.minimax-code/bin:/usr/bin:/bin");
  });

  it("leaves the service PATH alone when nothing was resolved", async () => {
    process.env.PATH = "/usr/bin:/bin";
    expect((await spawnedEnv()).PATH).toBe("/usr/bin:/bin");
  });
});
