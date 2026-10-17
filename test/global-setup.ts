// Tripwire for issues #1602 and #1649: a test that runs `git init` /
// `git config` against the real checkout (e.g. via a GIT_DIR leaked from the
// pre-push hook) silently rewrote its .git/config — `core.bare = true`, then
// `user.name = Test`. Snapshot the identity/core keys before the run and fail
// it if they differ afterwards, so the leak surfaces the moment it happens
// instead of weeks of mis-authored commits later.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitEnv } from "../src/services/git-env.js";

const ROOT = path.resolve(__dirname, "..");
const WATCHED = "^(user|core)\\.";

let configPath: string | null = null;
let before = "";

// Linked worktrees share the main checkout's config, so watch the common dir.
// `--file` is explicit so a leaked GIT_CONFIG can't redirect the read.
function resolveConfigPath(): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: ROOT,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    // Relative (".git") from the main checkout, absolute from a linked worktree.
    return path.resolve(ROOT, common, "config");
  } catch {
    return null; // not a git checkout (e.g. a source tarball)
  }
}

function snapshot(file: string): string {
  try {
    return execFileSync("git", ["config", "--file", file, "--get-regexp", WATCHED], {
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return ""; // exit 1: no matching keys
  }
}

export function diffConfigSnapshot(beforeSnap: string, afterSnap: string): string | null {
  if (beforeSnap === afterSnap) return null;
  const lines = (s: string) => new Set(s.split("\n").filter(Boolean));
  const b = lines(beforeSnap);
  const a = lines(afterSnap);
  return [
    ...[...b].filter((l) => !a.has(l)).map((l) => `- ${l}`),
    ...[...a].filter((l) => !b.has(l)).map((l) => `+ ${l}`),
  ].join("\n");
}

export function setup(): void {
  configPath = resolveConfigPath();
  if (configPath) before = snapshot(configPath);
}

export function teardown(): void {
  if (!configPath) return;
  const diff = diffConfigSnapshot(before, snapshot(configPath));
  if (diff === null) return;
  throw new Error(
    `The test run modified the checkout's local git config (${configPath}):\n${diff}\n\n` +
      "A test ran git against the real repo instead of its temp fixture (issues #1602, #1649). " +
      "Restore the keys with `git config --local --unset <key>` / `git config --local core.bare false`, " +
      "then find the spawn missing `env: gitEnv()` or a `-C <tmp>`.",
  );
}
