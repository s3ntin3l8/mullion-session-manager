import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { gitEnv } from "./git-env.js";

// Worktree *creation* (issue #271) — the missing half of git-refs.ts's
// read-only listWorktrees()/listBranches(). Mullion shipped and removed
// eager, session-insert-time worktree creation once already (PR #152 ->
// #197, resolving #162: it went stale on idle sessions and session reuse).
// This intentionally resurrects only the create primitive, at the narrower
// scope #162's postmortem calls for — creation coupled to the moment work
// actually starts (a launcher toggle or an explicit promote action, never
// eagerly), and create-only: no remove/prune/reconciler here (that's Phase
// 6's 6.8). Every git call below routes through gitEnv() (issue #205) —
// the original version predated that fix and leaked hook-scoped GIT_* env
// into its `git -C <cwd>` calls; reintroducing that here would reopen the
// exact corruption class #205 fixed.
//
// Branch-per-worktree, never `--detach` (locked decision, carried over from
// the original): `git worktree add -b <branch>` leaves the work reachable
// from a ref that survives `git worktree remove` — `--detach` would leave
// it reachable only from the worktree's own HEAD, discarded outright by a
// future removal.

const GIT_TIMEOUT_MS = 15_000;

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

// Same absolute-path + no-".."-segment guard as git-refs.ts/git-status.ts —
// every cwd/baseDir/worktreePath this module touches is always an
// already-resolved project cwd (routes/sessions.ts, same trust tier as
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

/**
 * Creates a new worktree off `cwd`, branched from `baseRef`, on a fresh
 * branch (`git worktree add -b <branch> <path> <baseRef>`, never `--detach`
 * — see the module doc comment). Returns `null` when `cwd` isn't a git
 * repo, `baseRef` doesn't resolve, or the `git worktree add` call fails;
 * never throws.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeResult | null> {
  const { cwd, baseRef, seed } = opts;
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) return null;
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
  if (baseRef.length === 0 || baseRef.startsWith("-")) return null;

  const baseDir =
    opts.baseDir && opts.baseDir.length > 0
      ? opts.baseDir
      : path.join(projectRoot, ".mullion-worktrees");
  if (!isSafeAbsolutePath(baseDir)) return null;

  const dirName = sanitizeRefComponent(seed);
  const worktreePath = path.join(baseDir, dirName);
  const branch =
    opts.branchName && opts.branchName.length > 0
      ? opts.branchName
          .split("/")
          .map((segment) => sanitizeRefComponent(segment))
          .filter((segment) => segment.length > 0)
          .join("/") || `mullion/${dirName}`
      : `mullion/${dirName}`;

  ensureExcluded(projectRoot, baseDir);

  const result = await runGit(projectRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    baseRef,
  ]);
  if (result.code !== 0) return null;
  return { path: worktreePath, branch };
}

const DOCK_PREVIEW_PREFIX = "dock-preview-";

/**
 * Checks out an existing branch in a new worktree (`git worktree add --force
 * <path> <branch>`). Uses `--force` because the branch is typically checked
 * out in the main repo already. The worktree is created under
 * `.mullion-worktrees/dock-preview-<sanitized-branch>/` so it can be
 * identified for cleanup. Returns `null` when `cwd` isn't a git repo, the
 * branch doesn't resolve, or the git call fails; never throws.
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

  const result = await runGit(projectRoot, ["worktree", "add", "--force", worktreePath, branch]);
  if (result.code !== 0) return null;
  return { path: worktreePath, branch };
}

/**
 * Removes a worktree at `worktreePath` via `git worktree remove --force`.
 * Runs `git worktree prune` from the parent repo's directory afterwards.
 * Returns `true` if the removal succeeded, `false` on failure.
 */
export async function removeWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
  const gitDir = parentCwd ?? path.resolve(worktreePath, "../..");
  // --force is needed because HMR dev servers commonly modify files or
  // generate build artifacts, leaving the worktree dirty.
  const removeResult = await runGit(gitDir, ["worktree", "remove", "--force", worktreePath]);
  if (removeResult.code !== 0) return false;
  // Prune stale administrative files — idempotent even if nothing to prune.
  await runGit(gitDir, ["worktree", "prune"]);
  return true;
}

/**
 * Syncs a preview worktree to the latest state of a branch by fetching from
 * origin and then running `git reset --hard <branch>`. Returns `true` on
 * success, `false` on failure.
 */
export async function syncWorktree(worktreePath: string, branch: string): Promise<boolean> {
  // Fetch first so remote pushes (CI, another developer) are visible.
  // Best-effort: a transient fetch failure (network, stale remote) shouldn't
  // prevent the reset from still syncing to the local tracking ref.
  await runGit(worktreePath, ["fetch", "origin", branch]);
  const result = await runGit(worktreePath, ["reset", "--hard", `origin/${branch}`]);
  return result.code === 0;
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
}

const previewWorktrees = new Map<number, PreviewWorktreeInfo>();

/** Inflight sync paths — guards against overlapping syncWorktree calls
 * (GIT_TIMEOUT_MS = 15s > SYNC_INTERVAL_MS = 5s). */
const inflightSyncPaths = new Set<string>();

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

function startSyncTick() {
  if (syncTimer !== null) return;
  syncTimer = setInterval(() => {
    for (const [, info] of previewWorktrees) {
      if (!info.worktreeRefresh) continue;
      if (inflightSyncPaths.has(info.worktreePath)) continue;
      inflightSyncPaths.add(info.worktreePath);
      syncWorktree(info.worktreePath, info.branch)
        .finally(() => {
          inflightSyncPaths.delete(info.worktreePath);
        })
        .catch(() => {
          // Best-effort: transient failures silently retry on next tick.
        });
    }
  }, SYNC_INTERVAL_MS);
}

function stopSyncTick() {
  if (syncTimer === null) return;
  clearInterval(syncTimer);
  syncTimer = null;
}

/**
 * Cleans up a preview worktree by session ID. Called from the reconciler
 * when a session exits naturally (program exit, crash) so preview worktrees
 * don't accumulate indefinitely. Best-effort: failures are logged by the
 * caller and won't prevent reconcile from marking the session as exited.
 */
export async function cleanupPreviewWorktree(
  sessionId: number,
  log?: { warn: (msg: object, ...args: unknown[]) => void },
): Promise<void> {
  const info = previewWorktrees.get(sessionId);
  if (!info) return;
  const removed = await removeWorktree(info.worktreePath, info.parentCwd);
  if (removed) {
    previewWorktrees.delete(sessionId);
  } else {
    log?.warn(
      { sessionId, worktreePath: info.worktreePath },
      "failed to remove preview worktree — will retry on next reconciler sweep",
    );
  }
}

// Called by sessionsRoute to start the tick once on first route registration.
export function ensurePreviewSyncTick(): void {
  startSyncTick();
}

// Called by the Fastify plugin system (or server shutdown) to stop the tick.
export function stopPreviewSyncTick(): void {
  stopSyncTick();
}
