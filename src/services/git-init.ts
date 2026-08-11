import { spawn } from "node:child_process";
import path from "node:path";
import { gitEnv } from "./git-env.js";

const INIT_TIMEOUT_MS = 10_000;

// Same guard as this file's sibling git-fetch.ts — a relative cwd would
// otherwise silently resolve against this process's own cwd.
function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

/** Runs `git init --quiet` in a directory the caller just created via
 * createProjectDir. Never throws — a failed init leaves an already-valid,
 * already-persisted project pointed at a plain (non-git) directory, which
 * is a strictly better outcome than failing the whole create. Note: if
 * `cwd` sits inside an existing repository, this creates a nested repo —
 * accepted rather than guarded, since the directory was just created at
 * the user's explicit request. */
export async function runGitInit(cwd: string): Promise<{ success: boolean; error?: string }> {
  if (!isSafeAbsolutePath(cwd)) {
    return { success: false, error: "cwd must be an absolute path with no '..' segments" };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", ["-C", cwd, "init", "--quiet"], {
        env: gitEnv(),
        stdio: "ignore",
        timeout: INIT_TIMEOUT_MS,
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git init exited with code ${code}`));
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
