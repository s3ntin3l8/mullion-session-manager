import { spawn as spawnChild } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { gitEnv } from "./git-env.js";
import { getGitStatus } from "./git-status.js";
import { listWorktrees } from "./git-refs.js";

// Worktree *creation* (issue #271) — the missing half of git-refs.ts's
// read-only listWorktrees()/listBranches(). Mullion shipped and removed
// eager, session-insert-time worktree creation once already (PR #152 ->
// #197, resolving #162: it went stale on idle sessions and session reuse).
// This intentionally resurrects only the create primitive, at the narrower
// scope #162's postmortem calls for — creation coupled to the moment work
// actually starts (a launcher toggle or an explicit promote action, never
// eagerly). Task-worktree removal/pruning (Phase 6's 6.8, issue #283) lives
// further down this file, in its own section — a clean-check-gated,
// never-`--force` counterpart to `removeWorktree` below, which stays
// `--force`-unconditional for its own real caller (dock-preview cleanup).
// Every git call below routes through gitEnv() (issue #205) —
// the original version predated that fix and leaked hook-scoped GIT_* env
// into its `git -C <cwd>` calls; reintroducing that here would reopen the
// exact corruption class #205 fixed.
//
// Branch-per-worktree, never `--detach`, for `createWorktree` (locked
// decision, carried over from the original): `git worktree add -b <branch>`
// leaves the work reachable from a ref that survives `git worktree remove`
// — `--detach` would leave it reachable only from the worktree's own HEAD,
// discarded outright by a future removal.
//
// `checkoutBranchWorktree` (PR #341's dock-preview flow, below) is the
// deliberate inverse, and for a different kind of worktree: a preview
// worktree is transient, force-removed by design, and holds no work worth
// preserving — there's nothing here for a branch ref to protect. Worse,
// giving it a real branch checkout means it can end up sharing
// `refs/heads/<branch>` with whichever other worktree (often the primary
// checkout) already has that branch checked out, since `git worktree add`
// only allows that with `--force`. `syncWorktree`'s `reset --hard` on a
// shared ref moves it out from under that other checkout without updating
// its index/working tree — reproduced by hand: an uncommitted edit in the
// primary checkout survives, but the next commit there silently reverts
// whatever the preview's reset just brought in. `--detach` is what makes a
// preview's reset touch only its own HEAD, never a ref anything else reads.

const GIT_TIMEOUT_MS = 15_000;
// B9 — see git-status.ts's identical constant for the full rationale
// (shared across every runGit-shaped helper in this sibling group).
const KILL_ESCALATION_MS = 2_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `git -C <cwd> <args>`, capturing stdout/stderr on `'close'`. Never
 * rejects — a spawn error or timeout resolves with `code: null` the same way
 * a non-zero exit does, so every caller can treat "didn't work" uniformly. */
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

// Same absolute-path + no-".."-segment guard as git-refs.ts/git-status.ts —
// every cwd/baseDir/worktreePath this module touches is always an
// already-resolved project cwd (session-lifecycle.ts, same trust tier as
// project.cwd itself) or an agent-side value already passed through
// resolveWithinRoots (routes/internal.ts), never a raw, unauthenticated
// request value.
function isSafeAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && !path.normalize(p).split(path.sep).includes("..");
}

// A branch/dir component only ever needs to be human-recognizable, not a
// full copy of an arbitrarily long input. Truncating up front bounds the
// regex passes below to a fixed-size input regardless of what the caller
// sent (same mitigation git-branch.ts/the original git-worktree.ts used for
// CodeQL's js/polynomial-redos query).
const MAX_REF_COMPONENT_LENGTH = 200;

// git ref names reject a fair number of characters (space, ~^:?*[\, a
// leading/trailing "/", "..", a trailing ".lock", ending in "."). Rather than
// reimplement `git check-ref-format`, collapse anything outside a
// conservative safe set down to "-" — a cosmetically-mangled branch name is
// fine; a `git worktree add -b` that fails to parse its own generated branch
// argument is not.
function sanitizeRefComponent(value: string): string {
  const cleaned = value
    .slice(0, MAX_REF_COMPONENT_LENGTH)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "session";
}

/** Appends a 6-char hex hash of the original name so that branches like
 * `feature/foo` and `feature--foo` produce distinct directory names. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/** Idempotently adds `baseDir` (relative to `cwd`) to `.git/info/exclude` so
 * a nested worktree directory never shows up as untracked in the parent
 * repo's own `git status` — flipping the sidebar's dirty dot for every
 * project with worktree isolation in use would defeat the point of it.
 * No-op when `baseDir` isn't actually nested under `cwd`, or when
 * `.git/info/exclude` isn't readable/writable (best-effort only). */
function ensureExcluded(cwd: string, baseDir: string): void {
  const resolvedBase = path.resolve(baseDir);
  if (resolvedBase !== cwd && !resolvedBase.startsWith(cwd + path.sep)) return;
  const rel = path.relative(cwd, resolvedBase).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return;

  const excludePath = path.join(cwd, ".git", "info", "exclude");
  const pattern = `/${rel}/`;
  let existing: string;
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    return;
  }
  if (existing.split("\n").some((line) => line.trim() === pattern)) return;
  try {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(excludePath, `${separator}${pattern}\n`);
  } catch {
    // Best-effort — a failed exclude write just means the parent repo's
    // dirty dot may flip until it's fixed manually; the worktree itself is
    // still created below.
  }
}

export interface CreateWorktreeOptions {
  /** The parent repo's working directory. */
  cwd: string;
  /** Branch/ref the new worktree's branch is created from, e.g. "main" or
   * "origin/feature-x" — the base-ref picker's chosen value. */
  baseRef: string;
  /** Identifier used to derive both the branch name (`mullion/<seed>`,
   * unless `branchName` overrides it) and the worktree's directory name
   * under `baseDir`. Callers pass a human-chosen name when available (e.g.
   * a typed branch name) or a generated one otherwise. */
  seed: string;
  /** Full branch name override; when omitted, derived as `mullion/<seed>`. */
  branchName?: string;
  /** Base directory worktrees are created under. Defaults to
   * `<cwd>/.mullion-worktrees`. */
  baseDir?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
}

// Issue #677 — createWorktree's failure surface collapsed every distinct
// cause (bad cwd, unresolvable baseRef, a branch/path collision, a stale
// git process) into a single `null`, so every caller (the launcher's
// worktree toggle, promote) could only ever show one generic "check that
// the base ref exists" message regardless of what actually went wrong.
// Mirrors git-branch-delete.ts's DeleteBranchResult shape exactly — same
// `{ <verb>ed, reason?, detail? }` idiom, same truncated-stderr posture for
// the catch-all reason. `checkoutBranchWorktree` has the identical `null`
// defect but is left out of this change to keep the diff scoped to the
// launcher/promote path that #677 was actually filed against.
export type CreateWorktreeReason =
  | "invalid-cwd"
  | "invalid-base-ref"
  | "invalid-base-dir"
  | "not-a-repo"
  | "no-such-ref"
  | "branch-exists"
  | "path-exists"
  | "timeout"
  | "create-failed"
  // Never produced by createWorktree itself — only by session-lifecycle.ts's
  // resolveWorktreeCwd, when a remote host's createWorktree call throws
  // rather than resolving. Kept in this same union (rather than a second
  // wrapper type) so the one result type flows end-to-end from the git call
  // through to the route's response body. Split into two distinct reasons
  // (not one "host-unreachable" catch-all) mirroring this same file's
  // logPreviewWorktreeHostError and killSession's own HostRequestError
  // split: a rejection (the agent is up and rejected the request — e.g.
  // requireWithinRoots refusing the cwd) is a persistent, retry-forever
  // condition, unlike a transient network blip, and the #484 postmortem
  // ("HostRequestError covers any 4xx, not just 404") is exactly the
  // mistake this split exists to avoid repeating.
  | "host-unreachable"
  | "host-rejected";

export interface CreateWorktreeResult {
  created: boolean;
  path?: string;
  branch?: string;
  reason?: CreateWorktreeReason;
  detail?: string;
}

/** Classifies a failed `git worktree add`'s stderr into a CreateWorktreeReason.
 * Verified empirically against real git output (see the PR for the repro
 * transcript) rather than guessed: "not a git repository..." for a bad cwd,
 * "fatal: invalid reference: <ref>" for an unresolvable baseRef, "fatal: a
 * branch named '<x>' already exists" for a branch collision, and "fatal:
 * '<path>' already exists" for a non-empty target directory. The
 * branch-collision check runs before the generic "already exists" one since
 * both phrases contain that substring. Falls back to "create-failed" (with
 * the truncated stderr as `detail`, same 300-char cap as deleteBranch) for
 * anything else — a non-English git locale, a permissions error, or a git
 * version whose wording differs. */
function classifyCreateFailure(stderr: string): CreateWorktreeReason {
  if (/not a git repository/i.test(stderr)) return "not-a-repo";
  if (/a branch named .* already exists/i.test(stderr)) return "branch-exists";
  if (/already exists/i.test(stderr)) return "path-exists";
  if (/invalid reference/i.test(stderr)) return "no-such-ref";
  return "create-failed";
}

/** Derives the on-disk worktree path a given `(cwd, seed)` pair would
 * produce, WITHOUT touching the filesystem — the same `sanitizeRefComponent`
 * derivation `createWorktree` uses internally, exposed so a caller can
 * predict a worktree's path before it exists (task-claim.ts's orphan-clear
 * step: a crashed claim can leave `mullion/task-<id>-<slug>`'s directory on disk
 * with nothing in the DB pointing at it, since `worktreePath` is only
 * stamped after full success — clearing it before retrying `git worktree
 * add` needs to know the path in advance, not after a collision). Pure and
 * synchronous; never throws. */
export function deriveWorktreePath(cwd: string, seed: string, baseDir?: string): string {
  const projectRoot = path.resolve(cwd);
  const dir =
    baseDir && baseDir.length > 0 ? baseDir : path.join(projectRoot, ".mullion-worktrees");
  return path.join(dir, sanitizeRefComponent(seed));
}

/**
 * Creates a new worktree off `cwd`, branched from `baseRef`, on a fresh
 * branch (`git worktree add -b <branch> <path> <baseRef>`, never `--detach`
 * — see the module doc comment). Returns `{ created: false, reason, detail?
 * }` when `cwd` isn't a git repo, `baseRef` doesn't resolve, or the
 * `git worktree add` call fails (see `CreateWorktreeReason`/
 * `classifyCreateFailure` above) — never throws.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
  const { cwd, baseRef, seed } = opts;
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes(".."))
    return {
      created: false,
      reason: "invalid-cwd",
      detail: `cwd "${cwd}" is not a valid absolute path`,
    };
  const projectRoot = path.resolve(cwd);
  // baseRef reaches `git worktree add`'s argv as the final positional
  // argument, unsanitized (sanitizeRefComponent would mangle a legitimate
  // ref like "origin/main"). Spawning uses an argv array, not a shell
  // string, so this isn't shell injection — but git itself still treats a
  // leading "-" as an option marker regardless of position, so an
  // unvalidated value could be reinterpreted as a flag (e.g. `--force`)
  // rather than a ref. No real branch name ever starts with "-", so
  // rejecting one is a pure hardening measure, not a functional
  // restriction. Matters more here than most cwd/branchName inputs in this
  // file: baseRef can originate as a model-authored `suggestedBaseRef`
  // (issue #271's promote_to_worktree MCP tool) that reaches this function
  // unchanged if a human submits the promote dialog without editing the
  // pre-filled base-ref picker.
  if (baseRef.length === 0 || baseRef.startsWith("-"))
    return {
      created: false,
      reason: "invalid-base-ref",
      detail:
        baseRef.length === 0
          ? "baseRef must not be empty"
          : `baseRef "${baseRef}" starts with "-" and would be reinterpreted as a flag`,
    };

  const baseDir =
    opts.baseDir && opts.baseDir.length > 0
      ? opts.baseDir
      : path.join(projectRoot, ".mullion-worktrees");
  if (!isSafeAbsolutePath(baseDir))
    return {
      created: false,
      reason: "invalid-base-dir",
      detail: `baseDir "${baseDir}" is not a valid absolute path`,
    };

  const dirName = sanitizeRefComponent(seed);
  const worktreePath = deriveWorktreePath(projectRoot, seed, baseDir);
  const branch =
    opts.branchName && opts.branchName.length > 0
      ? opts.branchName
          .split("/")
          .map((segment) => sanitizeRefComponent(segment))
          .filter((segment) => segment.length > 0)
          .join("/") || `mullion/${dirName}`
      : `mullion/${dirName}`;

  ensureExcluded(projectRoot, baseDir);

  // --no-track (issue #271 follow-up): verified empirically that `git
  // worktree add -b <branch> <path> origin/main` otherwise sets the new
  // branch's upstream to origin/main (branch.autoSetupMerge's default
  // tracks when the start point is a remote-tracking ref, but NOT when it's
  // a local branch — this is a behavior change only for a remote-tracking
  // baseRef). A tracked-but-differently-named branch then makes a bare
  // `git push` from the worktree hard-fail ("The upstream branch of your
  // current branch does not match the name of your current branch")
  // instead of the ordinary, agent-handleable "use git push
  // --set-upstream" prompt a plain new branch gets. Now that the base-ref
  // pickers default to `origin/<default>` rather than the current local
  // branch, this is load-bearing, not just hardening.
  const result = await runGit(projectRoot, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    branch,
    worktreePath,
    baseRef,
  ]);
  if (result.code !== 0) {
    if (result.code === null) {
      // Hermes review, this PR — runGit's `child.on("error")` handler also
      // resolves `{code: null, stderr: String(err)}` for a genuine spawn
      // failure (e.g. `git` not on PATH), the same shape a real timeout
      // produces. A timeout's own kill path never sets stderr (the process
      // is still running when the timer fires), so non-empty stderr here
      // means this was a spawn error, not a timeout — classify it as such
      // instead of dropping the detail under a misleading "timeout" reason.
      const trimmedStderr = result.stderr.trim();
      if (trimmedStderr.length > 0) {
        return { created: false, reason: "create-failed", detail: trimmedStderr.slice(0, 300) };
      }
      return { created: false, reason: "timeout" };
    }
    const reason = classifyCreateFailure(result.stderr);
    const trimmedStderr = result.stderr.trim();
    return {
      created: false,
      reason,
      detail: trimmedStderr.length > 0 ? trimmedStderr.slice(0, 300) : undefined,
    };
  }
  return { created: true, path: worktreePath, branch };
}

const DOCK_PREVIEW_PREFIX = "dock-preview-";

/**
 * Checks out an existing branch into a new, DETACHED-HEAD preview worktree
 * (`git worktree add --detach <path> <branch>`) — see the module doc comment
 * for why this must never be a real branch checkout. The returned `branch`
 * is the requested branch (the preview's *intent*), not a ref HEAD points
 * at: HEAD is detached, so nothing here ever claims `refs/heads/<branch>`,
 * which is what makes `syncWorktree`'s `reset --hard` safe to run against it
 * even while that same branch is checked out elsewhere.
 *
 * The worktree is created under
 * `.mullion-worktrees/dock-preview-<sanitized-branch>-<hash>/` so it can be
 * identified for cleanup (see `isDockPreviewWorktree`/`DOCK_PREVIEW_PREFIX`).
 * Prunes stale worktree registrations first — a crash or manual `rm -rf` of
 * a previous preview's directory leaves `git worktree add` refusing to reuse
 * that path forever otherwise, unlike a live "already checked out" conflict,
 * which `--detach` alone already avoids without needing `--force`. Returns
 * `null` when `cwd` isn't a git repo, the branch doesn't resolve, or the git
 * call fails; never throws.
 */
export async function checkoutBranchWorktree(
  cwd: string,
  branch: string,
): Promise<WorktreeResult | null> {
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) return null;
  if (branch.length === 0 || branch.startsWith("-")) return null;
  const projectRoot = path.resolve(cwd);

  const baseDir = path.join(projectRoot, ".mullion-worktrees");
  if (!isSafeAbsolutePath(baseDir)) return null;

  const hash = shortHash(branch);
  const dirName = `${DOCK_PREVIEW_PREFIX}${sanitizeRefComponent(branch)}-${hash}`;
  const worktreePath = path.join(baseDir, dirName);

  ensureExcluded(projectRoot, baseDir);

  await runGit(projectRoot, ["worktree", "prune"]);
  const result = await runGit(projectRoot, ["worktree", "add", "--detach", worktreePath, branch]);
  if (result.code !== 0) return null;
  return { path: worktreePath, branch };
}

// ── Per-path serialization ────────────────────────────────────────────────
// The 5s sync tick (below) and every removal path (killSession,
// cleanupPreviewWorktree, session-lifecycle.ts's spawn-failure rollback) can
// target the same preview worktree at the same time — `git worktree remove
// --force` racing a `git reset --hard` on the same path can corrupt the
// worktree's administrative files or half-delete it mid-reset. Lock
// acquisition happens at the LEAF, inside `syncWorktree`/`removeWorktree`
// only — never at a call site — because `cleanupPreviewWorktree` calls
// `removeWorktree`, and locking at both layers would self-deadlock.
const pathOps = new Map<string, Promise<unknown>>();

/** Paths with a removal in progress or requested. Set synchronously (before
 * any `await`) at the top of `removeWorktree` so a sync already queued
 * behind it bails instead of re-materializing files git is about to delete,
 * and cleared in a `finally` so a failed/timed-out removal never leaves a
 * path permanently marked — that would silently and permanently kill
 * `worktreeRefresh` for whatever session still references it. */
const removingPaths = new Set<string>();

/** Runs `fn` after any operation already chained on `worktreePath`
 * completes, regardless of whether that prior operation succeeded — a
 * rejection must not permanently lock the path for later callers. `runGit`
 * itself never throws, so `fn` realistically won't either, but the chain
 * tolerates it regardless. The map entry is removed once this call's link
 * is the last one in the chain, so it never grows unboundedly across the
 * process's lifetime. */
function withPathLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathOps.get(worktreePath) ?? Promise.resolve();
  const settled = previous.then(fn, fn);
  const tail = settled.then(
    () => undefined,
    () => undefined,
  );
  pathOps.set(worktreePath, tail);
  void tail.then(() => {
    if (pathOps.get(worktreePath) === tail) pathOps.delete(worktreePath);
  });
  return settled;
}

/**
 * Removes a worktree at `worktreePath` via `git worktree remove --force`.
 * Runs `git worktree prune` from the parent repo's directory afterwards.
 * Serialized against `syncWorktree` on the same path (see the "Per-path
 * serialization" section above) — a sync still queued behind this call sees
 * `removingPaths` and bails rather than racing the removal. Returns `true`
 * if the removal succeeded, `false` on failure.
 */
export async function removeWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
  removingPaths.add(worktreePath);
  try {
    return await withPathLock(worktreePath, async () => {
      const gitDir = parentCwd ?? path.resolve(worktreePath, "../..");
      // --force is needed because HMR dev servers commonly modify files or
      // generate build artifacts, leaving the worktree dirty.
      const removeResult = await runGit(gitDir, ["worktree", "remove", "--force", worktreePath]);
      if (removeResult.code !== 0) return false;
      // Prune stale administrative files — idempotent even if nothing to prune.
      await runGit(gitDir, ["worktree", "prune"]);
      return true;
    });
  } finally {
    removingPaths.delete(worktreePath);
  }
}

// ── Task worktree lifecycle (Phase 6's 6.8, issue #283) ───────────────────
// A clean-check-gated, never-`--force` counterpart to `removeWorktree`
// above (locked decision — see the plan's Binding decisions table). Unlike
// a dock-preview worktree, a task worktree can hold real, uncommitted work
// worth preserving, so nothing here ever destroys it silently.
//
// Note on what "clean" protects: `git worktree remove` (without `--force`)
// discards only the worktree's own uncommitted/untracked files — it does
// NOT delete the branch. `refs/heads/<branch>` survives removal and stays
// fully recoverable (re-checkoutable, `git log`-able from the parent repo)
// even for a branch that was never pushed anywhere. That's why the refusal
// gate below checks only `isClean`/`hasConflicts`, not "has unpushed
// commits" (the plan's original sketch): an unpushed-but-committed branch
// isn't actually at risk from a worktree removal, and the naive check for
// it — `ahead > 0` — doesn't even reliably detect it, since a branch with
// no upstream at all (the normal state for a `→ failed` task, which never
// reached the push step) reads `ahead: 0` too (see git-status.ts's
// `# branch.ab` parsing and task-promote.ts's own note on the same gap).

const TASK_WORKTREE_PREFIX = "mullion-task-";

// The exact, closed namespace task-claim.ts's `deriveTaskBranchName` produces
// — never a hand-typed or otherwise-sourced value. See
// clearOrphanedTaskWorktree's own use of this below for why matching it is
// load-bearing, not cosmetic. The `-\d+-` segment is the task id; the
// trailing `(-.+)?` accepts BOTH the new slugged shape
// (`mullion/task-<id>-<slug>`) AND the legacy unslugged form
// (`mullion/task-<id>`) that rows created before this PR's deploy carry on
// disk. Both shapes are still within the closed task-claim namespace
// (neither is user-chosen), so the defense-in-depth argument holds for
// both — and accepting the legacy form is what lets `retryTask` and
// `attemptAutoRebase` resume in-flight failed tasks stranded at deploy
// time (the stored `branchName` is whatever was written at claim, no DB
// migration rewrites it).
const TASK_BRANCH_NAME_RE = /^mullion\/task-\d+(-.+)?$/;

/**
 * The single source of truth for the branch name a Task Master task gets
 * when claimed (task-claim.ts's `enqueueTask` and `dispatchClaimedTask` both
 * call this — never construct the literal by hand). Stamps the slug once at
 * claim time; title edits after claim do NOT rename the branch, since the
 * branch survives the task's `claimed → in_progress → reviewing → done`
 * lifecycle and renaming mid-flight would break the `git worktree add -b`
 * collision-clear logic keyed to the stored `branchName`.
 *
 * Shape: `mullion/task-<id>-<slug>`, where `<slug>` is `task.title` run
 * through `sanitizeRefComponent` (which truncates to 200 chars, replaces
 * anything outside `[A-Za-z0-9_.-]` with `-`, and strips leading/trailing
 * `-`/`.`). The id sits between the namespace and the slug specifically so
 * two tasks titled the same thing under one project still get distinct
 * branches and worktree directories — see `deriveWorktreePath`, which
 * derives the directory from the same branch name, so the uniqueness
 * carries over for free.
 *
 * Pure, synchronous, never throws. Takes only the fields it needs (not the
 * full Drizzle row) so it's trivially testable and decoupled from the
 * schema.
 */
export function deriveTaskBranchName(task: { id: number; title: string }): string {
  // sanitizeRefComponent has its own `"session"` empty-after-sanitize
  // fallback that's wrong for a task branch — we apply the same
  // normalization but with a task-shaped fallback so an all-emoji or
  // all-punctuation title still produces a readable branch.
  const slug = sanitizeRefComponent(task.title);
  const meaningfulSlug = slug === "session" ? "" : slug;
  return `mullion/task-${task.id}-${meaningfulSlug.length > 0 ? meaningfulSlug : "untitled"}`;
}

export interface RemoveIfCleanResult {
  removed: boolean;
  /** Set only when `removed` is false. "not-a-repo" covers both "nothing
   * exists at this path" and "path exists but isn't a git worktree" —
   * both mean there's nothing here for a caller to be blocked by. */
  reason?: "dirty" | "conflicts" | "not-a-repo" | "remove-failed";
}

/**
 * Removes a worktree only when its tree is clean, never `--force`. Refuses
 * on uncommitted changes or unresolved merge conflicts — the one real
 * data-loss risk removal poses (see the section doc comment above for why
 * unpushed-but-committed work is deliberately not a refusal condition).
 * Acquires the same per-path lock as `removeWorktree` (via that function),
 * so this is safe to call concurrently with a sync tick or another removal
 * on the same path.
 */
export async function removeWorktreeIfClean(
  worktreePath: string,
  parentCwd?: string,
): Promise<RemoveIfCleanResult> {
  const status = await getGitStatus(worktreePath, { forceFresh: true });
  if (!status) return { removed: false, reason: "not-a-repo" };
  if (status.hasConflicts) return { removed: false, reason: "conflicts" };
  if (!status.isClean) return { removed: false, reason: "dirty" };
  const removed = await removeWorktree(worktreePath, parentCwd);
  return removed ? { removed: true } : { removed: false, reason: "remove-failed" };
}

export interface CommitWipChangesResult {
  committed: boolean;
  /** Set only when `committed` is false for a reason OTHER than "there was
   * nothing to commit" — a real git failure a caller may want to log. */
  error?: string;
}

/**
 * Salvages uncommitted work in `worktreePath` before it's abandoned (#722's
 * "agent ended its turn with no commits" failure path, task-reconciler.ts) —
 * stages tracked modifications plus untracked-and-not-gitignored files, then
 * commits with `--no-verify`.
 *
 * Deliberately NOT `git add -A`: a blind add would sweep in whatever the
 * repo's own `.gitignore` doesn't cover — a build/test artifact (a
 * `coverage.txt`) or a tool binary a pre-push hook just installed (a
 * `.bin/`) — into a commit meant only to preserve the agent's actual work.
 * `--no-verify` mirrors git-push.ts's own reasoning: a half-finished tree is
 * exactly the state most likely to fail the repo's pre-commit hooks, and
 * this is a machine-made salvage commit, not a contribution — the human
 * decides what to do with it after Retry resumes the branch.
 *
 * No-ops cleanly (`committed: false`, no `error`) when there's nothing to
 * stage — never creates an empty commit. Never throws.
 */
export async function commitWipChanges(
  worktreePath: string,
  message = "wip: agent turn ended with uncommitted changes",
): Promise<CommitWipChangesResult> {
  if (!isSafeAbsolutePath(worktreePath)) return { committed: false, error: "unsafe path" };

  const addTracked = await runGit(worktreePath, ["add", "-u"]);
  if (addTracked.code !== 0) {
    return {
      committed: false,
      error: addTracked.stderr.trim() || `git add -u exited ${addTracked.code}`,
    };
  }

  // `-z`, NUL-separated, not the default newline-separated form (Hermes
  // review, PR #726) — without it, git C-style-quotes any filename
  // containing a tab/newline/control character (e.g. `"tab\tfile.txt"`),
  // and splitting that quoted form on "\n" produces a string `git add --`
  // doesn't match against anything on disk, silently dropping the file from
  // the salvage commit. `-z` emits raw bytes with no quoting, so a literal
  // NUL split recovers the real filename even for those names.
  const lsUntracked = await runGit(worktreePath, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  const untrackedFiles = lsUntracked.stdout.split("\0").filter((entry) => entry.length > 0);
  if (untrackedFiles.length > 0) {
    // `:(literal)` prefix on every entry (independent review, PR #726) — `--`
    // only ends OPTION parsing, it does not disable pathspec MAGIC: a real,
    // on-disk filename that happens to start with `:` (e.g. `:magic.txt`)
    // is otherwise parsed as a magic pathspec prefix and `git add` fails
    // with "did not match any files" (verified empirically) instead of
    // staging it. `:(literal)` forces every entry to be read as a plain,
    // literal path, with no magic/glob interpretation at all — safe for
    // every other filename too, not just this one.
    const addUntracked = await runGit(worktreePath, [
      "add",
      "--",
      ...untrackedFiles.map((file) => `:(literal)${file}`),
    ]);
    if (addUntracked.code !== 0) {
      return {
        committed: false,
        error: addUntracked.stderr.trim() || `git add exited ${addUntracked.code}`,
      };
    }
  }

  const commit = await runGit(worktreePath, ["commit", "--no-verify", "-m", message]);
  if (commit.code === 0) return { committed: true };
  // "nothing to commit, working tree clean" (or the "no changes added"
  // variant) is git's own way of saying the add step above staged nothing —
  // a legitimate no-op, not a failure this caller needs to know about.
  if (/nothing to commit/i.test(commit.stdout) || /nothing to commit/i.test(commit.stderr)) {
    return { committed: false };
  }
  return {
    committed: false,
    error: commit.stderr.trim() || commit.stdout.trim() || `git commit exited ${commit.code}`,
  };
}

// ── User-facing worktree removal (issue #442) ─────────────────────────────
// The GitPanel's manual counterpart to 6.8's task-scoped removal above:
// membership in `listWorktrees(cwd)` is the validity gate, not a path
// prefix (the plan's binding decision #3) — this must remove dock-preview
// worktrees, agent-created ones, and hand-made `git worktree add` ones,
// none of which pass the `mullion-task-` check `pruneWorktrees` uses.

export interface RemoveListedWorktreeResult {
  removed: boolean;
  reason?:
    | "not-listed"
    | "is-main"
    | "dirty"
    | "conflicts"
    | "not-a-repo"
    | "remove-failed"
    | "directory-gone";
}

/**
 * Removes any worktree `git worktree list` itself reports for `cwd` — the
 * validity gate is membership in that list, not a path prefix (see the
 * section doc comment above). Requires membership (`not-listed`) and
 * `!isMain` (`is-main`), then delegates to the EXISTING
 * `removeWorktreeIfClean` (safe path) or `removeWorktree` (force path) —
 * both already hold the per-path lock at the leaf (see the "Per-path
 * serialization" section above), so this must NOT take one itself; locking
 * at two layers self-deadlocks.
 *
 * Under `force`, and only under `force`, checks
 * `findPreviewWorktreeSessionId` first: a live dock-preview session has
 * `sessions.cwd` = the worktree path, so the DB/app.pty-backed live-session
 * guard (routes/projects.ts, which runs before this is ever called) already
 * catches the safe-path case — the gap is force-removing a tracked preview
 * worktree, which would otherwise leave the 5s sync tick (`syncWorktree`)
 * firing `git reset --hard` at a path that no longer exists, indefinitely.
 * On a hit, calls the existing `deletePreviewWorktree(sessionId)` BEFORE
 * removing, so the tick stops referencing that path before it's gone. If
 * the removal itself then fails, the preview entry is re-tracked (Hermes
 * review on PR #505) — otherwise a failed removal would silently and
 * permanently stop the sync tick for a worktree that's still on disk,
 * rather than just skipping this one attempt.
 *
 * A listed entry whose directory is already gone (an out-of-band `rm -rf`,
 * or exactly the state Prune stale exists for) reports `directory-gone`
 * rather than delegating to either removal path (Hermes review on PR #505):
 * the safe path's `getGitStatus` would return `null` for a missing
 * directory, misreporting the unrelated `not-a-repo` reason, and while
 * `git worktree remove --force` on a gone directory happens to succeed
 * silently (verified empirically), that's exactly what
 * `pruneWorktreeMetadata` (`git worktree prune`) already exists to do more
 * explicitly — this points the caller at that instead of two different
 * paths doing the same cleanup under different names.
 *
 * Never throws.
 */
export async function removeListedWorktree(
  cwd: string,
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<RemoveListedWorktreeResult> {
  const worktrees = await listWorktrees(cwd);
  if (!worktrees) return { removed: false, reason: "not-a-repo" };

  const resolvedTarget = path.resolve(worktreePath);
  const entry = worktrees.find((w) => path.resolve(w.path) === resolvedTarget);
  if (!entry) return { removed: false, reason: "not-listed" };
  if (entry.isMain) return { removed: false, reason: "is-main" };
  if (!existsSync(entry.path)) return { removed: false, reason: "directory-gone" };

  if (opts?.force) {
    const sessionId = findPreviewWorktreeSessionId(entry.path);
    const previewInfo = sessionId !== undefined ? getPreviewWorktree(sessionId) : undefined;
    if (sessionId !== undefined) deletePreviewWorktree(sessionId);
    const removed = await removeWorktree(entry.path, cwd);
    if (removed) return { removed: true };
    if (sessionId !== undefined && previewInfo) trackPreviewWorktree(sessionId, previewInfo);
    return { removed: false, reason: "remove-failed" };
  }

  const result = await removeWorktreeIfClean(entry.path, cwd);
  if (result.removed) return { removed: true };
  return { removed: false, reason: result.reason ?? "remove-failed" };
}

/**
 * Clears stale worktree administrative metadata (`git worktree prune`) —
 * NOT `pruneWorktrees` above, which is a task-worktree sweeper that takes an
 * explicit delete-list and actually removes directories. This only clears
 * git's own bookkeeping for a worktree whose directory is already gone
 * (e.g. an `rm -rf` done out of band); it never removes a worktree that
 * still exists on disk. Never throws.
 */
export async function pruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }> {
  if (!isSafeAbsolutePath(cwd)) return { pruned: false };
  const result = await runGit(path.resolve(cwd), ["worktree", "prune"]);
  return { pruned: result.code === 0 };
}

export interface ClearOrphanedTaskWorktreeResult {
  cleared: boolean;
  reason?: string;
}

/**
 * Task-claim-specific orphan clearing (6.8/#283) — see task-claim.ts's own
 * doc comment for the gap this closes: a crashed/failed claim attempt can
 * leave BOTH a worktree directory and its branch ref behind at task-
 * claim.ts's deterministic `mullion/task-<id>-<slug>` path/name, and a retry's
 * `git worktree add -b` collides on whichever half still exists —
 * `removeWorktreeIfClean` alone only clears the directory half; the branch
 * survives it by design (see that function's own doc comment).
 *
 * Deleting the branch here — unlike `removeWorktreeIfClean`, which
 * deliberately preserves a worktree's branch for every OTHER caller (the
 * `→ done`/`→ failed` cleanup paths need that branch to survive; it's what
 * an open PR points at) — is safe specifically for THIS namespace:
 * `mullion/task-<id>-<slug>` branches are only ever created by task-claim.ts
 * itself, for exactly this task id, never user-chosen. A leftover one here
 * means either (a) it's brand new with zero commits — the realistic case,
 * since worktree creation and branch creation are one atomic `git worktree
 * add -b` call, so a leftover from "worktree created, then something after
 * it failed" never had a chance to receive any agent work — or (b) stale
 * work from an already-abandoned prior attempt on this same task, which a
 * fresh claim starts over from `baseRef` regardless of whether the old
 * branch survives; nothing merges an old task-branch's commits into a new
 * claim's worktree.
 *
 * Refuses (leaves both worktree and branch in place) only when the
 * worktree still holds uncommitted changes or conflicts — the one real
 * risk `removeWorktreeIfClean` itself guards against.
 *
 * The branch is deleted ONLY when this call actually found and removed
 * real directory content (a clean worktree, or the non-repo-leftover case
 * below) — never on a bare "nothing at `worktreePath` at all" outcome
 * (independent review, PR #476). That distinction matters: "nothing on
 * disk" is exactly the steady-state left by the `→ failed` lifecycle
 * cleanup (`removeWorktreeIfClean`, called directly from
 * task-reconciler.ts/session-reconciler.ts), which removes the WORKTREE
 * but deliberately preserves the BRANCH so a task's committed-but-unpushed
 * work survives its failure — see that function's own doc comment. Once a
 * future retry path reaches a task in that state (`task-state.ts` already
 * models `failed → ready` as a legal transition, even though nothing in
 * this PR's shipped routes exercises it yet), a bare "clear whatever's
 * named `mullion/task-<id>-<slug>`" here would silently destroy exactly the work
 * that preservation exists to protect. When directory content WAS present
 * (worktree creation and branch creation are one atomic `git worktree add
 * -b` call, so a leftover from "worktree created, then something after it
 * failed before any agent ever ran" provably has zero commits beyond
 * `baseRef`), deleting the branch is safe — see below. When nothing was
 * present but the branch still exists anyway, this refuses instead of
 * either destroying it or reporting false success while a real
 * `git worktree add -b` collision remains for the caller.
 *
 * `removeWorktreeIfClean`'s `"not-a-repo"` reason conflates two cases this
 * function must NOT treat the same: "nothing exists at this path" (truly
 * a no-op) and "a non-empty directory exists here but isn't a git repo" —
 * the shape a `git worktree add` killed mid-flight leaves behind (Hermes
 * review: `git worktree add` creates the branch ref before the directory
 * is a valid worktree, so a kill between those two steps produces exactly
 * this). The latter still blocks a retry's `git worktree add -b` (git
 * refuses a non-empty target directory) even after the branch is cleared —
 * so it's removed directly here, via `fs.rm` rather than any git command
 * (there's no repo here for git to operate on). Safe: confirmed not a git
 * repo, so nothing recoverable can live in it. Re-validated against the
 * same containment `deriveWorktreePath` itself would produce before
 * touching disk, since this bypasses git's own path handling entirely.
 */
export async function clearOrphanedTaskWorktree(
  cwd: string,
  worktreePath: string,
  branchName: string,
): Promise<ClearOrphanedTaskWorktreeResult> {
  const removeResult = await removeWorktreeIfClean(worktreePath, cwd);
  if (!removeResult.removed && removeResult.reason !== "not-a-repo") {
    return { cleared: false, reason: removeResult.reason };
  }

  let directoryWasPresent = removeResult.removed;
  if (removeResult.reason === "not-a-repo") {
    // See the doc comment above for why a leftover non-repo directory
    // still needs clearing here. Containment is validated FIRST, against
    // the resolved path — only that resolved (never the raw) path ever
    // reaches `existsSync`/`rmSync` below.
    const projectRoot = path.resolve(cwd);
    const baseDir = path.join(projectRoot, ".mullion-worktrees");
    const resolvedWorktreePath = path.resolve(worktreePath);
    const contained =
      isSafeAbsolutePath(resolvedWorktreePath) &&
      (resolvedWorktreePath === baseDir || resolvedWorktreePath.startsWith(baseDir + path.sep));
    if (!contained) {
      return { cleared: false, reason: "path outside .mullion-worktrees" };
    }
    // CodeQL's js/path-injection query still flags the two calls below even
    // with the containment check immediately above it — the same "real
    // mitigation, not a recognized sanitizer shape" situation git-status.ts's
    // isGitRepo and git-remote.ts's parseGitRemote already document for this
    // identical query (their guard is the "standard, CodeQL-recognized"
    // shape — `!path.isAbsolute || normalize().includes("..")` — yet
    // git-status.ts's own comment notes CodeQL re-flags it there too).
    // `contained` re-derives that same absolute-path/no-".."-segment check
    // via `isSafeAbsolutePath`, ANDed with an explicit `.mullion-worktrees/`
    // prefix requirement — strictly narrower than the "recognized" shape,
    // not weaker. Dismissed in GHAS as alerts #167 (existsSync below) and
    // #168 (rmSync below) rather than reshaping already-verified-safe code
    // to chase a query that doesn't model manual containment checks as
    // sanitizers. (A `codeql[...]` line comment here would be a real CodeQL
    // suppression annotation, but this repo's codeql.yml has no follow-up
    // step to turn that SARIF suppression into an actual Security-tab
    // dismissal — see dock-config.ts's isSymlinkPath for the fuller note —
    // so the dismissal above happened via the API instead.)
    if (existsSync(resolvedWorktreePath)) {
      directoryWasPresent = true;
      rmSync(resolvedWorktreePath, { recursive: true, force: true });
    }
  }

  // Defense in depth (independent review, PR #476): this function's entire
  // safety argument for deleting a branch rests on `mullion/task-<id>-<slug>`
  // being a namespace ONLY task-claim.ts ever writes into, never
  // user-chosen — enforced here directly rather than trusted from every
  // caller (the internal `/clear-orphan` route's schema only requires
  // non-empty). A `branchName` outside this exact shape is treated the
  // same as "no branch to clear" — never deleted, never blocks completion.
  if (
    !isSafeAbsolutePath(cwd) ||
    branchName.length === 0 ||
    branchName.startsWith("-") ||
    !TASK_BRANCH_NAME_RE.test(branchName)
  ) {
    return { cleared: true };
  }
  const branchExists =
    (
      await runGit(path.resolve(cwd), [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ])
    ).code === 0;
  if (!branchExists) return { cleared: true };
  if (!directoryWasPresent) {
    // See the doc comment above — this branch alone, with no directory
    // content to have justified deleting it, is exactly the shape a
    // successfully-failed task's preserved-on-purpose work leaves behind.
    return {
      cleared: false,
      reason: "stale branch from a prior attempt exists — resolve manually",
    };
  }
  await runGit(path.resolve(cwd), ["branch", "-D", branchName]);
  return { cleared: true };
}

/**
 * #483 — the retry path's resume-on-preserved-branch mechanism: checks out
 * an EXISTING branch into a new worktree at the same deterministic path
 * `deriveWorktreePath`/`createWorktree` would have produced for it
 * (`git worktree add <path> <branch>` — no `-b`, no `--detach`, a REAL
 * branch checkout). Deliberately NOT `checkoutBranchWorktree` above: that
 * function is dock-preview-specific — detached HEAD, `--force`, and a
 * `dock-preview-*` directory name `listTaskWorktreeDirs`/`pruneWorktrees`
 * wouldn't recognize as a task worktree.
 *
 * A task that failed after committing work keeps its `mullion/task-<id>-<slug>`
 * branch on purpose — `removeWorktreeIfClean` (the `→ failed` cleanup path,
 * task-reconciler.ts/session-reconciler.ts) removes only the worktree
 * directory, never the branch (see that function's own doc comment). By
 * the time a retry reaches here, nothing else has touched that branch
 * (`clearOrphanedTaskWorktree` only ever runs at fresh-claim time, on a
 * "ready" task, never on a "failed" one), so it's expected to still exist
 * and no longer be checked out anywhere — worktree removal already freed
 * it. `git worktree add` refuses only if it's checked out elsewhere or the
 * target path already exists; either way this returns `null` rather than
 * forcing past it, since both are unexpected states a human should look at
 * rather than this function silently working around.
 *
 * Restricted to the same closed `mullion/task-<id>-<slug>` namespace
 * `clearOrphanedTaskWorktree` enforces (`TASK_BRANCH_NAME_RE`) — this has
 * no other caller and no reason to check out an arbitrary branch name into
 * a task-shaped path. Returns `null` when `cwd` isn't a git repo, the
 * branch name doesn't match that namespace, or the git call fails; never
 * throws.
 */
export async function resumeTaskWorktree(
  cwd: string,
  branchName: string,
): Promise<WorktreeResult | null> {
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) return null;
  if (!TASK_BRANCH_NAME_RE.test(branchName)) return null;
  const projectRoot = path.resolve(cwd);
  const worktreePath = deriveWorktreePath(projectRoot, branchName);
  if (!isSafeAbsolutePath(worktreePath)) return null;

  const baseDir = path.join(projectRoot, ".mullion-worktrees");
  ensureExcluded(projectRoot, baseDir);

  const result = await runGit(projectRoot, ["worktree", "add", worktreePath, branchName]);
  if (result.code !== 0) return null;
  return { path: worktreePath, branch: branchName };
}

/**
 * Lists this host's on-disk task-worktree directories for `cwd` — absolute
 * paths under `<cwd>/.mullion-worktrees/` whose name starts with
 * `mullion-task-` (the directory naming `deriveWorktreePath` produces for
 * a `mullion/task-<id>-<slug>` branch seed, since `sanitizeRefComponent` collapses
 * the `/` to `-`). Pure filesystem read — never throws, returns `[]` for a
 * missing/unreadable `.mullion-worktrees` directory. Does not distinguish
 * orphan from in-use; that requires cross-referencing task rows, which this
 * module has no DB access to do (see the caller in plugins/task-watcher.ts).
 * Reached on a remote host via `SessionBackend.listTaskWorktreeDirs` →
 * `/internal/git-worktree/task-dirs` (#484) — this function itself never
 * changes; only the local/remote dispatch sits above it.
 *
 * Invariant (Hermes review, PR #476): hardcodes `.mullion-worktrees` rather
 * than accepting `deriveWorktreePath`'s optional `baseDir` override — safe
 * today because task-claim.ts never passes a custom `baseDir` when creating
 * a task worktree (every task worktree lives under the default directory).
 * A future caller that does would produce a worktree invisible to this
 * function (and to `pruneWorktrees`, below, which shares the same
 * assumption) — thread `baseDir` through both if that ever changes.
 */
export function listTaskWorktreeDirs(cwd: string): string[] {
  if (!isSafeAbsolutePath(cwd)) return [];
  const baseDir = path.join(path.resolve(cwd), ".mullion-worktrees");
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(TASK_WORKTREE_PREFIX))
    .map((e) => path.join(baseDir, e.name));
}

export interface PruneWorktreesResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Removes explicitly-named orphan task worktrees under `cwd`, reusing
 * `removeWorktreeIfClean`'s clean-check gate (never `--force` — a dirty
 * orphan is skipped, not destroyed, and stays on disk for a human to look
 * at or a later sweep to retry).
 *
 * `orphanPaths` must be computed by the CALLER by cross-referencing task
 * rows against `listTaskWorktreeDirs`'s output — this function deliberately
 * does not accept just `cwd` and figure out "everything not in some
 * caller-supplied keep-list" on its own. An explicit delete-list means an
 * empty/incomplete list from a caller-side bug is a no-op, not "remove
 * every task worktree on this host"; a keep-list inverts that failure mode
 * into exactly the kind of silent mass-deletion this codebase has been
 * corrupted by before (see git-worktree.ts's own corruption history in
 * CLAUDE.md). Each path is still re-validated here — containment under
 * `<cwd>/.mullion-worktrees/` and the task-worktree naming prefix — as
 * defense in depth against a caller (or, over the remote-host proxy, a
 * malformed request) passing something it shouldn't.
 *
 * Always runs `git worktree prune` first (safe, idempotent — cleans stale
 * administrative refs regardless of what's in `orphanPaths`).
 */
export async function pruneWorktrees(
  cwd: string,
  orphanPaths: string[],
): Promise<PruneWorktreesResult> {
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  if (!isSafeAbsolutePath(cwd)) {
    return { removed, skipped: orphanPaths.map((p) => ({ path: p, reason: "invalid-cwd" })) };
  }
  const projectRoot = path.resolve(cwd);
  await runGit(projectRoot, ["worktree", "prune"]);

  const baseDir = path.join(projectRoot, ".mullion-worktrees");
  for (const p of orphanPaths) {
    const resolved = path.resolve(p);
    if (
      !isSafeAbsolutePath(resolved) ||
      (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep))
    ) {
      skipped.push({ path: p, reason: "outside-worktree-dir" });
      continue;
    }
    if (!path.basename(resolved).startsWith(TASK_WORKTREE_PREFIX)) {
      skipped.push({ path: p, reason: "not-a-task-worktree" });
      continue;
    }
    const result = await removeWorktreeIfClean(resolved, projectRoot);
    if (result.removed) removed.push(resolved);
    else skipped.push({ path: p, reason: result.reason ?? "unknown" });
  }
  return { removed, skipped };
}

/**
 * Syncs a preview worktree to the current tip of a LOCAL branch ref
 * (`git reset --hard refs/heads/<branch>`) — no fetch, no network. This
 * exists to follow commits an agent makes in the primary checkout while a
 * dock monitor previews the same branch elsewhere (see
 * project-config.ts's `worktreeRefresh` doc comment and the Settings label
 * "Refresh worktree on agent commits"); the previous `fetch origin <branch>`
 * + `reset --hard origin/<branch>` required a push to ever see anything,
 * and failed — silently, forever — for any branch with no upstream at all.
 *
 * Safe only because `checkoutBranchWorktree` gives every preview worktree a
 * DETACHED HEAD: resetting a detached HEAD to a local branch ref moves only
 * this worktree's own HEAD, never `refs/heads/<branch>` itself, so whatever
 * other worktree (often the primary checkout) already has that branch
 * checked out is untouched. Serialized against `removeWorktree` on the same
 * path. Returns `true` on success, `false` on failure (including an invalid
 * `branch`, or a removal already in progress on this path).
 */
export async function syncWorktree(worktreePath: string, branch: string): Promise<boolean> {
  if (branch.length === 0 || branch.startsWith("-")) return false;
  return withPathLock(worktreePath, async () => {
    // A removal was requested while this sync sat queued behind another
    // operation on the same path — bail rather than reset files git is
    // about to delete out from under it.
    if (removingPaths.has(worktreePath)) return false;
    const result = await runGit(worktreePath, ["reset", "--hard", `refs/heads/${branch}`]);
    return result.code === 0;
  });
}

/** Returns true when `worktreePath` is under the dock-preview naming
 * convention (e.g. `dock-preview-feature-foo-a1b2c3`), indicating it was
 * auto-created for a dock monitor. */
export function isDockPreviewWorktree(worktreePath: string): boolean {
  return path.basename(worktreePath).startsWith(DOCK_PREVIEW_PREFIX);
}

// ── Preview-worktree tracking ─────────────────────────────────────────────
// Moved here from routes/sessions.ts (PR #341, Claude/Hermes review) so the
// reconciler (a service) doesn't depend on routes — a dependency inversion.

export interface PreviewWorktreeInfo {
  worktreePath: string;
  branch: string;
  worktreeRefresh: boolean;
  parentCwd: string;
  projectId: number;
  // Issue #345 — the host that owns worktreePath's filesystem. Diagnostic
  // only — cleanupPreviewWorktree's own failure log includes it so "local
  // vs. remote" is distinguishable after the fact; routing decisions live
  // entirely in whether `remove`/`sync` below are set, not in this field.
  // Optional so that existing (local-only) test fixtures need no change:
  // production code (sessions.ts) always sets it.
  hostId?: string;
  // Issue #345 — host-routed removal/sync, captured (as closures over a
  // specific FastifyInstance + hostId) at trackPreviewWorktree time by the
  // caller, which has resolveBackend available and this module does not
  // (no DB/FastifyInstance import here — see the module header). Left
  // undefined for a local host: falls back to this module's own
  // removeWorktree/syncWorktree below, preserving today's exact code path
  // for every existing (local) test. Must never reject — an unreachable
  // remote agent has to read as `false` (queues a retry), not as a thrown
  // error escaping into killSession/the reconciler/the sync tick.
  remove?: () => Promise<boolean>;
  sync?: () => Promise<boolean>;
  /** Set when a prior removal attempt (killSession or the reconciler) failed.
   * The sync tick below retries removal for these entries every tick instead
   * of syncing them, until one succeeds — this is what makes
   * `cleanupPreviewWorktree`'s "will retry" claim true rather than aspirational. */
  pendingRemoval?: boolean;
}

// Module-level singletons, refcounted via ensurePreviewSyncTick/
// stopPreviewSyncTick below rather than scoped to a Fastify app instance
// (unlike PtyManager) — every buildApp() in a test run shares this state,
// so one app's onClose must not tear down another app's still-live tick,
// and a test's leftover temp-repo entries must not survive into the next
// test's sweep. See the refcount functions for the actual mechanics.
const previewWorktrees = new Map<number, PreviewWorktreeInfo>();

/** Inflight sync paths — guards against overlapping syncWorktree calls
 * (GIT_TIMEOUT_MS = 15s > SYNC_INTERVAL_MS = 5s). Distinct from the
 * `removingPaths`/`pathOps` lock above: this only prevents the tick from
 * *enqueueing* a duplicate sync on top of one already running; the lock
 * prevents a sync and a removal from *interleaving* on the same path. */
const inflightSyncPaths = new Set<string>();

/** Same guard as `inflightSyncPaths` above, for the `pendingRemoval` retry
 * branch below (Hermes review, this PR — this branch originally had no
 * such guard, unlike the sync branch it sits next to). A remote removal
 * that takes close to GIT_WORKTREE_REQUEST_TIMEOUT_MS (45s,
 * remote-host-client.ts) to fail would otherwise re-fire on every 5s tick,
 * stacking up concurrent `/internal/git-worktree/force-remove` requests to
 * the same path — the agent's own per-path lock (`pathOps`/`removingPaths`
 * above, mirrored server-side by removeWorktree) serializes them so this
 * was never unsafe, just wasteful. Local removal was never affected either
 * (same in-process lock covers it directly), so this is purely about the
 * remote HTTP round trip. */
const inflightRemovalPaths = new Set<string>();

const SYNC_INTERVAL_MS = 5000;
let syncTimer: ReturnType<typeof setInterval> | null = null;

export function trackPreviewWorktree(sessionId: number, info: PreviewWorktreeInfo): void {
  previewWorktrees.set(sessionId, info);
}

export function getPreviewWorktree(sessionId: number): PreviewWorktreeInfo | undefined {
  return previewWorktrees.get(sessionId);
}

export function deletePreviewWorktree(sessionId: number): void {
  previewWorktrees.delete(sessionId);
}

/**
 * Issue #442 — looks up which tracked dock-preview session (if any) owns
 * `worktreePath`, so `removeListedWorktree`'s force path can stop the 5s
 * sync tick (via `deletePreviewWorktree`) BEFORE removing it. Returns
 * `undefined` when no tracked preview matches — the common case for a
 * task/agent/hand-made worktree, which was never registered here at all.
 */
export function findPreviewWorktreeSessionId(worktreePath: string): number | undefined {
  const resolved = path.resolve(worktreePath);
  for (const [sessionId, info] of previewWorktrees) {
    if (path.resolve(info.worktreePath) === resolved) return sessionId;
  }
  return undefined;
}

// Issue #345 — routes removal/sync through a tracked entry's own host-routed
// closure when present (a remote host), falling back to this module's local
// removeWorktree/syncWorktree otherwise (a local host — today's exact
// behavior, unchanged). Centralized here so cleanupPreviewWorktree and the
// tick below don't each re-implement the fallback. The closure's own
// contract (see PreviewWorktreeInfo.remove/sync's doc comment, and
// trackPreviewWorktree's call site in sessions.ts) is to never reject; the
// try/catch here is a defensive backstop only — a violation must not crash
// killSession/the reconciler (cleanupPreviewWorktree has no try/catch of its
// own), same "best-effort, retry next tick" posture as every other failure
// path in this module.
async function previewRemove(info: PreviewWorktreeInfo): Promise<boolean> {
  if (!info.remove) return removeWorktree(info.worktreePath, info.parentCwd);
  try {
    return await info.remove();
  } catch {
    return false;
  }
}

async function previewSync(info: PreviewWorktreeInfo): Promise<boolean> {
  if (!info.sync) return syncWorktree(info.worktreePath, info.branch);
  try {
    return await info.sync();
  } catch {
    return false;
  }
}

function startSyncTick() {
  if (syncTimer !== null) return;
  syncTimer = setInterval(() => {
    for (const [sessionId, info] of previewWorktrees) {
      if (info.pendingRemoval) {
        // A prior removal attempt failed; retry instead of syncing — the
        // session this worktree belonged to is already gone. removeWorktree
        // guards its own path against re-entrancy the same way syncWorktree
        // does below, so it's safe to just fire this every tick until it
        // succeeds. inflightRemovalPaths (Hermes review, this PR) still
        // skips *enqueueing* a duplicate attempt on top of one already in
        // flight — see its own doc comment for why that matters for the
        // remote case specifically.
        if (inflightRemovalPaths.has(info.worktreePath)) continue;
        inflightRemovalPaths.add(info.worktreePath);
        void previewRemove(info)
          .then((removed) => {
            if (removed) previewWorktrees.delete(sessionId);
          })
          .catch(() => {
            // Best-effort: transient failures silently retry on next tick.
            // A host-routed closure logs the reason itself before resolving
            // false (see sessions.ts) — this catch only guards against a
            // closure that broke that contract.
          })
          .finally(() => {
            inflightRemovalPaths.delete(info.worktreePath);
          });
        continue;
      }
      if (!info.worktreeRefresh) continue;
      if (inflightSyncPaths.has(info.worktreePath)) continue;
      inflightSyncPaths.add(info.worktreePath);
      previewSync(info)
        .finally(() => {
          inflightSyncPaths.delete(info.worktreePath);
        })
        .catch(() => {
          // Best-effort: transient failures silently retry on next tick.
        });
    }
  }, SYNC_INTERVAL_MS);
  // B9 — the one interval in this codebase that wasn't `.unref()`'d (every
  // other timer here is — see plugins/pty.ts and pty-manager.ts's
  // attention-eval timer for the same treatment with the same rationale):
  // without this, an unclean teardown (a test that forgets
  // stopPreviewSyncTick, or a process shutdown path that skips onClose)
  // leaves the process alive with this 5s tick still running `git reset
  // --hard` against tracked worktrees indefinitely.
  syncTimer.unref();
}

function stopSyncTick() {
  if (syncTimer === null) return;
  clearInterval(syncTimer);
  syncTimer = null;
}

/**
 * Cleans up a preview worktree by session ID. Called from `killSession`
 * (explicit user kill) and the reconciler (a session that exited on its
 * own), so preview worktrees don't accumulate indefinitely. On failure, the
 * entry is kept and marked `pendingRemoval` so the sync tick above retries
 * it — this is what makes that a real retry rather than dead text. Returns
 * `true` if the worktree was cleaned up or no worktree existed for this
 * session, `false` if removal failed (and was queued for retry).
 */
export async function cleanupPreviewWorktree(
  sessionId: number,
  log?: { warn: (msg: object, ...args: unknown[]) => void },
): Promise<boolean> {
  const info = previewWorktrees.get(sessionId);
  if (!info) return true;
  const removed = await previewRemove(info);
  if (removed) {
    previewWorktrees.delete(sessionId);
    return true;
  } else {
    previewWorktrees.set(sessionId, { ...info, pendingRemoval: true });
    log?.warn(
      { sessionId, worktreePath: info.worktreePath, hostId: info.hostId },
      "failed to remove preview worktree — marked for retry by the sync tick",
    );
    return false;
  }
}

// Refcounted: every buildApp() registers sessionsRoute, which calls this on
// registration and stopPreviewSyncTick() on its own onClose — but the timer
// and tracking maps are module-level singletons shared by every app in the
// process (see previewWorktrees's doc comment). Without the refcount, the
// first app to close would stop the tick for every other still-open app,
// and closing app N would wipe map entries app N+1 still needs. Only the
// last release actually tears anything down.
let syncTickRefs = 0;

export function ensurePreviewSyncTick(): void {
  syncTickRefs += 1;
  startSyncTick();
}

export function stopPreviewSyncTick(): void {
  if (syncTickRefs === 0) return; // defensive: unbalanced stop, never negative
  syncTickRefs -= 1;
  if (syncTickRefs > 0) return;
  stopSyncTick();
  // Only safe to clear once the last app has released — these fully drain
  // (pathOps/removingPaths are already self-clearing and left alone here;
  // clearing removingPaths mid-removal would un-bail a queued sync).
  previewWorktrees.clear();
  inflightSyncPaths.clear();
  inflightRemovalPaths.clear();
}

/** Exported for tests only — whether the sync timer is currently ref'd
 * (i.e. would keep the process alive on its own). Production code never
 * needs this; it exists solely to assert the `.unref()` call in
 * startSyncTick above actually took effect, since `NodeJS.Timeout.hasRef()`
 * is the only way to observe that from outside the timer itself. Returns
 * `null` when no tick is currently running. */
export function syncTimerHasRefForTests(): boolean | null {
  return syncTimer?.hasRef() ?? null;
}
