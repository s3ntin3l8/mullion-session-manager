import { spawn as spawnChild } from "node:child_process";
import path from "node:path";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";
import { isPlainBranchName, listWorktrees, resolveDefaultBaseRefNoFetch } from "./git-refs.js";
import { isGitRepo } from "./git-status.js";
import type { GitBranchOpReason, GitBranchOpResult } from "../shared/types.js";

export type { GitBranchOpReason, GitBranchOpResult };

// Branch checkout / create / rebase from the Git view (issue #1672) — the
// mutating siblings of git-pull.ts, and the same posture: every one of them
// refuses on a dirty tree rather than carrying, stashing or discarding the
// user's changes, and a rebase that stops on a conflict is aborted so the
// checkout is left exactly as it was. Never throws.
//
// Kept DB-less, like git-branch-delete.ts, so it runs unchanged on a remote
// agent (/internal/git-checkout, …). The "an active session works in this
// checkout" guard needs the sessions table, so it lives one layer up, in
// routes/projects.ts — which is also why `sessions-active` and `busy` are
// reasons this file never returns.

const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const REBASE_TIMEOUT_MS = 60_000;
const KILL_ESCALATION_MS = 2_000;
const DETAIL_MAX = 300;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Same shape as git-pull.ts's own runGit (the per-file convention). */
function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnChild("git", [...GIT_NO_AUTO_GC, "-C", cwd, ...args], {
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

function failed(res: GitResult, fallback: string): GitBranchOpResult {
  const trimmed = res.stderr.trim();
  return { ok: false, reason: "failed", detail: trimmed ? trimmed.slice(0, DETAIL_MAX) : fallback };
}

interface CheckoutState {
  branch: string | null;
  unborn: boolean;
  upstream: string | null;
  clean: boolean;
}

async function readState(cwd: string): Promise<CheckoutState | GitBranchOpResult> {
  const res = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
  if (res.code !== 0) return failed(res, "Failed to inspect git status");
  const state: CheckoutState = { branch: null, unborn: false, upstream: null, clean: true };
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("# branch.oid (initial)")) state.unborn = true;
    else if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      state.branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      state.upstream = line.slice("# branch.upstream ".length);
    } else if (/^[12u?] /.test(line)) state.clean = false;
  }
  return state;
}

function isResult(value: CheckoutState | GitBranchOpResult): value is GitBranchOpResult {
  return "ok" in value;
}

const DIRTY: GitBranchOpResult = {
  ok: false,
  reason: "dirty-tree",
  detail: "The checkout has uncommitted changes",
};

/** True while a rebase, merge, cherry-pick or revert is stopped mid-way.
 * A rebase is asked of git itself, not REBASE_HEAD: one paused at an
 * `edit`/`break` step, or killed, has no REBASE_HEAD. `rebase
 * --show-current-patch` dies (128, "No rebase in progress?") only when no
 * rebase of either backend is under way; it exits 0 with a stopped patch
 * and 1 without one. */
async function operationInProgress(cwd: string): Promise<boolean> {
  const rebase = await runGit(cwd, ["rebase", "--show-current-patch"]);
  if (rebase.code === 0 || rebase.code === 1) return true;
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const res = await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (res.code === 0) return true;
  }
  return false;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const res = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return res.code === 0;
}

/** The worktree (other than `cwd`'s own) that has `branch` checked out. */
async function checkedOutElsewhere(cwd: string, branch: string): Promise<string | null> {
  const worktrees = await listWorktrees(cwd);
  const self = path.resolve(cwd);
  const holder = worktrees?.find((w) => w.branch === branch && path.resolve(w.path) !== self);
  return holder?.path ?? null;
}

/** A ref NAME, not revision syntax: on top of isPlainBranchName, no reflog
 * (`@{…}`) or peel (`^{…}`) braces, and no bare `@`/`HEAD`, which name a
 * position rather than a branch. Each value is still a single argv entry. */
function isRefName(name: string): boolean {
  return isPlainBranchName(name) && !/[{}]/.test(name) && name !== "@" && name !== "HEAD";
}

/**
 * Switches the checkout at `cwd` to `branch`. A branch that exists only as
 * `origin/<branch>` is created tracking it (`git switch`'s own guess). Refuses
 * on a dirty tree, a stopped rebase/merge, or a branch another worktree holds.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<GitBranchOpResult> {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not-a-repo" };
  if (!isRefName(branch)) return { ok: false, reason: "invalid-name" };

  const state = await readState(cwd);
  if (isResult(state)) return state;
  if (state.branch === branch) return { ok: false, reason: "already-current" };
  // Before the dirty check: a stopped merge/rebase is the more specific
  // (and more useful) answer for a tree that is also dirty because of it.
  if (await operationInProgress(cwd)) return { ok: false, reason: "operation-in-progress" };
  if (!state.clean) return DIRTY;

  const local = await refExists(cwd, `refs/heads/${branch}`);
  if (!local && !(await refExists(cwd, `refs/remotes/origin/${branch}`))) {
    return { ok: false, reason: "no-such-branch" };
  }
  if (local) {
    const holder = await checkedOutElsewhere(cwd, branch);
    if (holder) return { ok: false, reason: "checked-out", detail: holder };
  }

  const res = await runGit(cwd, ["switch", branch]);
  return res.code === 0 ? { ok: true } : failed(res, "git switch failed");
}

/**
 * Creates `name` from `from` (a branch or remote-tracking ref), without an
 * upstream — a branch cut from `origin/main` must not end up tracking it, or
 * a later push/pull targets main. `checkout` switches to it, which is the
 * only part that touches the working tree, so only then is a dirty tree a
 * refusal.
 */
export async function createBranch(
  cwd: string,
  name: string,
  from: string,
  opts: { checkout?: boolean } = {},
): Promise<GitBranchOpResult> {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not-a-repo" };
  if (!isRefName(name)) return { ok: false, reason: "invalid-name" };
  // A start point is a ref name, never revision syntax: the same validator
  // keeps `HEAD~3`, `main@{1}`, `-flag` and globs out of the argv.
  if (!isRefName(from)) return { ok: false, reason: "invalid-name", detail: from };

  const format = await runGit(cwd, ["check-ref-format", "--branch", name]);
  if (format.code !== 0) return { ok: false, reason: "invalid-name" };
  if (await refExists(cwd, `refs/heads/${name}`)) return { ok: false, reason: "already-exists" };
  if (!(await refExists(cwd, from))) return { ok: false, reason: "no-such-ref", detail: from };

  if (opts.checkout) {
    const state = await readState(cwd);
    if (isResult(state)) return state;
    if (await operationInProgress(cwd)) return { ok: false, reason: "operation-in-progress" };
    if (!state.clean) return DIRTY;
    const res = await runGit(cwd, ["switch", "--no-track", "-c", name, from]);
    return res.code === 0 ? { ok: true } : failed(res, "git switch -c failed");
  }

  const res = await runGit(cwd, ["branch", "--no-track", name, from]);
  return res.code === 0 ? { ok: true } : failed(res, "git branch failed");
}

/**
 * Rebases the checked-out branch onto `onto` — by default its upstream, and
 * `origin/<default>` when it has none. Fetches first (best-effort, like the
 * Pull button) so the target is current. A rebase that stops on a conflict
 * is aborted, and the conflicting files come back with the refusal: the
 * checkout is never left mid-rebase.
 */
export async function rebaseBranch(cwd: string, onto?: string): Promise<GitBranchOpResult> {
  if (!isGitRepo(cwd)) return { ok: false, reason: "not-a-repo" };
  if (onto !== undefined && !isRefName(onto)) {
    return { ok: false, reason: "invalid-name", detail: onto };
  }

  const state = await readState(cwd);
  if (isResult(state)) return state;
  // First: a stopped merge/rebase is the more specific (and more useful)
  // answer for a tree that is also dirty, or detached, because of it.
  if (await operationInProgress(cwd)) return { ok: false, reason: "operation-in-progress" };
  if (state.unborn) return { ok: false, reason: "unborn-head" };
  if (state.branch === null) return { ok: false, reason: "detached-head" };
  if (!state.clean) return DIRTY;

  // A failed fetch (offline, no remote) rebases onto what the clone has.
  await runGit(cwd, ["fetch", "--quiet", "--prune"], FETCH_TIMEOUT_MS);

  // An upstream whose remote branch is gone (deleted after its merge, and
  // just pruned by the fetch above) is still configured: fall through to
  // the default branch rather than refusing on a ref that no longer exists.
  let target = onto ?? state.upstream;
  if (!onto && target && !(await refExists(cwd, target))) target = null;
  if (!target) {
    const base = await resolveDefaultBaseRefNoFetch(cwd);
    target = base === "HEAD" ? null : base;
  }
  if (!target) return { ok: false, reason: "no-base" };
  if (!(await refExists(cwd, target))) return { ok: false, reason: "no-such-ref", detail: target };

  const upToDate = await runGit(cwd, ["merge-base", "--is-ancestor", target, "HEAD"]);
  if (upToDate.code === 0) return { ok: true, reason: "already-up-to-date", detail: target };

  // `core.editor=true`: a rebase that wants a message (it never should
  // non-interactively) must not hang on an editor the host cannot show.
  const res = await runGit(cwd, ["-c", "core.editor=true", "rebase", target], REBASE_TIMEOUT_MS);
  if (res.code === 0) return { ok: true, detail: target };

  const conflicted = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  const conflicts = conflicted.stdout.split("\n").filter((f) => f.length > 0);
  // Whatever stopped it — a conflict or anything else — the rebase is
  // undone, so the checkout is back on its original commit.
  const aborted = await runGit(cwd, ["rebase", "--abort"]);
  if (aborted.code !== 0 && (await operationInProgress(cwd))) {
    return failed(aborted, "git rebase --abort failed — the checkout is mid-rebase");
  }
  if (conflicts.length > 0) {
    return { ok: false, reason: "conflicts", detail: target, conflicts: conflicts.slice(0, 50) };
  }
  return failed(res, "git rebase failed");
}
