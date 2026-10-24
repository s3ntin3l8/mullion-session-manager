import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

let stdoutToEmit: string | null;
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
      if (stdoutToEmit !== null) {
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
} from "../../src/services/user-shell-env.js";

const S = "__MULLION_USER_ENV_8f3a1c__";
const dump = (...vars: string[]) => `${S}${vars.join("\0")}\0${S}`;

describe("parseUserShellPath", () => {
  it("ignores rc-file noise before and after the sentinels", () => {
    const out = `Welcome!\n${dump("HOME=/h", "PATH=/a:/b")}\ntrailing banner`;
    expect(parseUserShellPath(out)).toBe("/a:/b");
  });

  it("returns null without both sentinels or without PATH", () => {
    expect(parseUserShellPath("PATH=/a")).toBeNull();
    expect(parseUserShellPath(`${S}PATH=/a\0`)).toBeNull();
    expect(parseUserShellPath(dump("HOME=/h"))).toBeNull();
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
    stdoutToEmit = dump("PATH=/home/u/.minimax-code/bin:/usr/bin");
    process.env.SHELL = "/usr/bin/zsh";
    delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    resetUserShellEnvForTests();
  });

  afterEach(() => {
    process.env.SHELL = savedShell;
    if (savedOptOut === undefined) delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    else process.env.MULLION_RESOLVE_INTERACTIVE_ENV = savedOptOut;
    resetUserShellEnvForTests();
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
