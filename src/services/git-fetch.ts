import { spawn } from "node:child_process";
import path from "node:path";
import { gitEnv } from "./git-env.js";

const FETCH_TIMEOUT_MS = 30_000;

// B9 — every other git helper in this file's sibling group (git-status.ts,
// git-refs.ts, git-worktree.ts, git-branch-delete.ts, git-ignore.ts,
// git-remote.ts) checks this before ever reaching a `git -C <cwd>` spawn;
// this file was the one exception, so a relative `cwd` would silently
// resolve against this process's own cwd and fetch the wrong repo. Same
// absolute-path + no-".."-segment guard as those siblings.
function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

export async function runGitFetch(cwd: string): Promise<{ success: boolean; error?: string }> {
  if (!isSafeAbsolutePath(cwd)) {
    return { success: false, error: "cwd must be an absolute path with no '..' segments" };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", cwd, "fetch", "--quiet", "--prune"], {
        env: gitEnv(),
        stdio: "ignore",
        timeout: FETCH_TIMEOUT_MS,
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git fetch exited with code ${code}`));
      });
      child.on("error", reject);
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
