import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.js";
import { listWorktrees } from "./git-refs.js";

// Branch *deletion* (issue #442) — the mutating counterpart to git-refs.ts's
// read-only listBranches(). git-refs.ts is read-only enumeration by design
// (its own header comment), so this mutation gets its own file with its own
// private runGit copy — the repo's stated per-file convention: there's no
// shared spawn wrapper, only the shared gitEnv() (#205's env-leak fix, still
// routed through on every call below).
//
// `task-branch` is deliberately NOT one of this file's DeleteBranchReason
// values — that guard needs the tasks DB table, which this file has no
// access to (kept filesystem-only and DB-less so it stays unit-testable
// standalone). It's enforced one layer up, in routes/projects.ts.

const GIT_TIMEOUT_MS = 10_000;

function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `git -C <cwd> <args>`, capturing stdout/stderr on `'close'`. Never
 * rejects — a spawn error or timeout resolves with `code: null` the same way
 * a non-zero exit does. Same shape as git-worktree.ts's own runGit. */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnChild("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });

    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr });
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish({ code: null, stdout, stderr: String(err) }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

export type DeleteBranchReason =
  | "not-a-repo"
  | "invalid-name"
  | "no-such-branch"
  | "current-branch"
  | "checked-out"
  | "unmerged"
  | "delete-failed";

export interface DeleteBranchResult {
  deleted: boolean;
  reason?: DeleteBranchReason;
  /** For "checked-out": the worktree path holding it. */
  detail?: string;
}

/** Rejects a name that's empty, starts with "-" (git would otherwise
 * reinterpret it as a flag), or contains whitespace/".."/control chars —
 * the same conservative posture as git-worktree.ts's sanitizeRefComponent,
 * but rejecting outright here rather than mangling, since a delete target
 * must refer to an EXISTING branch, not a newly-derived name. */
function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..")) return false;
  if (/\s/.test(name)) return false;
  // eslint-disable-next-line no-control-regex -- deliberately matching raw control bytes
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

/**
 * Deletes a local branch (`git branch -d`, or `-D` under `force`). Pre-checks
 * with a **single-ref** `git for-each-ref refs/heads/<name>` plus
 * `listWorktrees` — deliberately NOT `listBranches`, which is no longer a
 * single cheap spawn under its own `?detail=1` enrichment — so
 * `current-branch`/`checked-out`/`no-such-branch` come back as clean reasons
 * rather than parsed stderr. `current-branch` means this branch is HEAD of
 * `cwd`'s own checkout; `checked-out` means it's checked out in some OTHER
 * worktree (`for-each-ref`'s `%(HEAD)` only marks the ref that's HEAD of the
 * `-C cwd` context itself — verified empirically against a real worktree —
 * so these are genuinely distinct cases, not a duplicate check). Classifies
 * leftover `git branch -d` stderr ("not fully merged") as `unmerged`, the
 * one case a clean precheck can't distinguish without doing `git branch
 * --merged` work `listBranches`' own `?detail=1` already exists for.
 * Never throws.
 */
export async function deleteBranch(
  cwd: string,
  name: string,
  opts?: { force?: boolean },
): Promise<DeleteBranchResult> {
  if (!isSafeAbsolutePath(cwd) || !existsSync(path.join(cwd, ".git"))) {
    return { deleted: false, reason: "not-a-repo" };
  }
  if (!isValidBranchName(name)) {
    return { deleted: false, reason: "invalid-name" };
  }

  const refCheck = await runGit(cwd, [
    "for-each-ref",
    "--format=%(HEAD)%09%(refname:short)",
    `refs/heads/${name}`,
  ]);
  const refLine = refCheck.code === 0 ? refCheck.stdout.trim() : "";
  if (refLine.length === 0) {
    return { deleted: false, reason: "no-such-branch" };
  }
  const [head] = refLine.split("\t");
  if (head === "*") {
    return { deleted: false, reason: "current-branch" };
  }

  const worktrees = await listWorktrees(cwd);
  const checkedOutIn = worktrees?.find((w) => w.branch === name);
  if (checkedOutIn) {
    return { deleted: false, reason: "checked-out", detail: checkedOutIn.path };
  }

  const deleteResult = await runGit(cwd, ["branch", opts?.force ? "-D" : "-d", name]);
  if (deleteResult.code === 0) {
    return { deleted: true };
  }
  if (/not fully merged/i.test(deleteResult.stderr)) {
    return { deleted: false, reason: "unmerged" };
  }
  return { deleted: false, reason: "delete-failed" };
}
