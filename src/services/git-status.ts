import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// The repo's first `git` CLI shell-out (issue #76) — everything else that
// reads git state (git-remote.ts, git-branch.ts) is a pure filesystem read.
// `git status` genuinely needs git's own index/ignore-rule handling (a
// worktree, a submodule, a repo with a non-default `.git` layout — git
// itself resolves a worktree checkout's `.git`-file redirect correctly,
// unlike a hand-rolled fs parse, which is exactly why git-branch.ts's own
// readGitBranch deliberately does NOT follow that redirect), so this can't
// follow those files' no-shell-out discipline. It still follows their
// *posture*: best-effort, never throws, a missing/non-repo cwd is exactly
// "nothing to show" (null), not an error.
//
// Always invoked with an argv array (`spawn`, never a shell string) — see
// routes/internal.ts's own comment on why: "spawn/stop always use an argv
// array, never a shell string" is this repo's standing injection guard for
// every child_process call, not just PtyManager's.

export type GitFileStatusCode = "M" | "A" | "D" | "U" | "?";

export interface GitFileStatus {
  path: string;
  status: GitFileStatusCode;
}

export interface GitStatus {
  branch: string;
  hash: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  isClean: boolean;
  hasConflicts: boolean;
}

const GIT_TIMEOUT_MS = 5_000;

// git honors GIT_DIR/GIT_WORK_TREE (and friends) *before* it ever looks at
// `-C <cwd>` — if this process inherited one of these (e.g. from a git hook
// that spawned it without clearing its own hook-scoped environment; observed
// happening to `npm test` under pre-commit's pre-push stage), every call
// below would silently target whatever repo GIT_DIR points at instead of the
// caller's actual `cwd`, regardless of the explicit `-C` flag. Stripping them
// here is what makes `-C cwd` actually authoritative.
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_CEILING_DIRECTORIES;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_PREFIX;
  return env;
}

/** Runs `git -C <cwd> status --porcelain=v2 --branch`, capturing stdout on
 * `'close'` (not `'exit'`) — the same stdout-delivery race documented in
 * pty-manager.ts's isMasterAlive and agent-detect.ts's probe(): `'exit'`
 * only guarantees the process ended, not that every stdout chunk has been
 * delivered. Resolves `null` on any non-zero exit, spawn error, or timeout
 * — "git failed" and "not a git repo" are both just "nothing to show" here.
 *
 * Captures stderr (unlike the original version of this function, which
 * discarded it) purely for the `console.debug` below — a repo whose `.git`
 * exists but whose `git status` still fails transiently (e.g. `.git/index
 * .lock` contention from a concurrent git operation) previously failed
 * silently, with nothing to root-cause the ~10s-periodic failures users saw
 * in the sidebar/GitPanel. Same capture shape as git-worktree.ts's own
 * `runGit`. */
function runGitStatus(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnChild("git", ["-C", cwd, "status", "--porcelain=v2", "--branch"], {
      stdio: ["ignore", "pipe", "pipe"],
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
      console.debug("[git-status] git status timed out", { cwd, timeoutMs: GIT_TIMEOUT_MS });
      finish(null);
    }, GIT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      console.debug("[git-status] git status spawn error", { cwd, err: String(err) });
      finish(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        console.debug("[git-status] git status exited non-zero", {
          cwd,
          code,
          stderr: stderr.trim(),
        });
      }
      finish(code === 0 ? stdout : null);
    });
  });
}

// `--porcelain=v2 --branch` line shapes:
//   # branch.oid <sha>|(initial)
//   # branch.head <name>|(detached)
//   # branch.upstream <upstream>        (only when an upstream is set)
//   # branch.ab +<ahead> -<behind>      (only when an upstream is set)
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              (ordinary)
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>\t<orig>  (rename/copy)
//   u <XY> <sub> <m1> <m2> <m3> <mW> <hH> <hI> <hM> <path>    (unmerged)
//   ? <path>                                                   (untracked)
//   ! <path>                                                   (ignored — not emitted without --ignored)
function parsePorcelainV2(output: string): GitStatus {
  let branch = "HEAD";
  let hash: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  let hasConflicts = false;

  for (const line of output.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      hash = oid === "(initial)" ? null : oid.slice(0, 7);
    } else if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // split(" ")+slice+join reconstructs a path containing single spaces
      // correctly, but collapses any *consecutive* spaces in a real
      // filename down to one — an edge case rare enough (and only ever
      // cosmetic, degrading the displayed path rather than misattributing
      // it to the wrong file) not to warrant a porcelain-v2-aware
      // fixed-column extractor here (Hermes review, PR #149).
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = line.startsWith("2 ")
        ? (line.split("\t")[0]?.split(" ").slice(9).join(" ") ?? "")
        : (fields.slice(8).join(" ") ?? "");
      files.push({ path: filePath, status: classifyXY(xy) });
    } else if (line.startsWith("u ")) {
      hasConflicts = true;
      const fields = line.split(" ");
      files.push({ path: fields.slice(10).join(" "), status: "U" });
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), status: "?" });
    }
  }

  // Detached HEAD: `branch.head` is the literal string "(detached)" rather
  // than a name — fall back to the short oid, matching git-branch.ts's own
  // short-SHA convention for a detached checkout.
  if (branch === "(detached)") branch = hash ?? "HEAD";

  return {
    branch,
    hash,
    ahead,
    behind,
    files,
    isClean: files.length === 0,
    hasConflicts,
  };
}

/** Collapses a two-char XY status code (staged, worktree) down to this
 * feature's simplified single-code taxonomy — prefers the worktree half
 * when both are set (that's the state most visibly "still needs attention"
 * to a user glancing at a badge), falls back to the staged half otherwise. */
function classifyXY(xy: string): GitFileStatusCode {
  const [staged, worktree] = [xy[0] ?? ".", xy[1] ?? "."];
  const active = worktree !== "." ? worktree : staged;
  switch (active) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "M":
    case "R":
    case "C":
    case "T":
      return "M";
    default:
      // Deliberate catch-all, not just the M/R/C/T set above: git's own XY
      // vocabulary for an ordinary changed entry ("1"/"2" line) is a closed
      // set today, but a future git version adding a new code here should
      // degrade to "modified" rather than this function throwing or a file
      // silently vanishing from the list (Hermes review, PR #149).
      return "M";
  }
}

/** In-memory `{ cwd → { ts, result } }` cache, mirroring
 * remote-host-client.ts's bulkLiveStatus cache shape — a ~5s TTL (issue
 * #76, raised from 3s in #166 to span the frontend's 4s live-refresh
 * interval so the batch endpoint and an open GitPanel don't each pay for
 * their own `git status` shell-out on every tick). Concurrent misses on
 * the same cwd (a poll tick landing mid-flight of another caller's
 * request) share one child process rather than each spawning their own,
 * same as bulkLiveStatus's in-flight dedup. */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { ts: number; result: GitStatus | null }>();
const inFlight = new Map<string, Promise<GitStatus | null>>();

/**
 * Cheap, synchronous "is this a git repo" check — the same absolute-path +
 * no-".."-segment guard as `getGitStatus` below, plus the `.git` existence
 * check it already did internally, now exposed so callers (the
 * `/api/projects/:id/git-status` route and its `/internal/git-status`
 * remote-host twin) can tell "not a repo" (durable — no point ever calling
 * `getGitStatus` here) apart from "repo exists but `git status` itself
 * failed" (transient — the caller should treat a `null` result as
 * "unavailable right now", not "nothing to show"). Never throws.
 *
 * `cwd` here carries the exact same trust guarantee as `getGitStatus`'s own
 * (an already-resolved project cwd or an agent-side value already passed
 * through `resolveWithinRoots`, never a raw request value) — this function
 * simply extracted the guard+existence-check `getGitStatus` already did
 * inline, so it inherits that guarantee rather than introducing a new one.
 * CodeQL's js/path-injection query re-flags the `existsSync` call below at
 * this new location regardless (alert #48) — the same "real mitigation, not
 * a recognized sanitizer shape" situation already dismissed on this guard's
 * prior locations (git-remote.ts's identical guard, alerts #12/#13; this
 * file's own pre-extraction inline check, PR #106/#111's precedent); dismiss
 * this one the same way rather than reshaping working, already-reviewed
 * code to satisfy the tool.
 */
export function isGitRepo(cwd: string): boolean {
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) {
    return false;
  }
  return existsSync(path.join(cwd, ".git"));
}

/**
 * Best-effort git status for `cwd`: branch, short hash, ahead/behind vs.
 * upstream, per-file status, and clean/conflict flags — or `null` when
 * `cwd` isn't a git repo (or `git` itself fails). Never throws. Cached for
 * `CACHE_TTL_MS`. Callers that need to distinguish "not a repo" from "git
 * itself failed" should check `isGitRepo(cwd)` first (or alongside) rather
 * than inferring it from this function's `null`, which collapses both cases.
 */
export async function getGitStatus(cwd: string): Promise<GitStatus | null> {
  if (!isGitRepo(cwd)) return null;

  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }
  const pending = inFlight.get(cwd);
  if (pending) return pending;

  const promise = runGitStatus(cwd)
    .then((output) => {
      if (output === null) return null;
      const result = parsePorcelainV2(output);
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
export function clearGitStatusCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
