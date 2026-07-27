import { spawn } from "node:child_process";
import { gitEnv } from "./git-env.js";

const FETCH_TIMEOUT_MS = 30_000;

export async function runGitFetch(cwd: string): Promise<{ success: boolean; error?: string }> {
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
