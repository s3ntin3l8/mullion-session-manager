import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getGitStatus } from "./git-status.js";

// Git worktree isolation (issue #100) — gives each parallel session its own
// working directory (files/index/HEAD) off the same repo, so two agents on
// one project never collide. Same conventions as git-status.ts: argv-array
// `spawn` (never a shell string), stdout/stderr captured on `'close'` (not
// `'exit'` — see git-status.ts's own comment on that race), best-effort and
// never throws — a worktree operation that fails just means "worktree mode
// didn't apply this time," not a hard error for the caller.
//
// Branch-per-session, never `--detach` (locked decision, see the PR plan):
// `git worktree add -b <branch>` leaves the session's commits reachable from
// a ref that survives `git worktree remove` — `--detach` would leave them
// reachable only from the worktree's own HEAD, which `worktree remove`
// discards outright, silently destroying committed work in exactly the
// "session succeeded and committed" case "remove only if clean" exists to
// protect.

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

// Same absolute-path + no-".."-segment guard as git-status.ts/git-branch.ts —
// every cwd/baseDir/worktreePath this module touches is always an
// already-resolved project cwd, an already-trusted settings value
// (routes/sessions.ts, same trust tier as project.cwd itself — see
// routes/internal.ts's own note that a session's cwd isn't scoped to
// PROJECTS_ROOTS either, since spawning is already fully gated by the
// caller's own authentication), or an agent-side value already passed
// through resolveWithinRoots (routes/internal.ts's gitWorktreeCreateSchema/
// gitWorktreeRemoveSchema handlers), never a raw, unauthenticated request
// value. CodeQL's js/path-injection and js/http-to-file-access queries don't
// recognize this guard (called by the caller, immediately before every sink
// below) as breaking that taint and flag the existsSync/readFileSync/
// appendFileSync/spawn calls in this file regardless — the same "real
// mitigation, not a recognized sanitizer shape" situation already dismissed
// on git-remote.ts's identical guard (alerts #12/#13) and git-status.ts's
// (PR #149); dismiss any equivalent alert here the same way rather than
// reshaping working, already-reviewed code to satisfy the tool.
function isSafeAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && !path.normalize(p).split(path.sep).includes("..");
}

// A branch component only ever needs to be human-recognizable (the tab
// label), not a full copy of an arbitrarily long input — `projectName` and
// `prefix` reach this from an authenticated caller's own settings/DB row
// (routes/sessions.ts) or, for a remote host, an ajv-validated but
// length-unbounded request body field (routes/internal.ts's
// gitWorktreeCreateSchema has no maxLength). Truncating up front bounds the
// three regex passes below to a fixed-size input regardless of what the
// caller sent — the standard, CodeQL-recognized mitigation for its
// js/polynomial-redos query, and cheap insurance even though none of these
// three patterns actually exhibit super-linear behavior (verified directly:
// a 5,000,000-character run of "-" sanitizes in single-digit milliseconds).
const MAX_REF_COMPONENT_LENGTH = 200;

// git ref names reject a fair number of characters (space, ~^:?*[\, a
// leading/trailing "/", "..", a trailing ".lock", ending in "."). Rather than
// reimplement `git check-ref-format`, collapse anything outside a
// conservative safe set down to "-" — a cosmetically-mangled branch name is
// fine; a `git worktree add -b` that fails to parse its own generated branch
// argument (or, worse, one that some future git version interprets as a
// flag) is not.
function sanitizeRefComponent(value: string): string {
  const cleaned = value
    .slice(0, MAX_REF_COMPONENT_LENGTH)
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "session";
}

function buildBranchName(prefix: string, projectName: string, sessionId: string): string {
  const expanded = prefix
    .replaceAll("{project}", sanitizeRefComponent(projectName))
    .replaceAll("{id}", sanitizeRefComponent(sessionId));
  // Split on "/" and sanitize each path segment separately so a template
  // like "tessera/{project}-{id}" keeps its intended namespacing slash
  // rather than having the whole string collapsed into one dash-joined blob.
  const segments = expanded
    .split("/")
    .map((segment) => sanitizeRefComponent(segment))
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments.join("/") : `tessera/${sessionId}`;
}

/** Idempotently adds `baseDir` (relative to `cwd`) to `.git/info/exclude` so
 * a nested worktree directory never shows up as untracked in the parent
 * repo's own `git status` — flipping PR 1's sidebar dirty dot for every
 * project with worktree mode on would defeat that feature. A no-op when
 * `baseDir` isn't actually nested under `cwd` (a user-configured
 * `worktreeDir` pointing elsewhere needs no exclusion) or when
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
    // dirty dot may flip until it's fixed manually; the worktree itself
    // still gets created below.
  }
}

export interface CreateWorktreeOptions {
  /** The parent repo's working directory. */
  cwd: string;
  /** Used to expand the `{project}` token in `prefix`. */
  projectName: string;
  /** Used to expand the `{id}` token in `prefix`, and as the worktree's own
   * directory name under `baseDir`. */
  sessionId: string;
  /** Branch-name template, e.g. `"tessera/{project}-{id}"`. */
  prefix: string;
  /** Base directory worktrees are created under. Defaults to
   * `<cwd>/.tessera-worktrees`. */
  baseDir?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
}

/**
 * Creates a new worktree off `cwd` on a fresh branch (`git worktree add -b
 * <branch> <path>`, never `--detach` — see the module doc comment). Returns
 * `null` when `cwd` isn't a git repo or the `git worktree add` call fails;
 * never throws.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeResult | null> {
  const { cwd, projectName, sessionId, prefix } = opts;
  if (!isSafeAbsolutePath(cwd)) return null;
  if (!existsSync(path.join(cwd, ".git"))) return null;

  const baseDir =
    opts.baseDir && opts.baseDir.length > 0 ? opts.baseDir : path.join(cwd, ".tessera-worktrees");
  if (!isSafeAbsolutePath(baseDir)) return null;

  const worktreePath = path.join(baseDir, sanitizeRefComponent(sessionId));
  const branch = buildBranchName(prefix, projectName, sessionId);

  ensureExcluded(cwd, baseDir);

  const result = await runGit(cwd, ["worktree", "add", "-b", branch, worktreePath]);
  if (result.code !== 0) return null;
  return { path: worktreePath, branch };
}

export interface RemoveWorktreeOptions {
  /** The parent repo's working directory (worktree operations run there). */
  cwd: string;
  worktreePath: string;
}

/**
 * Removes a worktree, but only when it's clean — reuses git-status.ts's
 * `getGitStatus` (the same cleanliness check PR 1's sidebar dot is built on)
 * rather than `--force`, so a session that ended with uncommitted work never
 * loses it. A dirty worktree, or one whose status can't be determined, is
 * left on disk for manual cleanup. Idempotent — a worktree that's already
 * gone (or was never a real worktree) is treated as success. Never removes
 * the branch ref itself, since that's what keeps any committed work
 * reachable after the worktree directory is gone. Never throws.
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { cwd, worktreePath } = opts;
  if (!isSafeAbsolutePath(cwd) || !isSafeAbsolutePath(worktreePath)) return;
  if (!existsSync(worktreePath)) return;

  const status = await getGitStatus(worktreePath);
  if (!status || !status.isClean) return;

  await runGit(cwd, ["worktree", "remove", worktreePath]);
  // A non-zero exit here (e.g. a race where the worktree was dirtied between
  // the status check above and this call) just leaves it on disk — the same
  // "leave it for manual cleanup" outcome as never having attempted removal,
  // not an error worth surfacing.
}

/** Metadata-only cleanup (`git worktree prune`) for worktree directories
 * that no longer exist on disk (e.g. removed out-of-band, or left behind by
 * a crash mid-remove) — run once on boot (see plugins/pty.ts). Never throws. */
export async function pruneOrphans(cwd: string): Promise<void> {
  if (!isSafeAbsolutePath(cwd)) return;
  if (!existsSync(path.join(cwd, ".git"))) return;
  await runGit(cwd, ["worktree", "prune"]);
}
