// Logic behind test/global-setup.ts's tripwire (issues #1602, #1649), kept
// here so it can be unit-tested — globalSetup itself runs outside the
// per-file workers, so its own lines are never covered.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";

// Known limits: only user.*/core.* are watched (other keys, e.g. branch.* or
// remote.*, change legitimately while developers work, so widening risks false
// alarms), and the teardown check never runs if the run is SIGINT/SIGKILLed —
// exactly when a leaking spawn may be mid-flight. This catches the common
// case, not all.
const WATCHED = "^(user|core)\\.";

// Linked worktrees share the main checkout's config, so watch the common dir.
export function resolveConfigPath(root: string): string | null {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    // Relative (".git") from the main checkout, absolute from a linked worktree.
    return path.resolve(root, common, "config");
  } catch {
    return null; // not a git checkout (e.g. a source tarball)
  }
}

// `--file` is explicit so a leaked GIT_CONFIG can't redirect the read.
export function snapshotConfig(file: string): string {
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

export function assertConfigUnchanged(file: string, before: string): void {
  const diff = diffConfigSnapshot(before, snapshotConfig(file));
  if (diff === null) return;
  throw new Error(
    `The test run modified the checkout's local git config (${file}):\n${diff}\n\n` +
      "A test ran git against the real repo instead of its temp fixture (issues #1602, #1649). " +
      "Restore the keys with `git config --local --unset <key>` / `git config --local core.bare false`, " +
      "then find the spawn missing `env: gitEnv()` or a `-C <tmp>`.",
  );
}

// Index/HEAD tripwire: the config snapshot above can't see the other damage a
// leaked GIT_DIR does. On pre-push a fixture's `git add` left a worktree's
// index holding just its own file (every real one staged as deleted), and a
// fixture's `git checkout -b` / `checkout main` moved the worktree's HEAD
// onto another branch, swapping its index for that branch's tree. Watches the
// branch HEAD is on (not its sha, so committing mid-run is fine) and the
// entry count, which only trips on losing over half of them (staging or
// removing a few files mid-run never does).
export interface IndexSnapshot {
  head: string;
  entries: number;
}

const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();

export function snapshotIndex(root: string): IndexSnapshot | null {
  try {
    let head: string;
    try {
      head = git(root, ["symbolic-ref", "-q", "HEAD"]).trim();
    } catch {
      head = `detached at ${git(root, ["rev-parse", "HEAD"]).trim()}`;
    }
    const entries = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean).length;
    return { head, entries };
  } catch {
    return null; // not a git checkout
  }
}

export function assertIndexIntact(root: string, before: IndexSnapshot | null): void {
  if (!before) return;
  const after = snapshotIndex(root);
  const problems: string[] = [];
  if (!after || after.head !== before.head)
    problems.push(`HEAD moved: ${before.head} -> ${after?.head ?? "unreadable"}`);
  if (before.entries > 0 && (after?.entries ?? 0) * 2 < before.entries)
    problems.push(`index emptied: ${before.entries} -> ${after?.entries ?? 0} entries`);
  if (problems.length === 0) return;
  throw new Error(
    `The test run rewrote the checkout's git state (${root}):\n${problems.join("\n")}\n\n` +
      "A test ran git against the real repo instead of its temp fixture, most likely via a " +
      "GIT_DIR leaked from a git hook. Check out your branch again / `git reset` the index " +
      "(your working tree is untouched), then find the git spawn missing `env: gitEnv()`.",
  );
}
