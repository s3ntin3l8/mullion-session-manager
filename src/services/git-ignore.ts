import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.js";

// Issue: sidebar worktree display's Part B — an agent's `file_change` hook
// event (pty-manager.ts's Session.emitHookEvent) carries whatever path the
// agent edited, with no idea whether that path is git-ignored. `.claude/`
// (this repo's own plan-file directory, among others) is a common example:
// an agent editing its own plan file there shouldn't surface as a Row 4 chip
// alongside the actual tracked-file changes under review. Same guard/posture
// conventions as this file's siblings (git-status.ts, git-refs.ts):
// absolute-path + no-".."-segment guard, `spawn` with an argv array (never a
// shell string), best-effort and never throws — a missing/non-repo root or a
// failed `git` call just means "not ignored" (keep the event), not an error.

const GIT_TIMEOUT_MS = 5_000;

function isSafeAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) && !path.normalize(p).split(path.sep).includes("..");
}

/**
 * True if `filePath` (resolved against `root` first if relative — Claude
 * Code's hook payload is absolute, Codex's `apply_patch`-derived one is
 * relative, see forwarder-core.mjs) is git-ignored in the repo at `root`.
 * `root` is treated as untrusted the same way `filePath` is (both ultimately
 * derive from a session's live/spawn cwd and an agent-supplied path) — both
 * must pass the absolute-path + no-".."-segment guard before ever reaching
 * `git -C`. False for a non-repo root, an unsafe path, or any `git` failure
 * (timeout, spawn error, non-0/1 exit) — "can't tell" collapses to "not
 * ignored" here, same as this function's siblings collapse their own
 * failure modes to "nothing to show" rather than blocking the event.
 * Never throws.
 */
export function isPathGitIgnored(root: string, filePath: string): Promise<boolean> {
  if (!isSafeAbsolutePath(root) || !existsSync(path.join(root, ".git"))) {
    return Promise.resolve(false);
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  if (!isSafeAbsolutePath(resolved)) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const child = spawnChild("git", ["-C", root, "check-ignore", "-q", "--", resolved], {
      stdio: ["ignore", "ignore", "ignore"],
      env: gitEnv(),
    });

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, GIT_TIMEOUT_MS);

    // `git check-ignore -q` exits 0 when the path IS ignored, 1 when it
    // isn't tracked-as-ignored, and >1 on a real error (e.g. not a repo) —
    // every non-0 outcome (including a spawn error) collapses to "not
    // ignored", per this function's own doc comment.
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

// Cache key prefixes for isPathGitIgnoredCached's two-level cache — a
// single `Map<string, boolean>` holds both directory- and file-level
// entries (rather than two separate Maps) so Session only needs to own and
// clear one field. Prefixed so a directory path and a file path that
// happen to be byte-identical (impossible in practice, but not worth
// relying on) can never collide.
const DIR_CACHE_PREFIX = "dir:";
const FILE_CACHE_PREFIX = "file:";

/**
 * Perf audit finding B8(3) — pty-manager.ts's `file_change` hook handling
 * spawns a real `git check-ignore` subprocess per event, strictly
 * serialized (fileChangeQueue) to preserve ordering. An agent doing a
 * large multi-file operation forks one process per changed file, one after
 * another, even though real edits overwhelmingly cluster in a handful of
 * directories.
 *
 * `git check-ignore` is answered per PATH, not per directory — a targeted
 * pattern (e.g. a bare `.env`) can ignore one specific file without its
 * containing directory being excluded at all, so a single file's "ignored"
 * answer can NOT be assumed to apply to its siblings. What CAN be trusted
 * and reused, per gitignore(5)'s own guarantee ("It is not possible to
 * re-include a file if a parent directory of that file is excluded"): once
 * the DIRECTORY ITSELF is confirmed ignored (a real check against the
 * directory path, not inferred from any file inside it), every file under
 * it is ignored too, for as long as this cache lives — this is exactly
 * `.claude/`'s own motivating case, one directory-level spawn ever, no
 * matter how many files inside it change. When the directory itself is
 * NOT ignored, each distinct file still needs (and gets) its own real,
 * cached check — but a repeat edit to the same file is free.
 *
 * `cache` is owned by the caller (one `Map` per session, per this
 * function's own per-session-cache contract — see Session's
 * `gitIgnoreDirCache` field) so it can be sized/cleared independently per
 * session rather than this module holding a single global, unbounded,
 * cross-session cache. Both cache levels key off the *resolved absolute*
 * path (not the raw, possibly-relative `filePath` itself) specifically so
 * a result stays correct even if this session's cwd changes between calls
 * (a `cd` into a different worktree) — a relative path alone would collide
 * across two different roots that happen to share a relative path shape.
 *
 * Staleness across a `.gitignore` edit is asymmetric by construction, and
 * handled two different ways: a path that was never cached (or a directory
 * cached NOT-excluded, whose individual files still get a real per-file
 * check) always sees the current `.gitignore` content on its first real
 * check — that's the "stale-negative" direction, and it self-heals for
 * free. A path already cached `true` does NOT re-check itself on its own —
 * that's the "stale-positive" direction, and it's handled explicitly below:
 * any `file_change` event FOR a `.gitignore` path itself clears the whole
 * cache, so a rule removed mid-session doesn't keep suppressing events for
 * whatever it used to ignore.
 */
export function isPathGitIgnoredCached(
  root: string,
  filePath: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (!isSafeAbsolutePath(root) || !existsSync(path.join(root, ".git"))) {
    return Promise.resolve(false);
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  if (!isSafeAbsolutePath(resolved)) return Promise.resolve(false);

  // Stale-POSITIVE healing: a cached `true` (dir- or file-level) never
  // re-checks itself, so if a `.gitignore` rule that made something ignored
  // is later removed, this cache would otherwise keep suppressing that
  // path's file_change events for the rest of the session — the one
  // direction the per-file real-check fallback above does NOT self-heal
  // (that fallback only helps a path that was never cached at all; once
  // cached `true`, `isPathGitIgnoredCached` short-circuits before ever
  // calling `isPathGitIgnored` again for it). A `.gitignore` edit can
  // change the answer for anything at or below its own directory —
  // including entries this cache currently trusts as directory-level
  // `true` — so rather than tracking which entries a given `.gitignore`
  // could reach, any `file_change` event FOR a `.gitignore` path itself
  // (this function is called with every file_change path, so an agent
  // editing its own repo's `.gitignore` flows through here too) discards
  // the whole cache and lets every subsequent check re-derive fresh. This
  // only catches a `.gitignore` edited within the same session — an
  // out-of-band change (e.g. `git checkout` switching branches, or an edit
  // never reported as a file_change event) still isn't observable here and
  // waits for kill()'s cache clear, same as before this fix.
  if (path.basename(resolved) === ".gitignore") {
    cache.clear();
  }

  const dir = path.dirname(resolved);
  return checkDirIgnoredCached(root, dir, cache).then((dirIgnored) => {
    // Whole directory excluded — every file under it is ignored too,
    // gitignore(5)'s guarantee. No per-file check needed at all.
    if (dirIgnored) return true;

    const fileKey = FILE_CACHE_PREFIX + resolved;
    const cachedFile = cache.get(fileKey);
    if (cachedFile !== undefined) return cachedFile;

    return isPathGitIgnored(root, filePath).then((ignored) => {
      cache.set(fileKey, ignored);
      return ignored;
    });
  });
}

function checkDirIgnoredCached(
  root: string,
  dir: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const dirKey = DIR_CACHE_PREFIX + dir;
  const cached = cache.get(dirKey);
  if (cached !== undefined) return Promise.resolve(cached);

  // Checks the directory PATH ITSELF against check-ignore — unlike a
  // file-level result, both `true` and `false` here are trustworthy to
  // cache (this is a direct answer about the directory, not an inference
  // from any one file inside it).
  return isPathGitIgnored(root, dir).then((ignored) => {
    cache.set(dirKey, ignored);
    return ignored;
  });
}
