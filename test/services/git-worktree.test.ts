import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkoutBranchWorktree,
  cleanupPreviewWorktree,
  createWorktree,
  deriveWorktreePath,
  getPreviewWorktree,
  isDockPreviewWorktree,
  listTaskWorktreeDirs,
  pruneWorktrees,
  removeWorktree,
  removeWorktreeIfClean,
  syncWorktree,
  trackPreviewWorktree,
} from "../../src/services/git-worktree.js";
import { listWorktrees } from "../../src/services/git-refs.js";
import { gitEnv } from "../../src/services/git-env.js";
import { clearGitStatusCacheForTests } from "../../src/services/git-status.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

function commitAll(cwd: string, message: string) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--no-verify"]);
}

function revParse(cwd: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd, stdio: "pipe", env: gitEnv() })
    .toString()
    .trim();
}

describe("createWorktree (issue #271)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    expect(await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "s1" })).toBeNull();
  });

  it("returns null for a relative cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const relative = path.relative(process.cwd(), tmpDir);
    expect(await createWorktree({ cwd: relative, baseRef: "main", seed: "s1" })).toBeNull();
  });

  it("returns null when baseRef does not resolve", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    expect(await createWorktree({ cwd: tmpDir, baseRef: "no-such-ref", seed: "s1" })).toBeNull();
  });

  it("rejects a baseRef starting with '-' — argument injection hardening, Hermes review on PR #277", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    // No real branch ever starts with "-"; `git worktree add`'s argv would
    // otherwise reinterpret a leading-dash baseRef as a flag rather than a
    // ref (e.g. "--force"), regardless of its argument position — this
    // matters because baseRef can originate as a model-authored
    // suggestedBaseRef (the promote_to_worktree MCP tool) that reaches this
    // function unchanged if a human submits the promote dialog without
    // editing the pre-filled picker.
    expect(await createWorktree({ cwd: tmpDir, baseRef: "--force", seed: "s1" })).toBeNull();
    expect(await createWorktree({ cwd: tmpDir, baseRef: "-x", seed: "s1" })).toBeNull();
  });

  it("creates a worktree under .mullion-worktrees, branched off baseRef, on a fresh branch", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "my-feature" });
    expect(result).not.toBeNull();
    expect(result?.path).toBe(path.join(tmpDir, ".mullion-worktrees", "my-feature"));
    expect(result?.branch).toBe("mullion/my-feature");
    expect(fs.existsSync(result?.path ?? "")).toBe(true);

    // -b, never --detach — the branch must survive a future `worktree remove`.
    const branchListOutput = execFileSync(
      "git",
      ["-C", tmpDir, "branch", "--list", "mullion/my-feature"],
      {
        env: gitEnv(),
      },
    ).toString();
    expect(branchListOutput).toContain("mullion/my-feature");
  });

  it("branches off the given baseRef, not just HEAD", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    git(tmpDir, ["checkout", "-b", "other-branch"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");
    git(tmpDir, ["checkout", "main"]);

    const result = await createWorktree({
      cwd: tmpDir,
      baseRef: "other-branch",
      seed: "off-other",
    });
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(result?.path ?? "", "b.txt"))).toBe(true);
  });

  it("honors an explicit branchName override, sanitizing each path segment", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const result = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "seed-1",
      branchName: "feature/my cool branch!",
    });
    expect(result?.branch).toBe("feature/my-cool-branch");
  });

  it("adds the base directory to .git/info/exclude so the parent repo's status stays clean", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "s1" });
    const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.mullion-worktrees/");

    const status = execFileSync("git", ["-C", tmpDir, "status", "--porcelain"], {
      env: gitEnv(),
    }).toString();
    expect(status.trim()).toBe("");
  });

  it("routes every git call through gitEnv() — a leaked GIT_DIR must not redirect it (issue #205)", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");

    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-other-repo-"));
    initRepo(otherRepo);

    const originalEnv = { ...process.env };
    try {
      process.env.GIT_DIR = path.join(otherRepo, ".git");
      const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "env-leak-guard" });
      expect(result).not.toBeNull();
      expect(result?.path).toBe(path.join(tmpDir, ".mullion-worktrees", "env-leak-guard"));
    } finally {
      process.env = originalEnv;
      fs.rmSync(otherRepo, { recursive: true, force: true });
    }
  });
});

describe("checkoutBranchWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-checkout-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a non-git-repo directory", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    try {
      expect(await checkoutBranchWorktree(nonGit, "main")).toBeNull();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns null for a relative cwd", async () => {
    const relative = path.relative(process.cwd(), tmpDir);
    expect(await checkoutBranchWorktree(relative, "main")).toBeNull();
  });

  it("returns null for an empty branch name", async () => {
    expect(await checkoutBranchWorktree(tmpDir, "")).toBeNull();
  });

  it("rejects a branch name starting with '-'", async () => {
    expect(await checkoutBranchWorktree(tmpDir, "-x")).toBeNull();
  });

  it("creates a preview worktree under .mullion-worktrees with hash suffix", async () => {
    const result = await checkoutBranchWorktree(tmpDir, "main");
    expect(result).not.toBeNull();
    expect(result?.branch).toBe("main");
    expect(result?.path).toMatch(/dock-preview-main-[0-9a-f]{6}$/);
    expect(result?.path).toContain(".mullion-worktrees");
    expect(fs.existsSync(result?.path ?? "")).toBe(true);
  });

  it("succeeds even when the branch is already checked out in the primary worktree", async () => {
    // `main` is checked out in tmpDir (the primary) throughout this whole
    // describe block. Regression guard: this must keep succeeding — it's
    // the entire point of using --detach instead of the old --force, which
    // only worked here because it overrode git's "already checked out
    // elsewhere" safeguard rather than avoiding the conflict altogether.
    const result = await checkoutBranchWorktree(tmpDir, "main");
    expect(result).not.toBeNull();
  });

  it("checks out the preview with a DETACHED HEAD, not a real branch checkout", async () => {
    const result = await checkoutBranchWorktree(tmpDir, "main");
    expect(result).not.toBeNull();
    // The returned `branch` is the preview's *intent* — which branch this is
    // previewing — even though HEAD itself is detached.
    expect(result?.branch).toBe("main");

    // git's own porcelain agrees — this is exactly what Dock.tsx's option
    // list reads, and why a preview worktree must be filtered out of the
    // worktree options there (a null branch would otherwise show up labeled
    // by its raw path).
    const wts = await listWorktrees(tmpDir);
    const entry = wts?.find((w) => isDockPreviewWorktree(w.path));
    expect(entry).toBeDefined();
    expect(entry?.branch).toBeNull();

    // `git symbolic-ref` only resolves for a real branch checkout; it fails
    // for a detached HEAD.
    expect(() =>
      execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
        cwd: result!.path,
        stdio: "pipe",
        env: gitEnv(),
      }),
    ).toThrow();

    // Detached, but still at the branch's current tip.
    expect(revParse(result!.path, "HEAD")).toBe(revParse(tmpDir, "refs/heads/main"));
  });

  it("works for feature branches with slashes", async () => {
    git(tmpDir, ["checkout", "-b", "feature/my-feature"]);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "feature commit");

    const result = await checkoutBranchWorktree(tmpDir, "feature/my-feature");
    expect(result).not.toBeNull();
    expect(fs.existsSync(result?.path ?? "")).toBe(true);

    // Verify it checked out the right branch content
    expect(fs.existsSync(path.join(result?.path ?? "", "b.txt"))).toBe(true);
  });

  it("produces distinct directories for collision-prone names", async () => {
    git(tmpDir, ["checkout", "-b", "feature/foo"]);
    git(tmpDir, ["checkout", "-b", "feature--foo"]);
    git(tmpDir, ["checkout", "main"]);

    const r1 = await checkoutBranchWorktree(tmpDir, "feature/foo");
    const r2 = await checkoutBranchWorktree(tmpDir, "feature--foo");
    // Both should succeed with different paths (hash suffix disambiguates)
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.path).not.toBe(r2?.path);
  });

  it("adds .mullion-worktrees to .git/info/exclude", async () => {
    await checkoutBranchWorktree(tmpDir, "main");
    const exclude = fs.readFileSync(path.join(tmpDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.mullion-worktrees/");
  });

  it("recovers from a stale worktree registration left behind by a manual rm -rf (crash recovery)", async () => {
    const first = await checkoutBranchWorktree(tmpDir, "main");
    expect(first).not.toBeNull();
    // Simulate a crash: the directory is gone, but `.git/worktrees/<name>`
    // still remembers it — without the pre-add `worktree prune`, git refuses
    // to reuse this deterministic path forever, 502ing every future preview
    // of this branch.
    fs.rmSync(first!.path, { recursive: true, force: true });

    const second = await checkoutBranchWorktree(tmpDir, "main");
    expect(second).not.toBeNull();
    expect(second?.path).toBe(first?.path);
    expect(fs.existsSync(second!.path)).toBe(true);
  });
});

describe("removeWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-remove-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a preview worktree created by checkoutBranchWorktree", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    const removed = await removeWorktree(created!.path, tmpDir);
    expect(removed).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("removes a dirty worktree with --force", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    // Dirty the worktree with an uncommitted change
    fs.writeFileSync(path.join(created!.path, "dirty.txt"), "dirty");
    expect(fs.existsSync(path.join(created!.path, "dirty.txt"))).toBe(true);

    // Should succeed even though the worktree is dirty (--force)
    const removed = await removeWorktree(created!.path, tmpDir);
    expect(removed).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("returns false for a non-existent worktree path", async () => {
    const removed = await removeWorktree("/nonexistent/path");
    expect(removed).toBe(false);
  });

  it("serializes a concurrent sync and removal on the same path instead of racing", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    // Whichever order the two land in, neither call may reject (a rejection
    // would mean `git worktree remove --force` and `git reset --hard` ran
    // concurrently and corrupted the worktree's administrative files), and
    // the removal must ultimately win — a sync that loses the race sees
    // `removingPaths` and bails with `false` rather than re-materializing
    // files git is about to delete.
    const [synced, removed] = await Promise.all([
      syncWorktree(created!.path, "main"),
      removeWorktree(created!.path, tmpDir),
    ]);
    expect(typeof synced).toBe("boolean");
    expect(removed).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
  });
});

describe("syncWorktree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-sync-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    // Deliberately NO remote configured anywhere in this describe (except
    // where a test adds one itself) — syncWorktree resets to the LOCAL
    // branch ref, not a remote-tracking one, and every test here doubles as
    // proof that this doesn't silently require an origin to exist. The old
    // implementation (`fetch origin <branch>` + `reset --hard
    // origin/<branch>`) failed — silently, forever — for exactly this case.
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("follows local commits on the default branch with no remote configured at all", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();

    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    commitAll(tmpDir, "second");

    const result = await syncWorktree(created!.path, "main");
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(created!.path, "b.txt"))).toBe(true);
    expect(revParse(created!.path, "HEAD")).toBe(revParse(tmpDir, "refs/heads/main"));
  });

  it("follows an unpushed commit on a non-default branch with no upstream", async () => {
    git(tmpDir, ["checkout", "-b", "topic"]);
    const created = await checkoutBranchWorktree(tmpDir, "topic");
    expect(created).not.toBeNull();

    fs.writeFileSync(path.join(tmpDir, "c.txt"), "c");
    commitAll(tmpDir, "topic advance");

    expect(await syncWorktree(created!.path, "topic")).toBe(true);
    expect(fs.existsSync(path.join(created!.path, "c.txt"))).toBe(true);
    expect(revParse(created!.path, "HEAD")).toBe(revParse(tmpDir, "refs/heads/topic"));
  });

  it(
    "never moves the primary checkout's branch ref when syncing a preview of that branch " +
      "(regression: the pre-detach implementation shared refs/heads/<branch> between the " +
      "preview and the primary, so this reset used to rewind the primary's HEAD)",
    async () => {
      // A stale bare "origin" is load-bearing here, not incidental: it is
      // exactly what made the pre-fix code (fetch origin + reset --hard
      // origin/<branch>, against a worktree checked out via --force rather
      // than --detach) rewind the SHARED refs/heads/main out from under the
      // primary checkout. Post-fix, syncWorktree never touches origin at
      // all, so its staleness is irrelevant — do not delete this setup as
      // dead weight.
      const staleOrigin = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-stale-origin-"));
      try {
        git(tmpDir, ["clone", "--bare", tmpDir, staleOrigin]);
        git(tmpDir, ["remote", "add", "origin", staleOrigin]);
        git(tmpDir, ["fetch", "origin"]);

        const preview = await checkoutBranchWorktree(tmpDir, "main");
        expect(preview).not.toBeNull();

        // The primary advances main locally (never pushed) and has
        // uncommitted work sitting on top.
        fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
        commitAll(tmpDir, "second");
        fs.writeFileSync(path.join(tmpDir, "a.txt"), "uncommitted work in the primary");

        const primaryHeadBefore = revParse(tmpDir, "HEAD");
        const statusBefore = execFileSync("git", ["status", "--porcelain"], {
          cwd: tmpDir,
          stdio: "pipe",
          env: gitEnv(),
        }).toString();

        expect(await syncWorktree(preview!.path, "main")).toBe(true);

        // --- discriminating assertions: these read the STALE origin's tip
        // (pre-fix behavior) rather than the primary's actual local advance
        // if the shared-ref bug is reintroduced. ---
        expect(revParse(tmpDir, "HEAD")).toBe(primaryHeadBefore);
        expect(revParse(tmpDir, "refs/heads/main")).toBe(primaryHeadBefore);
        expect(
          execFileSync("git", ["status", "--porcelain"], {
            cwd: tmpDir,
            stdio: "pipe",
            env: gitEnv(),
          }).toString(),
        ).toBe(statusBefore);

        // The preview followed the LOCAL branch tip, not the stale origin.
        expect(fs.existsSync(path.join(preview!.path, "b.txt"))).toBe(true);

        // --- invariant documentation: reset --hard in a detached preview
        // never touches the primary's own working tree or symbolic HEAD. ---
        expect(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8")).toBe(
          "uncommitted work in the primary",
        );
        expect(
          execFileSync("git", ["symbolic-ref", "HEAD"], {
            cwd: tmpDir,
            stdio: "pipe",
            env: gitEnv(),
          })
            .toString()
            .trim(),
        ).toBe("refs/heads/main");
      } finally {
        fs.rmSync(staleOrigin, { recursive: true, force: true });
      }
    },
  );

  it("returns false for a non-existent worktree", async () => {
    const result = await syncWorktree("/nonexistent", "main");
    expect(result).toBe(false);
  });

  it("returns false for an empty branch name", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(await syncWorktree(created!.path, "")).toBe(false);
  });

  it("rejects a branch name starting with '-'", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(await syncWorktree(created!.path, "-x")).toBe(false);
  });
});

describe("cleanupPreviewWorktree (pendingRemoval retry)", () => {
  let tmpDir: string;
  // A distinct, high sessionId per test avoids colliding with anything else
  // touching the shared module-level previewWorktrees map within this file.
  let sessionId: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-cleanup-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    sessionId = Math.floor(Math.random() * 1_000_000) + 900_000;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks the entry pendingRemoval on a failed removal, then clears it once removal succeeds", async () => {
    trackPreviewWorktree(sessionId, {
      worktreePath: "/nonexistent/path",
      branch: "main",
      worktreeRefresh: false,
      parentCwd: "/nonexistent",
      projectId: 1,
    });

    const warn = vi.fn();
    // git-worktree.remove --force against a path that was never a real
    // worktree fails, exactly like removeWorktree's own
    // "returns false for a non-existent worktree path" test above.
    const firstAttempt = await cleanupPreviewWorktree(sessionId, { warn });
    expect(firstAttempt).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, worktreePath: "/nonexistent/path" }),
      expect.stringContaining("marked for retry"),
    );
    // This is what makes the retry real: the entry survives the failed
    // attempt (rather than being silently dropped) so a later cleanup call
    // — from killSession or the reconciler's next pass, or the sync tick's
    // own pendingRemoval branch — gets another chance at it.
    expect(getPreviewWorktree(sessionId)?.pendingRemoval).toBe(true);

    // Re-point the tracked entry at a real, removable worktree and confirm
    // a second cleanup attempt succeeds and clears it from the map.
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();
    trackPreviewWorktree(sessionId, {
      worktreePath: created!.path,
      branch: "main",
      worktreeRefresh: false,
      parentCwd: tmpDir,
      projectId: 1,
    });

    const secondAttempt = await cleanupPreviewWorktree(sessionId, { warn });
    expect(secondAttempt).toBe(true);
    expect(getPreviewWorktree(sessionId)).toBeUndefined();
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("returns true with no side effects when nothing is tracked for the session", async () => {
    expect(await cleanupPreviewWorktree(sessionId)).toBe(true);
    expect(getPreviewWorktree(sessionId)).toBeUndefined();
  });
});

describe("isDockPreviewWorktree", () => {
  it("returns true for paths under the dock-preview prefix", () => {
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/dock-preview-feature-foo-a1b2c3")).toBe(
      true,
    );
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/dock-preview-main-123abc")).toBe(true);
  });

  it("returns false for non-preview worktree paths", () => {
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/my-feature")).toBe(false);
    expect(isDockPreviewWorktree("/tmp/.mullion-worktrees/mullion/task-42")).toBe(false);
  });

  it("returns false for paths outside .mullion-worktrees", () => {
    expect(isDockPreviewWorktree("/tmp/other-path")).toBe(false);
  });
});

describe("deriveWorktreePath", () => {
  it("collapses a slash-containing seed to the same dash-joined name createWorktree actually produces", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-derive-"));
    try {
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      commitAll(tmpDir, "initial");

      const predicted = deriveWorktreePath(tmpDir, "mullion/task-7");
      const created = await createWorktree({
        cwd: tmpDir,
        baseRef: "main",
        seed: "mullion/task-7",
      });
      expect(created).not.toBeNull();
      expect(created!.path).toBe(predicted);
      expect(path.basename(predicted)).toBe("mullion-task-7");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects an explicit baseDir override", () => {
    expect(deriveWorktreePath("/repo", "seed", "/custom/base")).toBe("/custom/base/seed");
  });
});

describe("removeWorktreeIfClean (issue #283)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-clean-remove-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a clean worktree", async () => {
    const created = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-1" });
    expect(created).not.toBeNull();

    const result = await removeWorktreeIfClean(created!.path, tmpDir);
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(created!.path)).toBe(false);
  });

  it("refuses a worktree with uncommitted changes, leaving it in place", async () => {
    const created = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-2" });
    expect(created).not.toBeNull();
    fs.writeFileSync(path.join(created!.path, "dirty.txt"), "uncommitted");

    const result = await removeWorktreeIfClean(created!.path, tmpDir);
    expect(result).toEqual({ removed: false, reason: "dirty" });
    expect(fs.existsSync(created!.path)).toBe(true);
  });

  it("refuses a worktree with unresolved merge conflicts, leaving it in place", async () => {
    const created = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-3" });
    expect(created).not.toBeNull();

    // Diverge the worktree's branch and main on the same file, then merge
    // main into the worktree to produce a real, unresolved conflict.
    fs.writeFileSync(path.join(created!.path, "a.txt"), "worktree-version");
    git(created!.path, ["add", "-A"]);
    git(created!.path, ["commit", "-m", "worktree change", "--no-verify"]);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "main-version");
    commitAll(tmpDir, "main change");
    try {
      git(created!.path, ["merge", "main"]);
    } catch {
      // Expected — the merge conflicts and exits non-zero.
    }

    const result = await removeWorktreeIfClean(created!.path, tmpDir);
    expect(result).toEqual({ removed: false, reason: "conflicts" });
    expect(fs.existsSync(created!.path)).toBe(true);
  });

  it("returns not-a-repo for a nonexistent path", async () => {
    const result = await removeWorktreeIfClean(path.join(tmpDir, "does-not-exist"), tmpDir);
    expect(result).toEqual({ removed: false, reason: "not-a-repo" });
  });
});

describe("listTaskWorktreeDirs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-list-task-dirs-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists only task-worktree-prefixed directories, ignoring dock-preview and other entries", async () => {
    const task = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-9" });
    expect(task).not.toBeNull();
    const preview = await checkoutBranchWorktree(tmpDir, "main");
    expect(preview).not.toBeNull();
    fs.mkdirSync(path.join(tmpDir, ".mullion-worktrees", "not-a-worktree-dir"));

    const dirs = listTaskWorktreeDirs(tmpDir);
    expect(dirs).toEqual([task!.path]);
  });

  it("returns [] when .mullion-worktrees doesn't exist", () => {
    expect(listTaskWorktreeDirs(tmpDir)).toEqual([]);
  });

  it("returns [] for a relative or unsafe cwd", () => {
    expect(listTaskWorktreeDirs(path.relative(process.cwd(), tmpDir))).toEqual([]);
    expect(listTaskWorktreeDirs(path.join(tmpDir, "..", path.basename(tmpDir)))).toEqual([]);
  });
});

describe("pruneWorktrees (issue #283)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-prune-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a clean, explicitly-named orphan", async () => {
    const orphan = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-1" });
    expect(orphan).not.toBeNull();

    const result = await pruneWorktrees(tmpDir, [orphan!.path]);
    expect(result.removed).toEqual([orphan!.path]);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(orphan!.path)).toBe(false);
  });

  it("skips (never destroys) a dirty orphan", async () => {
    const orphan = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-2" });
    expect(orphan).not.toBeNull();
    fs.writeFileSync(path.join(orphan!.path, "dirty.txt"), "uncommitted");

    const result = await pruneWorktrees(tmpDir, [orphan!.path]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path: orphan!.path, reason: "dirty" }]);
    expect(fs.existsSync(orphan!.path)).toBe(true);
  });

  it("skips a path outside .mullion-worktrees even if the caller passes one — defense in depth", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-prune-outside-"));
    try {
      const result = await pruneWorktrees(tmpDir, [outside]);
      expect(result.removed).toEqual([]);
      expect(result.skipped).toEqual([{ path: outside, reason: "outside-worktree-dir" }]);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips a worktree under .mullion-worktrees that isn't a task worktree (e.g. a dock preview)", async () => {
    const preview = await checkoutBranchWorktree(tmpDir, "main");
    expect(preview).not.toBeNull();

    const result = await pruneWorktrees(tmpDir, [preview!.path]);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path: preview!.path, reason: "not-a-task-worktree" }]);
    expect(fs.existsSync(preview!.path)).toBe(true);
  });

  it("an empty orphanPaths list is a no-op — never treated as 'remove everything'", async () => {
    const stillHere = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-3",
    });
    expect(stillHere).not.toBeNull();

    const result = await pruneWorktrees(tmpDir, []);
    expect(result).toEqual({ removed: [], skipped: [] });
    expect(fs.existsSync(stillHere!.path)).toBe(true);
  });
});
