import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";

const script = path.resolve(__dirname, "../../scripts/git-doctor.mjs");

// The doctor rewrites the clone's object store and indexes, so every test
// runs it against a throwaway repo — never this checkout's .git.
let repo: string;

const run = (args: string[] = []) =>
  spawnSync("node", [script, ...args], { cwd: repo, encoding: "utf8", env: gitEnv() });

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();

const objectPath = (sha: string) =>
  path.join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2));

const zeroByteObjects = () =>
  execFileSync("find", [path.join(repo, ".git", "objects"), "-type", "f", "-size", "0"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

/** Truncates a loose object to zero bytes — the damage #1836 describes. */
function damage(sha: string) {
  const target = objectPath(sha);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The loose file may already be gone (a repack moved it into the pack) —
  // then the empty file standing in its place IS the damage.
  if (fs.existsSync(target)) fs.chmodSync(target, 0o644);
  fs.writeFileSync(target, "");
}

/** git fsck's output — it exits non-zero when it finds problems. */
function fsckOutput(): string {
  const result = spawnSync("git", ["fsck", "--connectivity-only", "--no-progress"], {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv(),
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * Builds the scenario from the issue: a tree that exists only as a loose
 * object and is named by the index's cache-tree. Emptying it reproduces
 * "invalid sha1 pointer in cache-tree of .git/index" exactly.
 */
function damageTheStagedTree() {
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  git(["add", "a.txt"]);
  const tree = git(["write-tree"]);
  damage(tree);
  return tree;
}

/** A commit's objects, packed, so the loose file only SHADOWS them. */
function damageAShadowedObject() {
  const commit = git(["rev-parse", "HEAD"]);
  git(["repack", "-a", "-d", "-q"]);
  damage(commit);
  return commit;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-"));
  execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "one"]);
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("git-doctor.mjs", () => {
  it("reports a healthy clone as healthy and changes nothing", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("looks healthy");
    expect(zeroByteObjects()).toEqual([]);
  });

  it("--apply on a healthy clone is a no-op", () => {
    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(zeroByteObjects()).toEqual([]);
  });

  it("finds a zero-byte object and the fsck errors it causes, and changes nothing", () => {
    const tree = damageTheStagedTree();

    // The symptom, reproduced exactly as #1836 recorded it.
    expect(fsckOutput()).toContain("invalid sha1 pointer in cache-tree");

    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(tree);
    expect(result.stdout).toContain("invalid sha1 pointer");
    // Report mode never mutates.
    expect(zeroByteObjects()).toHaveLength(1);
  });

  it("quarantines the empty object rather than deleting it, and says which sha is gone", () => {
    const tree = damageTheStagedTree();

    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STILL MISSING");
    expect(result.stdout).toContain(tree);

    // Gone from objects/…
    expect(zeroByteObjects()).toEqual([]);
    // …and preserved in the quarantine, inside the git dir but outside
    // objects/, so git cannot see it as an object.
    const quarantine = fs
      .readdirSync(path.join(repo, ".git"))
      .find((name) => name.startsWith("gc-quarantine-"));
    expect(quarantine).toBeDefined();
    const quarantined = path.join(repo, ".git", quarantine!, tree.slice(0, 2), tree.slice(2));
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.statSync(quarantined).size).toBe(0);
  });

  it("reports an object that is only shadowed as readable again", () => {
    const commit = damageAShadowedObject();

    const result = run(["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("readable again");
    expect(result.stdout).toContain(commit);
    expect(result.stdout).not.toContain("STILL MISSING");
    expect(zeroByteObjects()).toEqual([]);
  });

  it("refuses to rebuild an index that holds staged work, unless forced", () => {
    damageTheStagedTree();

    const refused = run(["--apply"]);
    expect(refused.stdout).toContain("SKIPPED");
    expect(refused.stdout).toContain("--force overrides");
    // The index was left alone, so the damage it names is still there.
    expect(fsckOutput()).toContain("invalid sha1 pointer in cache-tree");

    const forced = run(["--apply", "--force"]);
    expect(forced.stdout).toContain("index rebuilt");
    expect(fsckOutput()).not.toContain("invalid sha1 pointer in cache-tree");
  });

  it("keeps the staged work when it does rebuild the index", () => {
    damageTheStagedTree();

    run(["--apply", "--force"]);
    // The staged content came back from the working tree.
    expect(git(["diff", "--cached", "--name-only"])).toBe("a.txt");
  });

  it("refuses, with a clear message, outside a git checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const result = spawnSync("node", [script], {
        cwd: outside,
        encoding: "utf8",
        env: gitEnv(),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not inside a git checkout");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
