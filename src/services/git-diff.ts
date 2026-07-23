import { spawn as spawnChild } from "node:child_process";
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

/** Runs `git -C <cwd> diff HEAD --numstat`, capturing stdout on `'close'`.
 * Resolves `null` on any non-zero exit (including the common "unborn HEAD"
 * case — a repo with no commits yet has nothing to diff against), spawn
 * error, or timeout — "git failed" and "nothing to diff" are both just
 * "nothing to show" here, same posture as git-status.ts's runGitStatus. */
function runGitDiffNumstat(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawnChild("git", ["-C", cwd, "diff", "HEAD", "--numstat"], {
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

/** In-memory `{ cwd → { ts, result } }` cache — same shape and TTL as
 * git-status.ts's own, kept as a separate map (not shared with that
 * module's cache) since the two are independent git invocations against
 * the same cwd and either can legitimately be requested without the other. */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { ts: number; result: GitDiffStats | null }>();
const inFlight = new Map<string, Promise<GitDiffStats | null>>();

/**
 * Best-effort diff stats for `cwd`: files changed + insertions/deletions
 * against HEAD, or `null` when `cwd` isn't a git repo, has no commits yet,
 * or `git` itself fails. Never throws. Cached for `CACHE_TTL_MS`. Callers
 * that need to distinguish "not a repo" from "git itself failed" should
 * check `isGitRepo(cwd)` (from git-status.ts) first, same convention as
 * getGitStatus.
 */
export async function getDiffStats(cwd: string): Promise<GitDiffStats | null> {
  if (!isGitRepo(cwd)) return null;

  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }
  const pending = inFlight.get(cwd);
  if (pending) return pending;

  const promise = runGitDiffNumstat(cwd)
    .then((output) => {
      if (output === null) return null;
      const result = parseNumstat(output);
      cache.set(cwd, { ts: Date.now(), result });
      return result;
    })
    .finally(() => {
      inFlight.delete(cwd);
    });
  inFlight.set(cwd, promise);
  return promise;
}

/** Exported for tests only — production never needs to clear this. */
export function clearGitDiffStatsCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
