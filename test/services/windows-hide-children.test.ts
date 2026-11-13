import { describe, it, expect } from "vitest";
import { promisify } from "node:util";
import {
  withWindowsHide,
  installWindowsHideDefault,
} from "../../src/services/windows-hide-children.js";

describe("withWindowsHide", () => {
  it("adds options after the args array", () => {
    expect(withWindowsHide(["git", ["status"]])).toEqual([
      "git",
      ["status"],
      { windowsHide: true },
    ]);
  });

  it("inserts options before a trailing callback", () => {
    const cb = () => {};
    expect(withWindowsHide(["git", ["status"], cb])).toEqual([
      "git",
      ["status"],
      { windowsHide: true },
      cb,
    ]);
    expect(withWindowsHide(["dir", cb])).toEqual(["dir", { windowsHide: true }, cb]);
  });

  it("defaults windowsHide into an existing options object without mutating it", () => {
    const opts = { cwd: "x" };
    const out = withWindowsHide(["git", [], opts]);
    expect(out[2]).toEqual({ cwd: "x", windowsHide: true });
    expect(opts).toEqual({ cwd: "x" });
  });

  it("respects a caller's explicit windowsHide", () => {
    expect(withWindowsHide(["git", [], { windowsHide: false }])[2]).toEqual({ windowsHide: false });
  });

  it("handles a bare command", () => {
    expect(withWindowsHide(["whoami"])).toEqual(["whoami", { windowsHide: true }]);
  });

  it("replaces an explicit undefined/null options slot instead of shifting the callback", () => {
    const cb = () => {};
    expect(withWindowsHide(["git", ["s"], undefined, cb])).toEqual([
      "git",
      ["s"],
      { windowsHide: true },
      cb,
    ]);
    expect(withWindowsHide(["git", ["s"], null])).toEqual(["git", ["s"], { windowsHide: true }]);
    expect(withWindowsHide(["git", undefined])).toEqual(["git", { windowsHide: true }]);
    expect(withWindowsHide(["git", null, cb])).toEqual(["git", { windowsHide: true }, cb]);
  });
});

/** A stand-in for `node:child_process` that records the options it receives,
 * shaped like the real one: `execFile` has a promisify.custom that closes over
 * the ORIGINAL, as Node's does. */
function fakeChildProcess() {
  const seen: { name: string; options: unknown }[] = [];
  const record = (name: string) =>
    function (...args: unknown[]) {
      const options = args.find((a, i) => i > 0 && typeof a === "object" && !Array.isArray(a));
      seen.push({ name, options });
      const cb = args.find((a) => typeof a === "function") as
        ((e: unknown, so: string, se: string) => void) | undefined;
      cb?.(null, "out", "err");
      return { pid: 1 };
    };
  const execFile = record("execFile");
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) => {
      const p = new Promise((resolve) => {
        (execFile as (...a: unknown[]) => unknown)(...args, (_e: unknown, stdout: string) =>
          resolve({ stdout, stderr: "" }),
        );
      });
      return p;
    },
  });
  return {
    seen,
    cp: {
      spawn: record("spawn"),
      spawnSync: record("spawnSync"),
      execFile,
      execFileSync: record("execFileSync"),
      exec: record("exec"),
      execSync: record("execSync"),
    },
  };
}

describe("installWindowsHideDefault", () => {
  it("is a no-op off Windows", () => {
    const { cp, seen } = fakeChildProcess();
    expect(installWindowsHideDefault("linux", cp)).toBe(false);
    cp.spawn("tool", ["status"]);
    expect(seen[0].options).toBeUndefined();
  });

  it("defaults windowsHide for every method, once per target", () => {
    const { cp, seen } = fakeChildProcess();
    expect(installWindowsHideDefault("win32", cp)).toBe(true);
    expect(installWindowsHideDefault("win32", cp)).toBe(false);
    cp.spawn("tool", ["status"]);
    cp.spawnSync("tool", ["status"], { cwd: "x" });
    cp.execFileSync("tool", ["status"]);
    cp.exec("dir", () => {});
    cp.execSync("dir");
    for (const call of seen) expect(call.options).toMatchObject({ windowsHide: true });
    expect(seen).toHaveLength(5);
  });

  it("applies the default through promisify(execFile), including a capture made after install", async () => {
    const { cp, seen } = fakeChildProcess();
    installWindowsHideDefault("win32", cp);
    const run = promisify(cp.execFile) as (
      f: string,
      a: string[],
    ) => Promise<{ stdout: string; stderr: string }> & { child?: unknown };
    const promise = run("icacls", ["x"]);
    await expect(promise).resolves.toMatchObject({ stdout: "out" });
    expect(promise.child).toBeDefined();
    expect(seen.at(-1)).toMatchObject({ name: "execFile", options: { windowsHide: true } });
  });

  it("rejects the promisified call with stdout/stderr attached", async () => {
    const { cp } = fakeChildProcess();
    (cp as unknown as Record<string, unknown>).execFile = Object.assign(
      (...args: unknown[]) => {
        const cb = args.find((a) => typeof a === "function") as (
          e: unknown,
          so: string,
          se: string,
        ) => void;
        cb(new Error("boom"), "o", "e");
      },
      { [promisify.custom]: () => Promise.resolve({}) },
    );
    installWindowsHideDefault("win32", cp);
    const run = promisify(cp.execFile) as (...a: unknown[]) => Promise<unknown>;
    await expect(run("x", [])).rejects.toMatchObject({
      message: "boom",
      stdout: "o",
      stderr: "e",
    });
  });
});
