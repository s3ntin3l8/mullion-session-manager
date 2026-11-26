import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

let stdoutToEmit: string | null;
let spawnError: Error | null = null;
// Set when the fake child is meant to look like one that really started.
// Node leaves `pid` undefined when the spawn itself failed and sets it once
// the child is running, and the resolver tells those two apart.
let childPid: number | undefined;
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
        pid?: number;
      };
      child.stdout = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn();
      if (childPid !== undefined) child.pid = childPid;
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
  getSessionEnvInfo,
  getSessionPathEntries,
  getUserShellEnv,
  getUserShellPath,
  getUserShellRecoverKeys,
  parseRecoverKeys,
  parseUserShellKeys,
  setUserShellRecoverKeys,
  invalidateUserShellEnv,
  mergePaths,
  parseUserShellPath,
  resetUserShellEnvForTests,
  resolveUserShellEnv,
  setUserShellEnvLogger,
  setUserShellResolveTimeoutMs,
  retryDelayMs,
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
    expect(mergePaths("/usr/bin:/bin", "/home/u/.mcode/bin:/usr/bin", ":")).toBe(
      "/home/u/.mcode/bin:/usr/bin:/bin",
    );
  });

  it("handles an unset base", () => {
    expect(mergePaths(undefined, "/a:/b", ":")).toBe("/a:/b");
  });

  // A Windows PATH is `;`-separated and every entry carries a `C:` drive, so
  // splitting on `:` shredded it into "C", "\\Users\\…;C", ….
  it("splits a Windows PATH on its own delimiter", () => {
    expect(mergePaths("C:\\Windows;C:\\Git\\cmd", "C:\\Tools;C:\\Windows", ";")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git\\cmd",
    );
  });
});

describe("resolveUserShellEnv", () => {
  const savedShell = process.env.SHELL;
  const savedOptOut = process.env.MULLION_RESOLVE_INTERACTIVE_ENV;

  beforeEach(() => {
    spawned = [];
    spawnError = null;
    childPid = undefined;
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
    // CI is ubuntu-only: pin the script so the macOS-portable form can't regress
    // (macOS's /usr/bin/env has no -0).
    expect(spawned[0].args[1]).toContain('"$PATH"');
    expect(spawned[0].args[1]).not.toMatch(/\benv\b/);
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
    const logger = { debug: vi.fn(), warn: vi.fn() };
    setUserShellEnvLogger(logger);
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(2);
    expect(getUserShellPath()).toBe("/home/u/.minimax-code/bin:/usr/bin");
    expect(logger.warn).toHaveBeenCalledWith(
      { shell: "/usr/bin/zsh" },
      expect.stringContaining("keeping the previous PATH"),
    );
  });

  it("logs why it fell back: unparseable output, spawn error, unsupported shell", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    setUserShellEnvLogger(logger);

    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(logger.warn).toHaveBeenCalledWith(
      { shell: "/usr/bin/zsh" },
      expect.stringContaining("using the service environment's PATH"),
    );

    resetUserShellEnvForTests();
    logger.warn.mockClear();
    spawnError = new Error("ENOENT");
    await resolveUserShellEnv();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: spawnError }),
      expect.stringContaining("failed to spawn"),
    );
    // a spawn error is reported once, not again as "no PATH"
    expect(logger.warn).toHaveBeenCalledTimes(1);

    resetUserShellEnvForTests();
    process.env.SHELL = "/usr/bin/fish";
    await resolveUserShellEnv();
    expect(logger.debug).toHaveBeenCalledWith(
      { shell: "/usr/bin/fish" },
      expect.stringContaining("unsupported shell"),
    );
  });

  // Issue #1728 — on Windows there is no rc-file PATH to recover, and a
  // $SHELL inherited from Git Bash is an MSYS path Windows cannot spawn.
  it("does not resolve on Windows, even with a bash-looking $SHELL", async () => {
    const original = process.platform;
    const savedPath = process.env.PATH;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      process.env.SHELL = "/usr/bin/bash";
      await resolveUserShellEnv();
      expect(spawned).toEqual([]);
      expect(getUserShellPath()).toBeNull();
      // By design, not a fallback: the host panel must not warn about it.
      expect(getSessionEnvInfo()).toMatchObject({
        interactiveResolve: "not-applicable",
        reason: null,
      });
      process.env.PATH = "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd";
      expect(getSessionPathEntries(";")).toEqual([
        "C:\\Windows\\system32",
        "C:\\Program Files\\Git\\cmd",
      ]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  // A child can also fail AFTER it started — a SIGTERM the shell refuses
  // produces an 'error' event too. Calling that a spawn failure would be
  // wrong, so the resolver distinguishes the two.
  it("does not call a post-start failure a spawn failure", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    setUserShellEnvLogger(logger);

    childPid = 4242; // the child really started
    spawnError = new Error("kill EPERM");
    await resolveUserShellEnv();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: spawnError }),
      expect.stringContaining("the interactive shell failed"),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("failed to spawn"),
    );
  });

  it("falls back to null on unparseable output", async () => {
    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(getUserShellPath()).toBeNull();
  });

  it("times out to null when the shell never answers", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    setUserShellEnvLogger(logger);
    try {
      stdoutToEmit = null;
      const p = resolveUserShellEnv();
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(getUserShellPath()).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { shell: "/usr/bin/zsh", timeoutMs: 10_000 },
        expect.stringContaining("timed out"),
      );
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

  it("reports the resolver's status and why it fell back (#3156)", async () => {
    expect(getSessionEnvInfo()).toMatchObject({
      interactiveResolve: "fallback",
      reason: "pending",
    });
    await resolveUserShellEnv();
    expect(getSessionEnvInfo()).toMatchObject({
      shell: "/usr/bin/zsh",
      interactiveResolve: "ok",
      reason: null,
      recoveredKeys: [],
    });
    expect(getSessionEnvInfo().path).toContain("/home/u/.minimax-code/bin");

    resetUserShellEnvForTests();
    stdoutToEmit = "garbage";
    await resolveUserShellEnv();
    expect(getSessionEnvInfo()).toMatchObject({
      interactiveResolve: "fallback",
      reason: "unparseable",
    });

    resetUserShellEnvForTests();
    stdoutToEmit = null;
    spawnError = new Error("ENOENT");
    await resolveUserShellEnv();
    expect(getSessionEnvInfo()).toMatchObject({ reason: "spawn-failed" });
  });

  it("reports a timeout as the fallback reason (#3156)", async () => {
    vi.useFakeTimers();
    try {
      stdoutToEmit = null;
      const p = resolveUserShellEnv();
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(getSessionEnvInfo()).toMatchObject({
        interactiveResolve: "fallback",
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Issue #3524 — a transient failure used to be final, so one slow boot left
// an agent on the service PATH for its whole lifetime.
describe("resolveUserShellEnv retries a transient failure (#3524)", () => {
  const savedShell = process.env.SHELL;

  beforeEach(() => {
    spawned = [];
    spawnError = null;
    childPid = undefined;
    process.env.SHELL = "/usr/bin/zsh";
    resetUserShellEnvForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.SHELL = savedShell;
    resetUserShellEnvForTests();
  });

  async function timedOutResolve(): Promise<void> {
    stdoutToEmit = null;
    const p = resolveUserShellEnv();
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
  }

  it("backs off 1 min doubling to 15 min", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ]);
  });

  it("recovers the PATH on a later call once the backoff has passed", async () => {
    await timedOutResolve();
    const info = getSessionEnvInfo();
    expect(info).toMatchObject({ interactiveResolve: "fallback", reason: "timeout" });
    expect(info.retryAt).toBe(Date.now() + 60_000);

    // Inside the backoff: no new shell.
    stdoutToEmit = dump("/home/u/.nvm/bin:/usr/bin");
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(1);

    vi.setSystemTime(Date.now() + 60_000);
    const p = resolveUserShellEnv();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(spawned).toHaveLength(2);
    expect(getUserShellPath()).toBe("/home/u/.nvm/bin:/usr/bin");
    expect(getSessionEnvInfo()).toMatchObject({
      interactiveResolve: "ok",
      reason: null,
      retryAt: null,
    });

    // A success is final again.
    vi.setSystemTime(Date.now() + 3_600_000);
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(2);
  });

  it("doubles the backoff on repeated failures, and a rescan bypasses it", async () => {
    await timedOutResolve();
    vi.setSystemTime(Date.now() + 60_000);
    await timedOutResolve();
    expect(spawned).toHaveLength(2);
    expect(getSessionEnvInfo().retryAt).toBe(Date.now() + 120_000);

    invalidateUserShellEnv();
    stdoutToEmit = dump("/opt/x/bin");
    const p = resolveUserShellEnv();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(spawned).toHaveLength(3);
    expect(getUserShellPath()).toBe("/opt/x/bin");
  });

  it("keeps an unsupported shell final, with no retry scheduled", async () => {
    process.env.SHELL = "/usr/bin/fish";
    await resolveUserShellEnv();
    vi.setSystemTime(Date.now() + 3_600_000);
    process.env.SHELL = "/usr/bin/zsh";
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(0);
    expect(getSessionEnvInfo()).toMatchObject({ reason: "unsupported-shell", retryAt: null });
  });

  it("honours a configured timeout, and ignores a nonsensical one", async () => {
    setUserShellResolveTimeoutMs(3_000);
    stdoutToEmit = null;
    const p = resolveUserShellEnv();
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(getSessionEnvInfo().reason).toBe("timeout");

    resetUserShellEnvForTests();
    setUserShellResolveTimeoutMs(0);
    stdoutToEmit = null;
    const q = resolveUserShellEnv();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getSessionEnvInfo().reason).toBe("pending");
    await vi.advanceTimersByTimeAsync(7_000);
    await q;
    expect(getSessionEnvInfo().reason).toBe("timeout");
  });
});

const KO = "__MULLION_USER_KEY_8f3a1c__";
const KC = "__MULLION_USER_KEY_END_8f3a1c__";
const rec = (k: string, v: string) => `${KO}${k}=${v}${KC}`;

describe("recovered keys", () => {
  it("parseRecoverKeys trims, dedupes and drops non-identifiers and PATH", () => {
    expect(parseRecoverKeys(" A , B,A,,C-D,$(x),PATH,1X")).toEqual(["A", "B"]);
    expect(parseRecoverKeys("")).toEqual([]);
    expect(parseRecoverKeys(undefined)).toEqual([]);
  });

  it("parseUserShellKeys reads only allowlisted, non-empty records", () => {
    const out = `banner\n${rec("ANDROID_HOME", "/sdk")}${rec("JAVA_HOME", "")}${rec("SECRET", "x")}${rec("MULTI", "a\nb=c")}`;
    expect(parseUserShellKeys(out, ["ANDROID_HOME", "JAVA_HOME", "MULTI"])).toEqual({
      ANDROID_HOME: "/sdk",
      MULTI: "a\nb=c",
    });
  });
});

describe("recovery through the interactive shell", () => {
  const savedShell = process.env.SHELL;
  beforeEach(() => {
    spawned = [];
    spawnError = null;
    childPid = undefined;
    process.env.SHELL = "/usr/bin/zsh";
    delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    resetUserShellEnvForTests();
    setUserShellRecoverKeys(["ANDROID_HOME", "JAVA_HOME"]);
    stdoutToEmit = dump("/a:/b") + rec("ANDROID_HOME", "/sdk") + rec("JAVA_HOME", "/jdk");
  });
  afterEach(() => {
    process.env.SHELL = savedShell;
    resetUserShellEnvForTests();
    setUserShellEnvLogger(undefined);
  });

  it("shares one spawn, prints only the allowlisted names, logs names not values", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };
    setUserShellEnvLogger(logger);
    await resolveUserShellEnv();
    expect(spawned).toHaveLength(1);
    const script = spawned[0].args[1];
    expect(script).toContain("printenv ANDROID_HOME");
    expect(script).toContain("printenv JAVA_HOME");
    expect(script).not.toContain("printenv ANDROID_NDK_HOME");
    expect(getUserShellRecoverKeys()).toEqual(["ANDROID_HOME", "JAVA_HOME"]);
    expect(getUserShellEnv(["ANDROID_HOME", "JAVA_HOME", "OTHER"])).toEqual({
      ANDROID_HOME: "/sdk",
      JAVA_HOME: "/jdk",
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.info.mock.calls[0]);
    expect(logged).toContain("ANDROID_HOME");
    expect(logged).not.toContain("/sdk");
  });

  it("recovers nothing when the config is empty", async () => {
    setUserShellRecoverKeys([]);
    stdoutToEmit = dump("/a");
    await resolveUserShellEnv();
    expect(spawned[0].args[1]).not.toContain("printenv");
    expect(getUserShellEnv(["ANDROID_HOME"])).toEqual({});
  });

  it("reports recovered key names (never values) in the session-env info", async () => {
    await resolveUserShellEnv();
    const info = getSessionEnvInfo();
    expect(info.recoveredKeys).toEqual(["ANDROID_HOME", "JAVA_HOME"]);
    expect(JSON.stringify(info)).not.toContain("/sdk");
  });

  it("recovers nothing when the shell times out", async () => {
    vi.useFakeTimers();
    try {
      stdoutToEmit = null;
      const p = resolveUserShellEnv();
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(getUserShellEnv(["ANDROID_HOME"])).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers nothing on unsupported shell/spawn error/opt-out", async () => {
    process.env.SHELL = "/usr/bin/fish";
    await resolveUserShellEnv();
    expect(getUserShellEnv(["ANDROID_HOME"])).toEqual({});
    resetUserShellEnvForTests();
    setUserShellRecoverKeys(["ANDROID_HOME"]);
    process.env.SHELL = "/usr/bin/zsh";
    spawnError = new Error("boom");
    await resolveUserShellEnv();
    expect(getUserShellEnv(["ANDROID_HOME"])).toEqual({});
    resetUserShellEnvForTests();
    setUserShellRecoverKeys(["ANDROID_HOME"]);
    spawnError = null;
    await resolveUserShellEnv();
    process.env.MULLION_RESOLVE_INTERACTIVE_ENV = "0";
    expect(getUserShellEnv(["ANDROID_HOME"])).toEqual({});
    delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
  });
});
