import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.js";
import type { GitPullReason, GitPullResult } from "../shared/types.js";

export type { GitPullReason, GitPullResult };

// Git Pull (issue #745) — the mutating counterpart to git-fetch.ts.
// Fetch only updates remote-tracking refs, while Pull advances the local working
// tree using strict --ff-only semantics. A UI Pull must NEVER auto-create a
// merge commit or auto-rebase; any diverged history is a refusal.
//
// Same absolute-path + no-".."-segment guard, gitEnv(), and timeout posture
// as git-fetch.ts and git-branch-delete.ts.

const FETCH_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;
const KILL_ESCALATION_MS = 2_000;

function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], timeoutMs = 10_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnChild("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    const onStderrData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      finish({ code: null, stdout, stderr });
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    }, timeoutMs);

    child.on("error", (err) => {
      clearKillTimer();
      finish({ code: null, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearKillTimer();
      finish({ code, stdout, stderr });
    });
  });
}

/**
 * Executes a fast-forward git pull (`git merge --ff-only @{u}`) after fetching
 * from upstream. Never throws.
 *
 * Refusal reasons:
 * - `not-a-repo`: cwd is not a safe absolute path or not a git repository
 * - `unborn-head`: HEAD has no commits yet
 * - `detached-head`: checkout is in detached HEAD state
 * - `dirty-tree`: uncommitted changes or merge conflicts present
 * - `no-upstream`: current branch has no configured tracking branch
 * - `not-fast-forward`: local branch has diverged from upstream
 * - `already-up-to-date`: behind count is 0 (no-op success)
 * - `pull-failed`: unexpected fetch or merge error
 */
export async function runGitPull(cwd: string): Promise<GitPullResult> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) {
    return { pulled: false, reason: "not-a-repo" };
  }

  // Pre-flight status check before making network calls
  const statusRes = await runGit(cwd, ["status", "--porcelain=v2", "--branch"], STATUS_TIMEOUT_MS);
  if (statusRes.code !== 0) {
    return {
      pulled: false,
      reason: "pull-failed",
      detail: statusRes.stderr.trim().slice(0, 300) || "Failed to inspect git status",
    };
  }

  const lines = statusRes.stdout.split("\n");
  let isUnborn = false;
  let isDetached = false;
  let hasUpstream = false;
  let isClean = true;
  let hasConflicts = false;

  for (const line of lines) {
    if (line.startsWith("# branch.oid (initial)")) {
      isUnborn = true;
    } else if (line.startsWith("# branch.head (detached)")) {
      isDetached = true;
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("? ")) {
      isClean = false;
    } else if (line.startsWith("u ")) {
      isClean = false;
      hasConflicts = true;
    }
  }

  if (isUnborn) {
    return { pulled: false, reason: "unborn-head", detail: "Current branch has no commits" };
  }
  if (isDetached) {
    return { pulled: false, reason: "detached-head", detail: "Cannot pull with detached HEAD" };
  }
  if (!isClean || hasConflicts) {
    return {
      pulled: false,
      reason: "dirty-tree",
      detail: hasConflicts
        ? "Worktree has unresolved merge conflicts"
        : "Worktree has uncommitted changes",
    };
  }
  if (!hasUpstream) {
    return {
      pulled: false,
      reason: "no-upstream",
      detail: "No upstream tracking branch configured",
    };
  }

  // Fetch remote-tracking refs
  const fetchRes = await runGit(cwd, ["fetch", "--quiet", "--prune"], FETCH_TIMEOUT_MS);
  if (fetchRes.code !== 0) {
    const trimmed = fetchRes.stderr.trim();
    return {
      pulled: false,
      reason: "pull-failed",
      detail: trimmed.length > 0 ? trimmed.slice(0, 300) : "git fetch failed",
    };
  }

  // Inspect status after fetch
  const postFetchStatus = await runGit(
    cwd,
    ["status", "--porcelain=v2", "--branch"],
    STATUS_TIMEOUT_MS,
  );
  if (postFetchStatus.code !== 0) {
    return {
      pulled: false,
      reason: "pull-failed",
      detail:
        postFetchStatus.stderr.trim().slice(0, 300) || "Failed to inspect git status after fetch",
    };
  }

  let behind = 0;
  for (const line of postFetchStatus.stdout.split("\n")) {
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        behind = Number(match[2]);
      }
    }
  }

  if (behind === 0) {
    return { pulled: true, reason: "already-up-to-date" };
  }

  // Fast-forward merge upstream
  const mergeRes = await runGit(cwd, ["merge", "--ff-only", "@{u}"], MERGE_TIMEOUT_MS);
  if (mergeRes.code === 0) {
    return { pulled: true };
  }

  const stderr = mergeRes.stderr.trim();
  if (/Not possible to fast-forward|not fast-forward/i.test(stderr)) {
    return {
      pulled: false,
      reason: "not-fast-forward",
      detail: "Branch has diverged from upstream",
    };
  }

  return {
    pulled: false,
    reason: "pull-failed",
    detail: stderr.length > 0 ? stderr.slice(0, 300) : undefined,
  };
}
