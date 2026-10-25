import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_NO_AUTO_GC, gitEnv } from "../../src/services/git-env.js";
import { GIT_CONFIG_NO_AUTO_GC_ENV } from "../../src/services/session-env.js";

// Issue #1851 — Mullion's own git commands must never trigger the background
// `git gc` that can delete a loose object a CONCURRENT write is creating
// (#1836). The failure surfaces far from the cause: a commit that cannot
// complete, naming a *missing* object rather than a corrupt one.
//
// The fix is `-c gc.auto=0` on every git invocation (GIT_NO_AUTO_GC in
// src/services/git-env.ts). This test proves the override actually suppresses
// the gc, with a positive control: the SAME fetch without the override MUST
// pack, or the test is not measuring anything.
//
// The repo is built with enough loose objects for git's auto-gc to have work
// to do, and with gc.autoDetach=false so the gc runs in the foreground —
// otherwise the assertion would race a detached background gc.

/** Enough files that the loose objects clear git's auto-gc threshold. */
const FILE_COUNT = 300;

let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Loose object count — what the auto-gc takes away when it packs. */
const looseCount = (cwd: string) =>
  Number(/^count: (\d+)/m.exec(git(cwd, "count-objects", "-v"))![1]);

/** Pack count — what the auto-gc leaves behind. */
const packCount = (cwd: string) =>
  fs.readdirSync(path.join(cwd, ".git", "objects", "pack")).filter((f) => f.endsWith(".pack"))
    .length;

/**
 * A clone with loose, reachable objects and a low gc.auto threshold, so a
 * fetch's auto-gc has work to do.
 */
function makeClone(name: string): string {
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const clone = path.join(root, name);

  if (!fs.existsSync(remote)) {
    execFileSync("git", ["init", "-q", "--bare", remote], { env: gitEnv() });
    execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], {
      env: gitEnv(),
    });
    execFileSync("git", ["init", "-q", "-b", "main", work], { env: gitEnv() });
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "Test");
    fs.writeFileSync(path.join(work, "a.txt"), "one\n");
    git(work, "add", "a.txt");
    git(work, "commit", "-q", "-m", "one");
    git(work, "remote", "add", "origin", remote);
    git(work, "push", "-q", "origin", "main");
  }

  execFileSync("git", ["clone", "-q", remote, clone], { env: gitEnv() });
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  // Foreground, so the assertion cannot race a detached gc.
  git(clone, "config", "gc.autoDetach", "false");

  // Commit the files while the threshold is HIGH, so their objects stay LOOSE
  // (and reachable — an unreachable loose object is not worth packing).
  git(clone, "config", "gc.auto", "1000000");
  fs.mkdirSync(path.join(clone, "many"));
  for (let i = 1; i <= FILE_COUNT; i++) {
    fs.writeFileSync(path.join(clone, "many", `f${i}.txt`), `content ${i}\n`);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "many");
  // Now low, so the NEXT fetch's auto-gc has work to do.
  git(clone, "config", "gc.auto", "1");
  fs.rmSync(path.join(clone, ".git", "gc.log"), { force: true });

  return clone;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "git-no-auto-gc-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GIT_NO_AUTO_GC (issue #1851)", () => {
  it("a plain fetch lets the auto-gc pack the loose objects (positive control)", () => {
    const clone = makeClone("control");
    const before = looseCount(clone);
    expect(before).toBeGreaterThan(0);

    git(clone, "fetch", "origin");

    // The gc ran: the loose objects are gone and there is a pack.
    expect(looseCount(clone)).toBe(0);
    expect(packCount(clone)).toBeGreaterThan(0);
  });

  it("-c gc.auto=0 stops the same fetch from triggering the auto-gc", () => {
    const clone = makeClone("guarded");
    const before = looseCount(clone);
    const packsBefore = packCount(clone);
    expect(before).toBeGreaterThan(0);

    git(clone, ...GIT_NO_AUTO_GC, "fetch", "origin");

    // Nothing was packed: the override answered "no" to the tidy-up.
    expect(looseCount(clone)).toBe(before);
    expect(packCount(clone)).toBe(packsBefore);
  });

  it("the env form stops it too", () => {
    const clone = makeClone("env");
    const before = looseCount(clone);
    const packsBefore = packCount(clone);
    expect(before).toBeGreaterThan(0);

    execFileSync("git", ["-C", clone, "fetch", "origin"], {
      encoding: "utf8",
      env: { ...gitEnv(), ...GIT_CONFIG_NO_AUTO_GC_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(looseCount(clone)).toBe(before);
    expect(packCount(clone)).toBe(packsBefore);
  });
});
