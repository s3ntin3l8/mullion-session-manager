import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";

const script = path.resolve(__dirname, "../../scripts/with-gate-lock.sh");
const hasFlock = spawnSync("flock", ["--version"]).status === 0;

// The script locks inside `git rev-parse --git-common-dir`, so each test runs
// it from a throwaway repo rather than touching this checkout's .git.
let repo: string;
const lockPath = () => path.join(repo, ".git", "prepush-tests.lock");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...gitEnv(), MULLION_NO_GATE_LOCK: "", ...env },
  });
// `flock -n` exits non-zero when someone still holds the lock.
const lockIsHeld = () => spawnSync("flock", ["-n", lockPath(), "true"]).status !== 0;

// Wrappers started by a test run detached (their own session/process group, so
// they get default signal handling like a real hook) and are killed by group in
// afterEach - a plain `.kill()` would only reach the bash wrapper and leave its
// command lingering.
const started: ChildProcess[] = [];
const startWrapper = (args: string[]) => {
  const child = spawn("bash", [script, ...args], { cwd: repo, env: gitEnv(), detached: true });
  started.push(child);
  return child;
};
const childOf = (wrapper: ChildProcess) =>
  Number(
    spawnSync("pgrep", ["-P", String(wrapper.pid)], { encoding: "utf8" }).stdout.split("\n")[0],
  );
const isAlive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gate-lock-"));
  execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
});
afterEach(() => {
  for (const c of started.splice(0)) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!hasFlock)("with-gate-lock.sh", () => {
  it("runs the command and propagates its exit code", () => {
    expect(run(["sh", "-c", "exit 0"]).status).toBe(0);
    expect(run(["sh", "-c", "exit 7"]).status).toBe(7);
  });

  it("releases the lock when the command exits", () => {
    run(["true"]);
    expect(lockIsHeld()).toBe(false);
  });

  it("does not leak the lock fd to orphans the command leaves behind", () => {
    // Regression: the child used to inherit fd 9, so a leaked fixture process
    // (cf. #1798) kept the lock held after the hook returned.
    const res = run(["sh", "-c", "setsid sleep 5 >/dev/null 2>&1 & exit 0"]);
    expect(res.status).toBe(0);
    try {
      expect(lockIsHeld()).toBe(false);
    } finally {
      spawnSync("pkill", ["-f", "^sleep 5$"]);
    }
  });

  it("makes a second caller wait for the first, naming the holder", async () => {
    startWrapper(["sleep", "1.5"]);
    await sleepMs(400);
    const started = Date.now();
    const second = run(["true"]);
    expect(second.status).toBe(0);
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(second.stderr).toMatch(/another worktree's test gate is running \(pid \d+ in /);
  });

  it("gives up with a clear error when the wait times out", async () => {
    startWrapper(["sleep", "3"]);
    await sleepMs(400);
    const second = run(["true"], { MULLION_GATE_LOCK_TIMEOUT: "1" });
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/gave up waiting/);
  });

  it("MULLION_NO_GATE_LOCK=1 bypasses the lock even while it is held", async () => {
    startWrapper(["sleep", "2"]);
    await sleepMs(400);
    expect(run(["true"], { MULLION_NO_GATE_LOCK: "1" }).status).toBe(0);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to the command and releases the lock instead of orphaning the suite",
    async (signal) => {
      const wrapper = startWrapper(["sleep", "30"]);
      await sleepMs(500);
      const cmd = childOf(wrapper);
      expect(cmd).toBeGreaterThan(0);
      expect(lockIsHeld()).toBe(true);

      process.kill(wrapper.pid!, signal);
      await sleepMs(600);

      expect(isAlive(cmd)).toBe(false);
      expect(lockIsHeld()).toBe(false);
    },
  );
});
