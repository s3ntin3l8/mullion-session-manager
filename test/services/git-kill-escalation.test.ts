import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";

// B9 — every runGit-shaped helper in the git-*.ts sibling group now
// escalates to SIGKILL when a spawned git process ignores its initial
// SIGTERM, and detaches its stdout/stderr 'data' listeners once it gives up
// on a process (timeout, byte-cap truncation, or a genuine close/error) so a
// still-running wedged process can't keep appending to a string nobody will
// ever read. This file exercises that mechanism directly against a fully
// controlled fake child_process — the sibling *.test.ts files for these same
// modules (git-status.test.ts, git-refs.test.ts, git-worktree.test.ts,
// git-branch-delete.test.ts, git-diff.test.ts) all spawn a REAL git binary
// against a real temp repo and can't make git ignore SIGTERM on demand, so
// this is deliberately a separate file rather than folded into them.
//
// git-fetch.ts is NOT covered here — its own child_process's `timeout`
// option already handles termination natively (node's own SIGTERM+kill
// machinery), and it isn't one of the five files this finding calls out
// (see git-fetch.test.ts for its own isSafeAbsolutePath guard tests). git-
// ignore.ts is also excluded: its spawn call is `stdio: ["ignore", "ignore",
// "ignore"]` — nothing to detach — and it already kills on timeout with
// nothing further needed.

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killSpy = vi.fn();

  // Deliberately does NOT set exitCode/signalCode or emit 'close' — models a
  // process that ignores every signal sent to it, so the SIGKILL-escalation
  // branch can be asserted deterministically rather than racing a real OS
  // process.
  kill(signal?: string) {
    this.killSpy(signal);
  }
}

let nextChild: FakeChild;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => nextChild),
  };
});

const { getGitStatus, clearGitStatusCacheForTests } =
  await import("../../src/services/git-status.js");
const { listWorktrees } = await import("../../src/services/git-refs.js");
const { pruneWorktreeMetadata } = await import("../../src/services/git-worktree.js");
const { deleteBranch } = await import("../../src/services/git-branch-delete.js");
const { getDiffStats, getFileDiff, clearGitDiffStatsCacheForTests } =
  await import("../../src/services/git-diff.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-kill-escalation-test-"));
  // Only existence is ever checked (isGitRepo/isSafeAbsolutePath-adjacent
  // guards) before these functions ever reach the mocked spawn — a real
  // repo isn't needed since git itself never actually runs in this file.
  fs.mkdirSync(path.join(tmpDir, ".git"));
  nextChild = new FakeChild();
  clearGitStatusCacheForTests();
  clearGitDiffStatsCacheForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("git-status.ts's runGitStatus", () => {
  it("escalates to SIGKILL after the grace period when the process ignores SIGTERM", async () => {
    const resultPromise = getGitStatus(tmpDir, { forceFresh: true });

    await vi.advanceTimersByTimeAsync(5_000); // GIT_TIMEOUT_MS
    expect(await resultPromise).toBeNull();
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);
    expect(nextChild.killSpy).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(2_000); // KILL_ESCALATION_MS
    expect(nextChild.killSpy).toHaveBeenCalledTimes(2);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("detaches stdout/stderr listeners once it gives up on the process", async () => {
    const resultPromise = getGitStatus(tmpDir, { forceFresh: true });
    expect(nextChild.stdout.listenerCount("data")).toBe(1);
    expect(nextChild.stderr.listenerCount("data")).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await resultPromise;

    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.stderr.listenerCount("data")).toBe(0);
  });

  it("does not escalate to SIGKILL once the process actually closes on its own", async () => {
    const resultPromise = getGitStatus(tmpDir, { forceFresh: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await resultPromise;
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    nextChild.exitCode = 143; // SIGTERM's conventional exit code
    nextChild.emit("close", null);

    await vi.advanceTimersByTimeAsync(2_000);
    // The kill-escalation timer was cleared by 'close', so no second call.
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);
  });

  it("does not send SIGKILL if the process died between SIGTERM and the escalation deadline, even without a 'close' event", async () => {
    // Exercises the actual guard inside the escalation timer's callback
    // (`exitCode === null && signalCode === null`), not just the
    // clearKillTimer()-on-'close' path the test above covers — a process
    // can plausibly set its exit status before this process's 'close'
    // handler runs (or, in a real OS process, before Node's event loop gets
    // to it at all).
    const resultPromise = getGitStatus(tmpDir, { forceFresh: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await resultPromise;
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    nextChild.exitCode = 143; // died from the SIGTERM, but no 'close' emitted yet

    await vi.advanceTimersByTimeAsync(2_000);
    // The escalation timer's own guard sees exitCode !== null and skips
    // the SIGKILL — still only the one SIGTERM call.
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);
  });
});

describe("git-refs.ts's listWorktrees", () => {
  it("escalates to SIGKILL and detaches its stdout listener", async () => {
    const resultPromise = listWorktrees(tmpDir);
    expect(nextChild.stdout.listenerCount("data")).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000); // GIT_TIMEOUT_MS
    expect(await resultPromise).toBeNull();
    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });
});

describe("git-worktree.ts's runGit (via pruneWorktreeMetadata)", () => {
  it("escalates to SIGKILL and detaches its stdout/stderr listeners", async () => {
    const resultPromise = pruneWorktreeMetadata(tmpDir);

    await vi.advanceTimersByTimeAsync(15_000); // GIT_TIMEOUT_MS
    expect(await resultPromise).toEqual({ pruned: false });
    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.stderr.listenerCount("data")).toBe(0);
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });
});

describe("git-branch-delete.ts's runGit (via deleteBranch)", () => {
  it("escalates to SIGKILL and detaches listeners when the precheck spawn hangs", async () => {
    const resultPromise = deleteBranch(tmpDir, "feature-x");

    await vi.advanceTimersByTimeAsync(10_000); // GIT_TIMEOUT_MS
    // The for-each-ref precheck never resolved, so the branch line reads
    // empty — same "didn't work" collapse every runGit caller in this repo
    // uses for a timeout.
    expect(await resultPromise).toEqual({ deleted: false, reason: "no-such-branch" });
    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.stderr.listenerCount("data")).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });
});

describe("git-diff.ts's runGitDiffNumstat (via getDiffStats)", () => {
  it("escalates to SIGKILL and detaches its stdout listener", async () => {
    const resultPromise = getDiffStats(tmpDir);

    await vi.advanceTimersByTimeAsync(5_000); // GIT_TIMEOUT_MS
    expect(await resultPromise).toBeNull();
    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });
});

describe("git-diff.ts's getFileDiff", () => {
  it("escalates to SIGKILL and detaches its stdout listener on timeout", async () => {
    const resultPromise = getFileDiff(tmpDir, "some/file.ts");

    await vi.advanceTimersByTimeAsync(5_000); // GIT_TIMEOUT_MS
    expect(await resultPromise).toBeNull();
    expect(nextChild.stdout.listenerCount("data")).toBe(0);
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });

  it("truncates and kills the process once the accumulated patch exceeds the byte cap", async () => {
    const resultPromise = getFileDiff(tmpDir, "some/file.ts");

    const twoMiB = 2 * 1024 * 1024;
    // One chunk comfortably under the cap...
    nextChild.stdout.emit("data", Buffer.alloc(twoMiB - 10, "a"));
    // ...then one that pushes the running total over it.
    nextChild.stdout.emit("data", Buffer.from("b".repeat(100)));

    const result = await resultPromise;
    expect(result).not.toBeNull();
    expect(result).toContain("[diff truncated: exceeds 2 MiB");
    // The full patch was never returned — only what was buffered before the
    // cap tripped, plus the marker.
    expect(result!.length).toBeLessThan(twoMiB + 200);
    expect(nextChild.killSpy).toHaveBeenCalledTimes(1);
    expect(nextChild.stdout.listenerCount("data")).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextChild.killSpy).toHaveBeenLastCalledWith("SIGKILL");
  });
});
