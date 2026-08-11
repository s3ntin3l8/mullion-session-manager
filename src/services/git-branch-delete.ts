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
// B9 — see git-status.ts's identical constant for the full rationale
// (shared across every runGit-shaped helper in this sibling group).
const KILL_ESCALATION_MS = 2_000;

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

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    const onStderrData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    // B9 — see git-status.ts's runGitStatus for the full rationale on both
    // the escalation and the listener-detach-in-finish shape below.
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
    }, GIT_TIMEOUT_MS);

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
 * must refer to an EXISTING branch, not a newly-derived name. Also rejects
 * `*`/`?`/`[` (Hermes review on PR #505): none of these can ever appear in
 * a real ref name (`git check-ref-format`), but the precheck below passes
 * `name` as a `for-each-ref` PATTERN argument, which glob-expands them —
 * e.g. `feature-*` matching every `feature-*` branch would read the wrong
 * ref's `%(HEAD)` and silently bypass the `checked-out` guard (`listWorktrees`
 * only ever compares against a real, literal branch name, never a pattern).
 * The actual `git branch -d/-D` call is unaffected either way — it treats
 * its argument literally, never as a glob — so this closes an incorrect-
 * classification bug, not a destructive-deletion one. */
function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..")) return false;
  if (/\s/.test(name)) return false;
  if (/[*?[]/.test(name)) return false;
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
  // CodeQL flagged this guard's `existsSync` call (alert #173, GitHub
  // Advanced Security review on PR #505) — the same "real mitigation, not
  // a recognized sanitizer shape" situation git-status.ts's `isGitRepo` and
  // git-worktree.ts's own `isSafeAbsolutePath`-gated calls already document
  // for this identical query. Dismissed in GHAS as alert #173 rather than
  // reshaping already-verified-safe code to chase a query that doesn't
  // model this guard as a sanitizer. (See dock-config.ts's isSymlinkPath for
  // why a `codeql[...]` line comment here wouldn't have dismissed this on
  // its own — this repo's codeql.yml has no step that turns a SARIF
  // suppression into an actual Security-tab dismissal.)
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
  // Hermes review on PR #505 — an unexpected refusal (a non-English git
  // locale, a permissions error, a lock file held by another process) used
  // to discard `stderr` entirely, surfacing as a bare, undiagnosable "The
  // operation failed." Include a truncated form so it's actionable.
  const trimmedStderr = deleteResult.stderr.trim();
  return {
    deleted: false,
    reason: "delete-failed",
    detail: trimmedStderr.length > 0 ? trimmedStderr.slice(0, 300) : undefined,
  };
}
