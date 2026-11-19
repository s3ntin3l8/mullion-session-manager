import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";

/** Run git in `cwd` with the repo's sanitised git environment. */
export function fixtureGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

/**
 * A throwaway one-commit repo in a fresh temp dir — the shape the
 * sessions-route worktree/promote suites need (a project whose checkout root
 * IS a git repo, so the route can make a worktree of it).
 *
 * env: gitEnv() (issue #205) — a test file runs as a subprocess of `npm
 * test`, itself sometimes invoked from inside a git hook (e.g. the pre-push
 * hook that runs this very suite): a leaked GIT_DIR/GIT_INDEX_FILE/etc. from
 * that outer git operation would otherwise redirect these fixture-repo
 * commands onto the REAL repo's .git instead of the temp dir passed via
 * `cwd` — exactly the corruption class gitEnv() exists to prevent (see
 * git-refs.test.ts's identical guard on its own git() helper). `fixtureGit`
 * above is the single place that guard now lives.
 */
export function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-worktree-test-"));
  fixtureGit(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  fixtureGit(cwd, ["add", "-A"]);
  fixtureGit(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

/** A one-commit repo on `main` (a single README). Small on purpose: tests that
 * check out a scratch worktree of `cwd` must not use the real repo, whose
 * ~2800-file checkout can outlast git-worktree's 15s git timeout on a busy host. */
export function initFixtureRepo(cwd: string): void {
  fs.mkdirSync(cwd, { recursive: true });
  fixtureGit(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# test repo\n");
  fixtureGit(cwd, ["add", "-A"]);
  fixtureGit(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}
