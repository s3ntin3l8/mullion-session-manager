import { spawn as spawnChild, spawnSync } from "node:child_process";
import { gitEnv } from "./git-env.js";
import { isGitRepo } from "./git-status.js";

// Diff stats (issue #202, greenfield) — a session's own "how much has
// changed here" number, distinct from git-status.ts's per-file list: this
// runs `git diff HEAD --numstat`, which folds staged and unstaged changes
// against the last commit into one files-changed + insertions/deletions
// count, the same shape a GitHub PR's own "+123 -45" summary shows. Same
// conventions as git-status.ts throughout: `spawn` with an argv array
// (never a shell string), `gitEnv()` on every invocation (the #205 env-leak
// rule), stdout captured on `'close'` (not `'exit'` — see git-status.ts's
// own comment on that race), best-effort and never throws, 5s in-memory
// cache keyed by cwd.
//
// Deliberately scoped to tracked changes only (what `git diff` itself
// covers) — untracked ("?") files are already surfaced via git-status.ts's
// own per-file list; duplicating that count into insertions/deletions here
// would require reading and line-counting each untracked file's full
// contents, a much heavier operation for a number this feature only ever
// uses as a rough "how much has changed" glance.

export interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const GIT_TIMEOUT_MS = 5_000;

/** Runs `git -C <cwd> diff [baseRef]...HEAD --numstat`, capturing stdout on
 * `'close'`. When `baseRef` is provided, diffs the branch's work vs that base
 * (e.g. `origin/main`) instead of vs HEAD alone (uncommitted changes only).
 * Resolves `null` on any non-zero exit (including the common "unborn HEAD"
 * case — a repo with no commits yet has nothing to diff against), spawn
 * error, or timeout — "git failed" and "nothing to diff" are both just
 * "nothing to show" here, same posture as git-status.ts's runGitStatus. */
function runGitDiffNumstat(cwd: string, baseRef?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const args = baseRef
      ? ["-C", cwd, "diff", `${baseRef}...HEAD`, "--numstat"]
      : ["-C", cwd, "diff", "HEAD", "--numstat"];
    const child = spawnChild("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
  });
}

// `--numstat` line shape: "<insertions>\t<deletions>\t<path>", or
// "-\t-\t<path>" for a binary file (no line-based insert/delete count) —
// still counts toward filesChanged, just contributes 0 to insertions/
// deletions, same as GitHub's own PR diff summary treats a binary file.
function parseNumstat(output: string): GitDiffStats {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const [added, removed] = line.split("\t");
    filesChanged++;
    if (added !== "-") insertions += Number(added) || 0;
    if (removed !== "-") deletions += Number(removed) || 0;
  }
  return { filesChanged, insertions, deletions };
}

/** Resolve the default base ref for a git working tree: the remote's HEAD
 * branch (`origin/main`, `origin/master`, etc), or `null` when no remote
 * tracking refs exist yet (unfetched repo, no origin remote). Never throws.
 *
 * Resolution order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — authoritative default
 *   2. `git rev-parse --verify origin/main` — common convention fallback
 *   3. `git rev-parse --verify origin/master` — legacy convention fallback
 *   4. `null` — no remote tracking data at all
 *
 * Only called when the route receives the `base=AUTO` sentinel — not on
 * every diff-stats tick. Caching is unnecessary: the diff-stats endpoint
 * itself has a 5s TTL, so this runs at most once per tick per cwd. */
export function getDefaultBaseRef(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;

  const tryRef = (ref: string): string | null => {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", ref], {
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
    return result.status === 0 && result.stdout ? ref : null;
  };

  // Step 1: symbolic-ref gives us the authoritative default (e.g.,
  // "refs/remotes/origin/main" → "origin/main" after stripping prefix).
  const sym = spawnSync("git", ["-C", cwd, "symbolic-ref", "refs/remotes/origin/HEAD"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
  if (sym.status === 0 && sym.stdout) {
    const match = sym.stdout.toString("utf8").match(/^refs\/remotes\/(.+)$/m);
    if (match) return match[1];
  }

  // Steps 2-3: fallback checks for common branch names.
  return tryRef("origin/main") ?? tryRef("origin/master") ?? null;
}

/** In-memory `{ cwd → { ts, result } }` cache — same shape and TTL as
 * git-status.ts's own, kept as a separate map (not shared with that
 * module's cache) since the two are independent git invocations against
 * the same cwd and either can legitimately be requested without the other. */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { ts: number; result: GitDiffStats | null }>();
const inFlight = new Map<string, Promise<GitDiffStats | null>>();

/**
 * Best-effort diff stats for `cwd`: files changed + insertions/deletions
 * against HEAD (or against `<baseRef>...HEAD` when `baseRef` is set), or
 * `null` when `cwd` isn't a git repo, has no commits yet, or `git` itself
 * fails. Never throws. Cached for `CACHE_TTL_MS` with a compound key
 * `(cwd, baseRef)` — the cache differentiates between base and no-base
 * lookups, preventing cross-contamination.
 */
export async function getDiffStats(cwd: string, baseRef?: string): Promise<GitDiffStats | null> {
  if (!isGitRepo(cwd)) return null;

  const cacheKey = baseRef ? `${cwd}\0${baseRef}` : cwd;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const promise = runGitDiffNumstat(cwd, baseRef)
    .then((output) => {
      if (output === null) return null;
      const result = parseNumstat(output);
      cache.set(cacheKey, { ts: Date.now(), result });
      return result;
    })
    .finally(() => {
      inFlight.delete(cacheKey);
    });
  inFlight.set(cacheKey, promise);
  return promise;
}

/** Best-effort unified diff for a single file against HEAD (or
 * `<baseRef>...HEAD` when `baseRef` is set). Returns the raw patch text or
 * `null` on any failure (not a repo, missing file, git error, timeout).
 * Never throws. Cache-deliberately absent — this is a user-click-triggered
 * fetch (not a poll loop), and the patch is inherently single-use.
 */
export async function getFileDiff(
  cwd: string,
  filePath: string,
  baseRef?: string,
): Promise<string | null> {
  if (!isGitRepo(cwd)) return null;

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const args = baseRef
      ? ["-C", cwd, "diff", `${baseRef}...HEAD`, "--", filePath]
      : ["-C", cwd, "diff", "HEAD", "--", filePath];
    const child = spawnChild("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      // Exit 0 = diff produced (even if empty — no changes to show).
      // Exit 1 = no diff (clean file, or better: `git diff` exits 1 when
      // there are no changes at all for the given path). Either way, the
      // stdout content is the patch.
      finish(code != null && code <= 1 ? stdout || null : null);
    });
  });
}

/** Exported for tests only — production never needs to clear this. */
export function clearGitDiffStatsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
