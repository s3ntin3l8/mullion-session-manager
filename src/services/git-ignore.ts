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
