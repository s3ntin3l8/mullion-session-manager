import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";

const script = path.resolve(__dirname, "../../scripts/git-doctor.mjs");

// The doctor rewrites the clone's object store and indexes, so every test
// runs it against a throwaway repo — never this checkout's .git.
//
// These are the CLI's OWN tests: the flags, the exit codes and what lands on
// stdout vs stderr. The doctor's behaviour itself is pinned in-process in
// test/services/git-doctor.test.ts, where the module it wraps is imported
// directly — a child process's coverage is not merged into the parent's
// report, so the behaviour tests live where they can be measured.
let repo: string;

const run = (args: string[] = [], cwd = repo) =>
  // The doctor's logic lives in src/services/git-doctor.ts, so the CLI over it
  // runs through tsx (the same mechanism test/scripts/git-env.test.ts uses).
  // The loader is resolved to an ABSOLUTE path: this spawn runs with `cwd` set
  // to the throwaway repo, where the bare "tsx" specifier would not resolve.
  spawnSync("node", ["--import", import.meta.resolve("tsx"), script, ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });

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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-cli-"));
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

  it("reports damage and changes nothing, without --apply", () => {
    const tree = damageTheStagedTree();

    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(tree);
    expect(result.stdout).toContain("damage found");
    // Report mode never mutates.
    expect(zeroByteObjects()).toHaveLength(1);
  });

  it("repairs with --apply, and says where the quarantined files went", () => {
    const tree = damageTheStagedTree();

    const result = run(["--apply"]);
    expect(result.stdout).toContain("quarantined");
    expect(result.stdout).toContain(tree);
    // The file was MOVED out of objects/, never deleted.
    expect(zeroByteObjects()).toEqual([]);
    const quarantine = fs
      .readdirSync(path.join(repo, ".git"))
      .find((name) => name.startsWith("gc-quarantine-"));
    expect(quarantine).toBeDefined();
    expect(
      fs.existsSync(path.join(repo, ".git", quarantine!, tree.slice(0, 2), tree.slice(2))),
    ).toBe(true);
  });

  it("prints its usage and exits 0 for --help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("--force");
  });

  // The clone to work on can be named explicitly, so the doctor can be run
  // from somewhere else entirely — which is what a repair of a project you
  // have open in Mullion needs.
  it("works on the clone named by the path argument, not the one it runs in", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-elsewhere-"));
    try {
      const result = run([repo], elsewhere);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("looks healthy");
      // It reported on the NAMED clone, not on the one it was started in.
      expect(result.stdout).not.toContain(elsewhere);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses, with a clear message on stderr, outside a git checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const result = run([], outside);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not inside a git checkout");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
