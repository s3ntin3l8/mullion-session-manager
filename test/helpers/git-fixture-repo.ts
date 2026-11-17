import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";

/** Run git in `cwd` with the repo's sanitised git environment. */
export function fixtureGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
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
