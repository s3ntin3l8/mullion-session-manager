import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";
import {
  inspectGitClone,
  isLooseObjectPath,
  repairGitClone,
  runGitDoctor,
  shaOfLoosePath,
} from "../../src/services/git-doctor.js";

// The doctor rewrites the clone's object store and indexes, so every test
// runs it against a throwaway repo — never this checkout's .git.
//
// These tests call the MODULE in-process, not the CLI over it. The module is
// where the logic lives (src/services/git-doctor.ts), so this is where its
// behaviour is pinned; the CLI's own end-to-end wiring has its own tests in
// test/scripts/git-doctor.test.ts. Running the module in-process is also what
// makes its coverage visible: a child process's coverage is not merged into
// the parent's report.
let repo: string;

interface DoctorRun {
  /** The exit code the CLI would exit with. */
  status: number;
  /** Everything the CLI would have written to stdout. */
  stdout: string;
  /** Everything the CLI would have written to stderr. */
  stderr: string;
}

/**
 * Runs the doctor in-process and captures what the CLI would have printed.
 *
 * `runGitDoctor` reports through the `log` callback and returns the exit code,
 * so this is exactly the CLI's contract (scripts/git-doctor.mjs is
 * `process.exit(runGitDoctor(cwd, { apply, force, log: console.log }))`).
 */
async function doctor(opts: { apply?: boolean; force?: boolean } = {}): Promise<DoctorRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  try {
    const status = await runGitDoctor(repo, {
      apply: opts.apply === true,
      force: opts.force === true,
      log: (line) => stdout.push(line),
    });
    return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    errorSpy.mockRestore();
  }
}

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

describe("git-doctor — the read-only inspection", () => {
  it("reports a healthy clone as healthy and changes nothing", async () => {
    const health = await inspectGitClone(repo);
    expect(health.healthy).toBe(true);
    expect(health.zeroByteObjects).toEqual([]);
    expect(health.otherZeroByteFiles).toEqual([]);
    expect(health.fsckErrors).toEqual([]);
    expect(health.gitDir).toBe(path.join(repo, ".git"));
    expect(zeroByteObjects()).toEqual([]);
  });

  it("reports a damaged clone without touching it", async () => {
    const tree = damageTheStagedTree();

    const health = await inspectGitClone(repo);
    expect(health.healthy).toBe(false);
    expect(health.zeroByteObjects).toHaveLength(1);
    expect(health.zeroByteObjects[0]).toContain(tree.slice(0, 2));
    expect(health.fsckErrors.length).toBeGreaterThan(0);
    expect(health.fsckErrors.join("\n")).toContain("invalid sha1 pointer");
    // Read-only: the damage is still there.
    expect(zeroByteObjects()).toHaveLength(1);
  });

  // A zero-byte file under objects/ that is NOT a loose object is a
  // different — and riskier — kind of damage: it is reported, but it is not
  // the #1836 damage and must never be quarantined as if it were.
  it("reports a zero-byte file that is not a loose object separately", async () => {
    const stray = path.join(repo, ".git", "objects", "stray");
    fs.writeFileSync(stray, "");

    const health = await inspectGitClone(repo);
    expect(health.zeroByteObjects).toEqual([]);
    expect(health.otherZeroByteFiles).toEqual(["stray"]);
    expect(health.healthy).toBe(false);
  });

  it("reports a directory that is not a git checkout at all", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const health = await inspectGitClone(outside);
      expect(health.gitDir).toBeNull();
      expect(health.healthy).toBe(false);
      expect(health.timedOut).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A check that could not finish has NO verdict. Reporting it as damage
  // would send an operator to repair a clone that may well be perfectly
  // fine — and "we could not tell" is a different answer from "we found
  // damage", so it gets its own field.
  it("says the verdict is unknown when the fsck does not finish", async () => {
    const health = await inspectGitClone(repo, { fsckTimeoutMs: 1 });
    expect(health.timedOut).toBe(true);
    expect(health.healthy).toBe(false);
    // The timeout is not a finding about the clone — it is the reason there
    // is no finding.
    expect(health.fsckErrors).toEqual([]);
    expect(health.zeroByteObjects).toEqual([]);
    expect(health.gitDir).toBe(path.join(repo, ".git"));
  });
});

describe("git-doctor — the loose-object path helpers", () => {
  it("recognises a loose object path, with either separator", async () => {
    expect(isLooseObjectPath("ab/cdef0123456789abcdef0123456789abcdef01")).toBe(true);
    expect(isLooseObjectPath("ab\\cdef0123456789abcdef0123456789abcdef01")).toBe(true);
  });

  it("rejects anything that is not a loose object path", async () => {
    // Not hex.
    expect(isLooseObjectPath("zz/cdef0123456789abcdef0123456789abcdef01")).toBe(false);
    // One segment, not two.
    expect(isLooseObjectPath("stray")).toBe(false);
    // Three segments.
    expect(isLooseObjectPath("ab/cd/ef")).toBe(false);
    // The right shape, the wrong length.
    expect(isLooseObjectPath("ab/cdef")).toBe(false);
  });

  it("reads the sha a loose object path names, with either separator", async () => {
    // A synthetic sha — 40 hex digits, like every object id git writes.
    const sha = "abcdef0123456789abcdef0123456789abcdef01"; // pragma: allowlist secret
    expect(shaOfLoosePath(`ab/${sha.slice(2)}`)).toBe(sha);
    expect(shaOfLoosePath(`ab\\${sha.slice(2)}`)).toBe(sha);
  });
});

describe("git-doctor — the report", () => {
  it("reports a healthy clone as healthy and changes nothing", async () => {
    const result = await doctor();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("looks healthy");
    expect(zeroByteObjects()).toEqual([]);
  });

  it("finds a zero-byte object and the fsck errors it causes, and changes nothing", async () => {
    const tree = damageTheStagedTree();

    // The symptom, reproduced exactly as #1836 recorded it.
    expect(fsckOutput()).toContain("invalid sha1 pointer in cache-tree");

    const result = await doctor();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(tree);
    expect(result.stdout).toContain("invalid sha1 pointer");
    // Report mode never mutates.
    expect(zeroByteObjects()).toHaveLength(1);
  });

  it("refuses, with a clear message, outside a git checkout", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    const previous = repo;
    repo = outside;
    try {
      const result = await doctor();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not inside a git checkout");
    } finally {
      repo = previous;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // A zero-byte file under objects/ that is NOT a loose object is a
  // different kind of damage, and the report has to say so — a reader who
  // sees it listed as an object would go looking for a sha that is not there.
  it("names a zero-byte file that is not a loose object as OTHER", async () => {
    fs.writeFileSync(path.join(repo, ".git", "objects", "stray"), "");

    const result = await doctor();
    expect(result.stdout).toContain("OTHER");
    expect(result.stdout).toContain("not a loose object");
    expect(result.stdout).toContain("stray");
  });
});

describe("git-doctor — the repair", () => {
  it("quarantines the empty object rather than deleting it, and says which sha is gone", async () => {
    const tree = damageTheStagedTree();

    const result = await doctor({ apply: true });
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

  it("reports an object that is only shadowed as readable again", async () => {
    const commit = damageAShadowedObject();

    const result = await doctor({ apply: true });
    expect(result.stdout).toContain("readable again");
    expect(result.stdout).toContain(commit);
    expect(result.stdout).not.toContain("STILL MISSING");
    expect(zeroByteObjects()).toEqual([]);
  });

  // Two questions, two answers. "Is the clone whole again?" is fsck's call
  // and decides the exit code; "was anything lost?" is its own outcome — a
  // clone can be whole again and still have lost an object that was never
  // committed and is not on the remote.
  it("exits 2 when the clone is whole again but an object was lost", async () => {
    damageTheStagedTree();
    const result = await doctor({ apply: true });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("whole again, but some objects could not be recovered");
  });

  // A fetch that could not run is a FACT about the fetch, not a verdict
  // about the clone: whether the clone is whole is fsck's call, and fsck
  // sees the refs the fetch did not restore.
  it("does not contradict itself when the fetch could not run", async () => {
    // An origin that cannot be reached, and an object that is only
    // shadowed — so the fetch fails and nothing is missing.
    git(["remote", "add", "origin", "/nonexistent-remote-for-the-test"]);
    damageAShadowedObject();

    const result = await doctor({ apply: true });
    expect(result.stdout).toContain("could not run");
    // One verdict, and it is fsck's.
    expect(result.stdout).not.toContain("not whole");
    expect(result.stdout).toContain("the clone is whole");
    expect(result.status).toBe(0);
  });

  it("exits 1 when the clone is still not whole", async () => {
    // The COMMIT itself is destroyed, so the index cannot be rebuilt and
    // fsck still has something to report.
    damage(git(["rev-parse", "HEAD"]));
    const result = await doctor({ apply: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("the clone is NOT whole");
  });

  // The index is re-staged from the working tree, so content that is in the
  // index but NOT in the working tree would be lost. That is the only case
  // that has to be refused — an ordinary unstaged edit is not at risk.
  it("refuses to rebuild when the staged content is not in the working tree", async () => {
    stageThenDamageThenEditAgain();

    const refused = await doctor({ apply: true });
    expect(refused.stdout).toContain("SKIPPED");
    expect(refused.stdout).toContain("would discard what you staged");
    expect(refused.stdout).toContain("--force overrides");
    // The index was left alone, so the damage it names is still there.
    expect(fsckOutput()).toContain("invalid sha1 pointer in cache-tree");
  });

  it("rebuilds when the staged content IS in the working tree", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    const result = await doctor({ apply: true });
    expect(result.stdout).toContain("index rebuilt");
    expect(fsckOutput()).not.toContain("invalid sha1 pointer in cache-tree");
  });

  it("--force overrides the refusal", async () => {
    stageThenDamageThenEditAgain();

    const forced = await doctor({ apply: true, force: true });
    expect(forced.stdout).toContain("index rebuilt");
    expect(fsckOutput()).not.toContain("invalid sha1 pointer in cache-tree");
  });

  it("keeps the staged work when it does rebuild the index", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    await doctor({ apply: true });
    // The staged content came back from the working tree.
    expect(git(["diff", "--cached", "--name-only"])).toBe("a.txt");
  });

  // The repair restores what was staged. It must not adopt anything else.
  it("does not adopt untracked files", async () => {
    fs.writeFileSync(path.join(repo, "notes.md"), "scratch\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "staged\n");
    git(["add", "a.txt"]);
    damageTheStagedTree();

    await doctor({ apply: true });
    expect(git(["status", "--porcelain"])).toContain("?? notes.md");
    expect(git(["diff", "--cached", "--name-only"])).not.toContain("notes.md");
  });

  // A pathspec is a GLOB by default, so a staged file literally named `*.md`
  // widens the re-stage to every tracked file it matches — the leak the
  // pathspec was added to close. `--literal-pathspecs` is what stops it.
  it("re-stages a file whose name looks like a glob, literally", async () => {
    // A tracked file the glob would match, but which was never staged.
    fs.writeFileSync(path.join(repo, "b.md"), "committed\n");
    git(["add", "b.md"]);
    git(["commit", "-q", "-m", "two"]);
    // The staged file, whose name is literally `*.md`.
    fs.writeFileSync(path.join(repo, "*.md"), "literal\n");
    git(["--literal-pathspecs", "add", "--", "*.md"]);
    const tree = git(["write-tree"]);
    damage(tree);
    // …and an unstaged edit to the tracked file the glob would match.
    fs.writeFileSync(path.join(repo, "b.md"), "edited\n");

    await doctor({ apply: true });
    const staged = git(["diff", "--cached", "--name-only"]);
    // The literal file is staged…
    expect(staged).toContain("*.md");
    // …and the file the glob would have swept in is NOT.
    expect(staged).not.toContain("b.md");
  });

  // The verdict has to be taken AFTER the fetch: an object that is gone
  // locally but reachable from the remote comes back with it, and a clone
  // that the fetch repaired is whole — it must not be reported as broken.
  //
  // A local clone HARDLINKS the remote's objects, so destroying one in the
  // clone would destroy it in the remote too. `--no-hardlinks` keeps them
  // separate.
  it("takes the verdict after the fetch — an object it brings back is not reported as gone", async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-remote-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-work-"));
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-clone-"));
    const previous = repo;
    repo = clone;
    try {
      execFileSync("git", ["init", "-q", "--bare", remote], { env: gitEnv() });
      execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], {
        env: gitEnv(),
      });
      execFileSync("git", ["init", "-q", work], { env: gitEnv() });
      fs.writeFileSync(path.join(work, "a.txt"), "hello\n");
      git(["add", "a.txt"], work);
      git(["commit", "-q", "-m", "one"], work);
      git(["remote", "add", "origin", remote], work);
      git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);

      execFileSync("git", ["clone", "-q", "--no-hardlinks", remote, clone], { env: gitEnv() });
      const tree = git(["rev-parse", "HEAD^{tree}"], clone);
      // Destroy it: the zero-byte loose object IS the damage, and the tree is
      // loose in this clone (nothing is packed), so it is genuinely gone.
      fs.chmodSync(path.join(clone, ".git", "objects", tree.slice(0, 2), tree.slice(2)), 0o644);
      fs.writeFileSync(path.join(clone, ".git", "objects", tree.slice(0, 2), tree.slice(2)), "");
      // The refs that claimed it are gone too — the #1836 scenario, and the
      // reason the fetch has to re-download the objects.
      git(["update-ref", "-d", "refs/heads/main"], clone);
      git(["update-ref", "-d", "refs/remotes/origin/main"], clone);

      const result = await doctor({ apply: true });
      expect(result.stdout).toContain("came back with the fetch");
      expect(result.stdout).not.toContain("genuinely gone");
      // The object really is readable again.
      expect(git(["cat-file", "-t", tree], clone)).toBe("tree");
    } finally {
      repo = previous;
      for (const dir of [remote, work, clone]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("git-doctor — repairGitClone directly", () => {
  it("describes what it did, on a clone that needed no repair", async () => {
    const lines: string[] = [];
    const outcome = await repairGitClone(repo, { log: (line) => lines.push(line) });

    expect(outcome.quarantined).toEqual([]);
    expect(outcome.recovered).toEqual([]);
    expect(outcome.unrecovered).toEqual([]);
    expect(outcome.refsRestored).toBe(false);
    expect(outcome.indexesRebuilt).toHaveLength(1);
    expect(outcome.indexesSkipped).toEqual([]);
    expect(outcome.whole).toBe(true);
    expect(outcome.healthy).toBe(true);
    // The quarantine directory is still named, so the operator can see where
    // the (empty) quarantine would have been.
    expect(outcome.quarantine).toContain("gc-quarantine-");
  });

  it("describes what it did, on a clone with damage", async () => {
    const tree = damageTheStagedTree();
    const lines: string[] = [];
    const outcome = await repairGitClone(repo, { log: (line) => lines.push(line) });

    expect(outcome.quarantined).toEqual([tree]);
    expect(outcome.zeroByteObjects).toHaveLength(1);
    expect(outcome.quarantine).not.toBeNull();
    // The object was only staged, never committed, and there is no remote
    // to bring it back from — so it is genuinely gone.
    expect(outcome.unrecovered).toEqual([tree]);
    expect(outcome.recovered).toEqual([]);
  });

  it("reports a directory that is not a git checkout", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    try {
      const outcome = await repairGitClone(outside);
      expect(outcome.gitDir).toBeNull();
      expect(outcome.quarantine).toBeNull();
      expect(outcome.whole).toBe(false);
      expect(outcome.healthy).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Every worktree of the clone shares one object store, so a damaged object
  // affects all of them — and every one of their indexes has to be rebuilt.
  it("rebuilds the index of every worktree of the clone", async () => {
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "git-doctor-linked-"));
    try {
      git(["worktree", "add", "-q", linked, "-b", "side"]);
      const tree = damageTheStagedTree();

      const lines: string[] = [];
      const outcome = await repairGitClone(repo, { log: (line) => lines.push(line) });

      expect(outcome.indexesRebuilt).toHaveLength(2);
      expect(outcome.indexesSkipped).toEqual([]);
      expect(outcome.quarantined).toEqual([tree]);
      // Both worktrees were named in the log.
      expect(lines.join("\n")).toContain(repo);
      expect(lines.join("\n")).toContain(linked);
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });
});
