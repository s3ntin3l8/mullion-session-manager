// Strips the env a git hook exports (pre-push runs this suite; in a linked
// worktree that includes GIT_DIR=<repo>/.git/worktrees/<name>) so a git child
// that copies process.env can't run against the real checkout. Called from
// test/setup.ts before any test file runs; kept here so a child process can
// prove it works (test/git-env-guard.test.ts), since setup.ts itself only
// runs inside Vitest.
import { GIT_ENV_KEYS_TO_STRIP } from "../../src/services/git-env.js";

export function scrubGitHookEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of GIT_ENV_KEYS_TO_STRIP) delete env[key];
}
