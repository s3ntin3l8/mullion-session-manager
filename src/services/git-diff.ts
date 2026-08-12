import { spawn as spawnChild, spawnSync } from "node:child_process";
import { gitEnv } from "./git-env.js";
import { isGitRepo } from "./git-status.js";
// GitDiffStats now physically lives in src/shared/types.ts (hand-mirrored
// 1:1 on the frontend — see frontend/src/api.ts's own re-export).
// Re-exported below so every existing backend importer of this module keeps
// working unchanged.
import type { GitDiffStats } from "../shared/types.js";

export type { GitDiffStats };

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

const GIT_TIMEOUT_MS = 5_000;
// B9 — see git-status.ts's identical constant for the full rationale
// (shared across every runGit-shaped helper in this sibling group).
const KILL_ESCALATION_MS = 2_000;

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

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    // B9 — see git-status.ts's runGitStatus for the full rationale on both
    // the escalation and the listener-detach-in-finish shape below.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      finish(null);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    }, GIT_TIMEOUT_MS);

    child.on("error", () => {
      clearKillTimer();
      finish(null);
    });
    child.on("close", (code) => {
      clearKillTimer();
      finish(code === 0 ? stdout : null);
    });
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
const fileDiffInFlight = new Map<string, Promise<string | null>>();

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

// B9 — getFileDiff below previously had no upper bound on patch size: a
// single huge generated diff (a vendored dependency bump, a lockfile
// regen) accumulates an unbounded string, and GIT_TIMEOUT_MS's 5s timeout
// doesn't help — a local `git diff` streams fast, well within that window,
// long before it produces megabytes of output. 2 MiB mirrors the order of
// magnitude this codebase already uses for other single in-memory buffers
// it deliberately bounds (SCROLLBACK_MAX_BYTES in scrollback-buffer.ts is 1 MiB
// per session; the various *_BACKPRESSURE_MAX_BUFFERED_BYTES constants in
// terminal.ts/browser.ts/ws-pipe.ts/task-events.ts are 4 MiB) — large
// enough that no single-file diff a human would actually read through hits
// it, small enough to bound memory against a pathological one.
const FILE_DIFF_MAX_BYTES = 2 * 1024 * 1024;
// parseUnifiedDiff (frontend/src/diffUtils.ts) classifies every line by its
// leading characters and falls through to a plain "context" line for
// anything it doesn't recognize, so appending human-readable text after the
// real patch content renders safely rather than corrupting the diff view.
const FILE_DIFF_TRUNCATED_MARKER =
  "\n\n[diff truncated: exceeds 2 MiB, showing the first part only]\n";

/** Best-effort unified diff for a single file against HEAD (or
 * `<baseRef>...HEAD` when `baseRef` is set). Returns the raw patch text or
 * `null` on any failure (not a repo, missing file, git error, timeout).
 * Truncated with a trailing marker (see FILE_DIFF_TRUNCATED_MARKER) once the
 * accumulated patch exceeds FILE_DIFF_MAX_BYTES, rather than buffering the
 * whole thing. Never throws. Cache-deliberately absent — this is a
 * user-click-triggered fetch (not a poll loop), and the patch is inherently
 * single-use.
 */
export async function getFileDiff(
  cwd: string,
  filePath: string,
  baseRef?: string,
): Promise<string | null> {
  if (!isGitRepo(cwd)) return null;

  const key = baseRef ? `${cwd}\0${filePath}\0${baseRef}` : `${cwd}\0${filePath}`;
  const pending = fileDiffInFlight.get(key);
  if (pending) return pending;

  const promise = new Promise<string | null>((resolve) => {
    let stdout = "";
    let settled = false;
    const args = baseRef
      ? ["-C", cwd, "diff", `${baseRef}...HEAD`, "--", filePath]
      : ["-C", cwd, "diff", "HEAD", "--", filePath];
    const child = spawnChild("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });

    // B9 — see git-status.ts's runGitStatus for the full rationale on the
    // escalation/listener-detach shape shared with this file's sibling
    // runGitDiffNumstat above.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    const killWithEscalation = () => {
      child.kill(); // SIGTERM
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    let stdoutBytes = 0;
    const onStdoutData = (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > FILE_DIFF_MAX_BYTES) {
        // B9 — stop accumulating and end the process rather than let a huge
        // diff keep growing `stdout`; return only what's been buffered so
        // far plus the marker, not the full (unbounded) patch.
        killWithEscalation();
        finish(stdout + FILE_DIFF_TRUNCATED_MARKER);
        return;
      }
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    const timer = setTimeout(() => {
      killWithEscalation();
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.on("error", () => {
      clearKillTimer();
      finish(null);
    });
    child.on("close", (code) => {
      clearKillTimer();
      // git diff exit codes: 0 = no differences found, 1 = differences
      // found, >1 = error. Either 0 or 1 is valid — stdout content is the
      // patch in both cases (empty when exit 0, populated when exit 1).
      finish(code != null && code <= 1 ? stdout || null : null);
    });
  }).finally(() => {
    fileDiffInFlight.delete(key);
  });

  fileDiffInFlight.set(key, promise);
  return promise;
}

/** Exported for tests only — production never needs to clear this. */
export function clearGitDiffStatsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  fileDiffInFlight.clear();
}
