import { spawn } from "node:child_process";
import path from "node:path";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";
import { runGitCommand } from "./git-run.js";

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

export async function runGitFetch(
  cwd: string,
  token?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isSafeAbsolutePath(cwd)) {
    return { success: false, error: "cwd must be an absolute path with no '..' segments" };
  }
  if (token) {
    // Same http.extraHeader + redact() plumbing as push/clone: the token rides
    // argv for this one invocation, never `.git/config`, and is stripped from
    // the returned error.
    const encodedCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
    const result = await runGitCommand(
      cwd,
      ["fetch", "--quiet", "--prune"],
      `AUTHORIZATION: basic ${encodedCredential}`,
      token,
      encodedCredential,
      FETCH_TIMEOUT_MS,
    );
    return result.ok ? { success: true } : { success: false, error: result.detail };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", [...GIT_NO_AUTO_GC, "-C", cwd, "fetch", "--quiet", "--prune"], {
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
