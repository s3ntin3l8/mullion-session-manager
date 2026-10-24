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
  // Remove first rather than truncate: a loose object is written read-only,
  // and removing it does not need write permission on the FILE (only on the
  // directory). Writing over it in place would need the mode changed first,
  // and a chmod-then-write is a check-then-act race.
  fs.rmSync(target, { force: true });
  fs.writeFileSync(target, "");
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

/**
 * Stages a change, damages the tree that change produced, and then edits the
 * file again — so the index holds content the working tree does not have.
 * That is the one case the rebuild has to refuse.
 */
function stageThenDamageThenEditAgain() {
  fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
  git(["add", "a.txt"]);
  const tree = git(["write-tree"]);
  damage(tree);
  // …and then changed again, so the index holds content the working tree
  // does not have.
  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
}

/** A commit's objects, packed, so the loose file only SHADOWS them. */
function damageAShadowedObject() {
  const commit = git(["rev-parse", "HEAD"]);
  git(["repack", "-a", "-d", "-q"]);
  damage(commit);
  return commit;
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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-"));
  execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
  // No `git config user.*` here: the repo forbids writing a commit identity
  // into any config (test/git-env-guard.test.ts), and test/setup.ts already
  // puts GIT_AUTHOR_*/GIT_COMMITTER_* in the environment — which never
  // touches a config file.
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
    expect(result.stdout).toContain("readable again");
    expect(result.stdout).toContain(commit);
    expect(result.stdout).not.toContain("STILL MISSING");
    expect(zeroByteObjects()).toEqual([]);
  });

  // The repair is only complete if the objects are readable again AND the
  // refs came back — so a repair that could not finish must not report
  // success.
  it("exits non-zero when an object is genuinely gone", () => {
    damageTheStagedTree();
    const result = run(["--apply"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("NOT fully repaired");
  });

  // The index is re-staged from the working tree, so content that is in the
  // index but NOT in the working tree would be lost. That is the only case
  // that has to be refused — an ordinary unstaged edit is not at risk.
  it("refuses to rebuild when the staged content is not in the working tree", () => {
    stageThenDamageThenEditAgain();

    const refused = run(["--apply"]);
    expect(refused.stdout).toContain("SKIPPED");
    expect(refused.stdout).toContain("would discard what you staged");
    expect(refused.stdout).toContain("--force overrides");
    // The index was left alone, so the damage it names is still there.
    expect(fsckOutput()).toContain("invalid sha1 pointer in cache-tree");
  });

  it("rebuilds when the staged content IS in the working tree", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    const result = run(["--apply"]);
    expect(result.stdout).toContain("index rebuilt");
    expect(fsckOutput()).not.toContain("invalid sha1 pointer in cache-tree");
  });

  it("--force overrides the refusal", () => {
    stageThenDamageThenEditAgain();

    const forced = run(["--apply", "--force"]);
    expect(forced.stdout).toContain("index rebuilt");
    expect(fsckOutput()).not.toContain("invalid sha1 pointer in cache-tree");
  });

  it("keeps the staged work when it does rebuild the index", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    run(["--apply"]);
    // The staged content came back from the working tree.
    expect(git(["diff", "--cached", "--name-only"])).toBe("a.txt");
  });

  // The repair restores what was staged. It must not adopt anything else.
  it("does not adopt untracked files", () => {
    fs.writeFileSync(path.join(repo, "notes.md"), "scratch\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    run(["--apply"]);
    expect(git(["status", "--porcelain"])).toContain("?? notes.md");
    expect(git(["diff", "--cached", "--name-only"])).not.toContain("notes.md");
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
