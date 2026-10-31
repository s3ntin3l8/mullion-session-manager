// Strips the env a git hook exports (pre-push runs this suite; in a linked
// worktree that includes GIT_DIR=<repo>/.git/worktrees/<name>) so a git child
// that copies process.env can't run against the real checkout. Called from
// test/setup.ts before any test file runs; kept here so a child process can
// prove it works (test/git-env-guard.test.ts), since setup.ts itself only
// runs inside Vitest.
import { GIT_CONFIG_COUNT_KEY, GIT_ENV_KEYS_TO_STRIP } from "../../src/services/git-env.js";

// The env form of `-c`: COUNT plus the numbered KEY_n / VALUE_n pairs. A
// Mullion-hosted session exports these (gc.auto, a credential.helper, ...), and
// a suite asserting on the entries ABOVE its own COUNT would otherwise see the
// host's. Kept out of GIT_ENV_KEYS_TO_STRIP, which must stay COUNT-free (see
// GIT_CONFIG_COUNT_KEY), so this is test-side only.
const GIT_CONFIG_NUMBERED = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

export function scrubGitHookEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of GIT_ENV_KEYS_TO_STRIP) delete env[key];
  delete env[GIT_CONFIG_COUNT_KEY];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_NUMBERED.test(key)) delete env[key];
  }
}
