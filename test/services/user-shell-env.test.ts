import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

let stdoutToEmit: string | null;
let spawnError: Error | null = null;
let spawned: Array<{ shell: string; args: string[]; opts: { stdio?: unknown } }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((shell: string, args: string[], opts: { stdio?: unknown }) => {
      spawned.push({ shell, args, opts });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        exitCode: number | null;
        signalCode: string | null;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      if (spawnError) {
        const err = spawnError;
        setImmediate(() => child.emit("error", err));
      } else if (stdoutToEmit !== null) {
        const out = stdoutToEmit;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(out));
          child.emit("close", 0);
        });
      }
      return child;
    }),
  };
});

import {
  getUserShellPath,
  invalidateUserShellEnv,
  mergePaths,
  parseUserShellPath,
  resetUserShellEnvForTests,
  resolveUserShellEnv,
  setUserShellEnvLogger,
} from "../../src/services/user-shell-env.js";

const S = "__MULLION_USER_ENV_8f3a1c__";
const dump = (path: string) => `${S}${path}${S}`;

describe("parseUserShellPath", () => {
  it("ignores rc-file noise before and after the sentinels", () => {
    expect(parseUserShellPath(`Welcome!\n${dump("/a:/b")}\ntrailing banner`)).toBe("/a:/b");
  });

  it("returns null without both sentinels or with an empty PATH", () => {
    expect(parseUserShellPath("/a")).toBeNull();
    expect(parseUserShellPath(`${S}/a`)).toBeNull();
    expect(parseUserShellPath(dump(""))).toBeNull();
  });
});

describe("mergePaths", () => {
  it("prepends missing entries, keeps base order, drops duplicates", () => {
    expect(mergePaths("/usr/bin:/bin", "/home/u/.mcode/bin:/usr/bin")).toBe(
      "/home/u/.mcode/bin:/usr/bin:/bin",
    );
  });

  it("handles an unset base", () => {
    expect(mergePaths(undefined, "/a:/b")).toBe("/a:/b");
  });
});

describe("resolveUserShellEnv", () => {
  const savedShell = process.env.SHELL;
  const savedOptOut = process.env.MULLION_RESOLVE_INTERACTIVE_ENV;

  beforeEach(() => {
    spawned = [];
    spawnError = null;
    stdoutToEmit = dump("/home/u/.minimax-code/bin:/usr/bin");
    process.env.SHELL = "/usr/bin/zsh";
    delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    resetUserShellEnvForTests();
  });

  afterEach(() => {
    process.env.SHELL = savedShell;
    if (savedOptOut === undefined) delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    else process.env.MULLION_RESOLVE_INTERACTIVE_ENV = savedOptOut;
    resetUserShellEnvForTests();
    setUserShellEnvLogger(undefined);
  });

  it("runs one interactive shell for concurrent callers and caches the PATH", async () => {
    await Promise.all([resolveUserShellEnv(), resolveUserShellEnv()]);
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args[0]).toBe("-ilc");
    expect(spawned[0].opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
    expect(getUserShellPath()).toBe("/home/u/.minimax-code/bin:/usr/bin");
  });

  it("re-runs after invalidateUserShellEnv()", async () => {
    await resolveUserShellEnv();
    invalidateUserShellEnv();
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(2);
  });

  it("keeps the previous PATH while a rescan is in flight", async () => {
    await resolveUserShellEnv();
    invalidateUserShellEnv();
    expect(getUserShellPath()).toBe("/home/u/.minimax-code/bin:/usr/bin");
  });

  it("keeps the previous PATH when a rescan fails", async () => {
    await resolveUserShellEnv();
    invalidateUserShellEnv();
    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(2);
    expect(getUserShellPath()).toBe("/home/u/.minimax-code/bin:/usr/bin");
  });

  it("logs why it fell back: unparseable output, spawn error, unsupported shell", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    setUserShellEnvLogger(logger);

    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(logger.warn).toHaveBeenCalledWith(
      { shell: "/usr/bin/zsh" },
      expect.stringContaining("no PATH from the interactive shell"),
    );

    resetUserShellEnvForTests();
    spawnError = new Error("ENOENT");
    await resolveUserShellEnv();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: spawnError }),
      expect.stringContaining("failed to spawn"),
    );

    resetUserShellEnvForTests();
    process.env.SHELL = "/usr/bin/fish";
    await resolveUserShellEnv();
    expect(logger.debug).toHaveBeenCalledWith(
      { shell: "/usr/bin/fish" },
      expect.stringContaining("unsupported shell"),
    );
  });

  it("falls back to null on unparseable output", async () => {
    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(getUserShellPath()).toBeNull();
  });

  it("times out to null when the shell never answers", async () => {
    vi.useFakeTimers();
    try {
      stdoutToEmit = null;
      const p = resolveUserShellEnv();
      await vi.advanceTimersByTimeAsync(5_000);
      await p;
      expect(getUserShellPath()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips unsupported shells and honours the opt-out", async () => {
    process.env.SHELL = "/usr/bin/fish";
    await resolveUserShellEnv();
    invalidateUserShellEnv();
    process.env.SHELL = "/usr/bin/zsh";
    process.env.MULLION_RESOLVE_INTERACTIVE_ENV = "0";
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(0);
    expect(getUserShellPath()).toBeNull();
  });
});
