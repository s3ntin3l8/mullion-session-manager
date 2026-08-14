import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkoutBranchWorktree,
  clearOrphanedTaskWorktree,
  cleanupPreviewWorktree,
  createWorktree,
  deletePreviewWorktree,
  deriveWorktreePath,
  ensurePreviewSyncTick,
  findPreviewWorktreeSessionId,
  getPreviewWorktree,
  isDockPreviewWorktree,
  listTaskWorktreeDirs,
  pruneWorktreeMetadata,
  pruneWorktrees,
  removeListedWorktree,
  removeWorktree,
  removeWorktreeIfClean,
  resumeTaskWorktree,
  stopPreviewSyncTick,
  syncTimerHasRefForTests,
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

  // Issue #677 — createWorktree now returns a discriminated
  // CreateWorktreeResult (`{created, reason?, detail?}`) instead of a bare
  // `null`, so a caller can surface WHY creation failed.
  it("classifies a non-git-repo directory as not-a-repo", async () => {
    const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "s1" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("not-a-repo");
  });

  it("classifies a relative cwd as invalid-cwd, even one that would otherwise resolve correctly", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const relative = path.relative(process.cwd(), tmpDir);
    const result = await createWorktree({ cwd: relative, baseRef: "main", seed: "s1" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("invalid-cwd");
  });

  it("classifies an unresolvable baseRef as no-such-ref", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const result = await createWorktree({ cwd: tmpDir, baseRef: "no-such-ref", seed: "s1" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("no-such-ref");
    expect(result.detail).toMatch(/invalid reference/i);
  });

  it("rejects a baseRef starting with '-' as invalid-base-ref — argument injection hardening, Hermes review on PR #277", async () => {
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
    const r1 = await createWorktree({ cwd: tmpDir, baseRef: "--force", seed: "s1" });
    expect(r1.created).toBe(false);
    expect(r1.reason).toBe("invalid-base-ref");
    const r2 = await createWorktree({ cwd: tmpDir, baseRef: "-x", seed: "s1" });
    expect(r2.created).toBe(false);
    expect(r2.reason).toBe("invalid-base-ref");
  });

  it("classifies a branch-name collision as branch-exists", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const first = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "collide",
      branchName: "mullion/collide",
    });
    expect(first.created).toBe(true);
    const second = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "collide-2",
      branchName: "mullion/collide",
    });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("branch-exists");
  });

  // Verified empirically (not guessed): `git worktree add` happily reuses
  // an EMPTY existing directory — only a non-empty one at the derived path
  // fails with "already exists". A retry after a partial prior attempt is
  // exactly how a real caller hits this (the same class of collision PR
  // #680's own worktree-leak fix addressed).
  it("classifies a non-empty pre-existing target directory as path-exists", async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    const worktreePath = deriveWorktreePath(tmpDir, "occupied");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "leftover.txt"), "leftover");

    const result = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "occupied" });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("path-exists");
    expect(result.detail).toMatch(/already exists/i);
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

describe("preview worktree host-routed remove/sync closures (issue #345)", () => {
  let tmpDir: string;
  let sessionId: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-closures-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    sessionId = Math.floor(Math.random() * 1_000_000) + 900_000;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanupPreviewWorktree calls the tracked entry's remove closure instead of local git when present", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    trackPreviewWorktree(sessionId, {
      worktreePath: "/some/remote/path",
      branch: "main",
      worktreeRefresh: false,
      parentCwd: "/some/remote",
      projectId: 1,
      hostId: "remote-1",
      remove,
    });

    expect(await cleanupPreviewWorktree(sessionId)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(getPreviewWorktree(sessionId)).toBeUndefined();
    // Never touched the local filesystem — the path doesn't even exist.
  });

  it("cleanupPreviewWorktree marks pendingRemoval when the remove closure resolves false, without local git", async () => {
    const remove = vi.fn().mockResolvedValue(false);
    trackPreviewWorktree(sessionId, {
      worktreePath: "/some/remote/path",
      branch: "main",
      worktreeRefresh: false,
      parentCwd: "/some/remote",
      projectId: 1,
      hostId: "remote-1",
      remove,
    });

    const warn = vi.fn();
    expect(await cleanupPreviewWorktree(sessionId, { warn })).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(getPreviewWorktree(sessionId)?.pendingRemoval).toBe(true);
    // hostId is diagnostic-only (never consulted for routing — see
    // PreviewWorktreeInfo's own doc comment) but must actually reach the
    // log, or the field earns nothing for carrying it around.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-1" }),
      expect.any(String),
    );
  });

  it("a remove closure that rejects (violating its own never-reject contract) is treated as a failed attempt, not an escaping error", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("boom"));
    trackPreviewWorktree(sessionId, {
      worktreePath: "/some/remote/path",
      branch: "main",
      worktreeRefresh: false,
      parentCwd: "/some/remote",
      projectId: 1,
      hostId: "remote-1",
      remove,
    });

    await expect(cleanupPreviewWorktree(sessionId)).resolves.toBe(false);
    expect(getPreviewWorktree(sessionId)?.pendingRemoval).toBe(true);
  });

  it("omitting the closures preserves today's local-only behavior (falls back to real git)", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();
    trackPreviewWorktree(sessionId, {
      worktreePath: created!.path,
      branch: "main",
      worktreeRefresh: false,
      parentCwd: tmpDir,
      projectId: 1,
    });

    expect(await cleanupPreviewWorktree(sessionId)).toBe(true);
    expect(fs.existsSync(created!.path)).toBe(false);
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

describe("removeListedWorktree (issue #442)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-remove-listed-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns not-listed for a path git worktree list doesn't report", async () => {
    const result = await removeListedWorktree(tmpDir, path.join(tmpDir, "not-a-worktree"));
    expect(result).toEqual({ removed: false, reason: "not-listed" });
  });

  it("refuses to remove the main worktree, even under force", async () => {
    expect(await removeListedWorktree(tmpDir, tmpDir)).toEqual({
      removed: false,
      reason: "is-main",
    });
    expect(await removeListedWorktree(tmpDir, tmpDir, { force: true })).toEqual({
      removed: false,
      reason: "is-main",
    });
    expect(fs.existsSync(tmpDir)).toBe(true);
  });

  it("removes a clean, hand-made `git worktree add` worktree — not just a mullion-task-prefixed one", async () => {
    const linkedPath = `${tmpDir}-hand-made`;
    git(tmpDir, ["worktree", "add", "-b", "hand-made-branch", linkedPath]);

    const result = await removeListedWorktree(tmpDir, linkedPath);
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(linkedPath)).toBe(false);
  });

  // Hermes review on PR #505 — the exact "Prune stale" scenario: git still
  // lists this worktree, but its directory is already gone (an out-of-band
  // `rm -rf`). Must report the distinct `directory-gone` reason, not the
  // misleading `not-a-repo` the safe path's getGitStatus would otherwise
  // produce for a missing directory — and under force, too, even though
  // `git worktree remove --force` would silently succeed on its own here
  // (verified empirically): that's exactly what pruneWorktreeMetadata
  // already exists to do, so this points the caller there instead.
  it.each([
    ["safe", undefined],
    ["force", { force: true }],
  ])(
    "reports directory-gone (%s path) when the listed worktree's directory no longer exists",
    async (_label, opts) => {
      const linkedPath = `${tmpDir}-gone`;
      git(tmpDir, ["worktree", "add", "-b", "gone-branch", linkedPath]);
      fs.rmSync(linkedPath, { recursive: true, force: true });

      const result = await removeListedWorktree(tmpDir, linkedPath, opts);
      expect(result).toEqual({ removed: false, reason: "directory-gone" });
    },
  );

  it("refuses a dirty worktree without force", async () => {
    const linkedPath = `${tmpDir}-dirty`;
    git(tmpDir, ["worktree", "add", "-b", "dirty-branch", linkedPath]);
    fs.writeFileSync(path.join(linkedPath, "dirty.txt"), "uncommitted");

    const result = await removeListedWorktree(tmpDir, linkedPath);
    expect(result).toEqual({ removed: false, reason: "dirty" });
    expect(fs.existsSync(linkedPath)).toBe(true);

    fs.rmSync(linkedPath, { recursive: true, force: true });
    await pruneWorktreeMetadata(tmpDir);
  });

  it("removes a dirty worktree under force", async () => {
    const linkedPath = `${tmpDir}-dirty-force`;
    git(tmpDir, ["worktree", "add", "-b", "dirty-force-branch", linkedPath]);
    fs.writeFileSync(path.join(linkedPath, "dirty.txt"), "uncommitted");

    const result = await removeListedWorktree(tmpDir, linkedPath, { force: true });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(linkedPath)).toBe(false);
  });

  it("under force, stops tracking a matched dock-preview session BEFORE removing it (preview-registry fix)", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();
    // A distinct, high sessionId avoids colliding with anything else
    // touching the shared module-level previewWorktrees map in this file.
    const sessionId = Math.floor(Math.random() * 1_000_000) + 800_000;
    trackPreviewWorktree(sessionId, {
      worktreePath: created!.path,
      branch: "main",
      worktreeRefresh: true,
      parentCwd: tmpDir,
      projectId: 1,
    });
    expect(findPreviewWorktreeSessionId(created!.path)).toBe(sessionId);

    const result = await removeListedWorktree(tmpDir, created!.path, { force: true });
    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(created!.path)).toBe(false);
    // The whole point of the fix: the map entry is gone, so the 5s sync
    // tick stops referencing a path that no longer exists.
    expect(getPreviewWorktree(sessionId)).toBeUndefined();
  });

  it("re-tracks a matched dock-preview session when the force removal itself fails (Hermes review, PR #505)", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();
    const sessionId = Math.floor(Math.random() * 1_000_000) + 800_000;
    const previewInfo = {
      worktreePath: created!.path,
      branch: "main",
      worktreeRefresh: true,
      parentCwd: tmpDir,
      projectId: 1,
    };
    trackPreviewWorktree(sessionId, previewInfo);

    // Force `git worktree remove` itself to fail (a real, reproducible
    // failure, not a mock — this repo's own test convention) by denying
    // write access to the main repo's shared worktree admin directory,
    // which `git worktree remove` must update regardless of --force.
    const adminDir = path.join(tmpDir, ".git", "worktrees");
    fs.chmodSync(adminDir, 0o500);
    try {
      const result = await removeListedWorktree(tmpDir, created!.path, { force: true });
      expect(result).toEqual({ removed: false, reason: "remove-failed" });
      // The whole point of the fix: a failed removal must not permanently
      // and silently stop the sync tick for a worktree that's still on
      // disk — the entry is re-tracked exactly as it was.
      expect(getPreviewWorktree(sessionId)).toEqual(previewInfo);
    } finally {
      fs.chmodSync(adminDir, 0o700);
      deletePreviewWorktree(sessionId);
    }
  });

  it("does not touch the preview registry on the safe (non-force) path", async () => {
    const created = await checkoutBranchWorktree(tmpDir, "main");
    expect(created).not.toBeNull();
    const sessionId = Math.floor(Math.random() * 1_000_000) + 800_000;
    trackPreviewWorktree(sessionId, {
      worktreePath: created!.path,
      branch: "main",
      worktreeRefresh: true,
      parentCwd: tmpDir,
      projectId: 1,
    });

    const result = await removeListedWorktree(tmpDir, created!.path);
    expect(result).toEqual({ removed: true });
    // Still tracked — the safe path never consults findPreviewWorktreeSessionId
    // (its cleanup is the live-session guard's job, on the primary route).
    expect(getPreviewWorktree(sessionId)).toEqual(
      expect.objectContaining({ worktreePath: created!.path }),
    );
    deletePreviewWorktree(sessionId);
  });

  it("returns not-a-repo for a non-git-repo directory", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-remove-listed-non-repo-"));
    try {
      expect(await removeListedWorktree(nonGit, path.join(nonGit, "x"))).toEqual({
        removed: false,
        reason: "not-a-repo",
      });
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("pruneWorktreeMetadata (issue #442)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-prune-metadata-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears administrative metadata for a worktree whose directory was removed out of band", async () => {
    const linkedPath = `${tmpDir}-oob-removed`;
    git(tmpDir, ["worktree", "add", "-b", "oob-branch", linkedPath]);
    // Simulate `rm -rf` done outside git's own bookkeeping — git worktree
    // remove is deliberately NOT used here, since that would already prune.
    fs.rmSync(linkedPath, { recursive: true, force: true });

    const before = await listWorktrees(tmpDir);
    expect(before?.some((w) => w.path === linkedPath)).toBe(true);

    expect(await pruneWorktreeMetadata(tmpDir)).toEqual({ pruned: true });

    const after = await listWorktrees(tmpDir);
    expect(after?.some((w) => w.path === linkedPath)).toBe(false);
  });

  it("is idempotent — a second call with nothing to prune still reports pruned: true", async () => {
    expect(await pruneWorktreeMetadata(tmpDir)).toEqual({ pruned: true });
    expect(await pruneWorktreeMetadata(tmpDir)).toEqual({ pruned: true });
  });

  it("never removes a worktree that still exists on disk", async () => {
    const linkedPath = `${tmpDir}-still-here`;
    git(tmpDir, ["worktree", "add", "-b", "still-here-branch", linkedPath]);

    await pruneWorktreeMetadata(tmpDir);

    const after = await listWorktrees(tmpDir);
    expect(after?.some((w) => w.path === linkedPath)).toBe(true);
    expect(fs.existsSync(linkedPath)).toBe(true);

    fs.rmSync(linkedPath, { recursive: true, force: true });
    await pruneWorktreeMetadata(tmpDir);
  });

  it("returns pruned: false for a relative or unsafe cwd", async () => {
    expect(await pruneWorktreeMetadata(path.relative(process.cwd(), tmpDir))).toEqual({
      pruned: false,
    });
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

describe("clearOrphanedTaskWorktree (issue #283)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-clear-orphan-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears both the worktree AND the branch ref for a normal clean leftover, so a fresh worktree add -b succeeds", async () => {
    // branchName explicitly matches seed, same as task-claim.ts's real
    // usage (createWorktree's own branch default would otherwise derive
    // "mullion/mullion-task-1", not "mullion/task-1").
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-1",
      branchName: "mullion/task-1",
    });
    expect(created).not.toBeNull();

    const result = await clearOrphanedTaskWorktree(tmpDir, created!.path, "mullion/task-1");

    expect(result).toEqual({ cleared: true });
    expect(fs.existsSync(created!.path)).toBe(false);
    // Branch is gone too — re-adding at the same path/branch no longer
    // collides on the branch ref (this is what removeWorktreeIfClean alone
    // does NOT provide — see this function's own doc comment).
    const retry = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-1",
      branchName: "mullion/task-1",
    });
    expect(retry).not.toBeNull();
  });

  it("clears a non-empty, non-git leftover directory too (Hermes review, PR #476) — a git worktree add killed mid-flight leaves the branch ref AND a half-written, not-yet-a-repo directory behind, and both must go for a retry to succeed", async () => {
    const worktreePath = deriveWorktreePath(tmpDir, "mullion/task-2");
    // Simulate the branch-created-before-directory-is-valid ordering a real
    // killed `git worktree add -b` leaves behind: the branch exists...
    git(tmpDir, ["branch", "mullion/task-2", "main"]);
    // ...and a non-empty directory sits at the worktree path, but isn't
    // itself a valid git worktree (no .git file/dir) — `removeWorktreeIfClean`
    // alone reports this as "not-a-repo" and leaves the directory in place,
    // which still blocks `git worktree add` (refuses a non-empty target).
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "partial.txt"), "half-written");

    const result = await clearOrphanedTaskWorktree(tmpDir, worktreePath, "mullion/task-2");

    expect(result).toEqual({ cleared: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
    const retry = await createWorktree({ cwd: tmpDir, baseRef: "main", seed: "mullion/task-2" });
    expect(retry).not.toBeNull();
    expect(retry!.path).toBe(worktreePath);
  });

  it("never deletes a non-repo directory outside .mullion-worktrees, even if a caller passes one — defense in depth", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-clear-orphan-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "not-yours.txt"), "do not touch");

      const result = await clearOrphanedTaskWorktree(tmpDir, outside, "mullion/task-3");

      expect(result).toEqual({ cleared: false, reason: "path outside .mullion-worktrees" });
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses (clearing neither worktree nor branch) when the leftover worktree is dirty", async () => {
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-4",
      branchName: "mullion/task-4",
    });
    expect(created).not.toBeNull();
    fs.writeFileSync(path.join(created!.path, "dirty.txt"), "uncommitted");

    const result = await clearOrphanedTaskWorktree(tmpDir, created!.path, "mullion/task-4");

    expect(result).toEqual({ cleared: false, reason: "dirty" });
    expect(fs.existsSync(created!.path)).toBe(true);
    const branches = execFileSync("git", ["branch", "--list", "mullion/task-4"], {
      cwd: tmpDir,
      env: gitEnv(),
    }).toString();
    expect(branches).toContain("mullion/task-4");
  });

  it("is a true no-op when nothing exists at the worktree path and no branch exists either", async () => {
    const worktreePath = deriveWorktreePath(tmpDir, "mullion/task-5");

    const result = await clearOrphanedTaskWorktree(tmpDir, worktreePath, "mullion/task-5");

    expect(result).toEqual({ cleared: true });
  });

  it("refuses (never deletes) a stray branch when no directory content justified deleting it (independent review, PR #476) — this is exactly the shape a properly-failed task's preserved-on-purpose work leaves behind", async () => {
    // Mirrors the real →failed lifecycle: removeWorktreeIfClean (not
    // clearOrphanedTaskWorktree) already cleanly removed the worktree
    // directory, deliberately leaving the branch — and its commit — intact.
    const throwawayPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-throwaway-"));
    fs.rmdirSync(throwawayPath); // git worktree add refuses a pre-existing dir
    git(tmpDir, ["branch", "mullion/task-5", "main"]);
    git(tmpDir, ["worktree", "add", throwawayPath, "mullion/task-5"]);
    fs.writeFileSync(path.join(throwawayPath, "work.txt"), "real committed work");
    git(throwawayPath, ["add", "-A"]);
    git(throwawayPath, ["commit", "-m", "agent did real work", "--no-verify"]);
    git(tmpDir, ["worktree", "remove", throwawayPath]);

    const worktreePath = deriveWorktreePath(tmpDir, "mullion/task-5");
    const result = await clearOrphanedTaskWorktree(tmpDir, worktreePath, "mullion/task-5");

    expect(result).toEqual({
      cleared: false,
      reason: "stale branch from a prior attempt exists — resolve manually",
    });
    const branches = execFileSync("git", ["branch", "--list", "mullion/task-5"], {
      cwd: tmpDir,
      env: gitEnv(),
    }).toString();
    expect(branches).toContain("mullion/task-5");
    // The commit itself is still reachable — nothing was lost.
    const log = execFileSync("git", ["log", "mullion/task-5", "--oneline"], {
      cwd: tmpDir,
      env: gitEnv(),
    }).toString();
    expect(log).toContain("agent did real work");
  });

  it("still deletes the branch when this call itself found and removed real directory content — provably zero commits beyond baseRef", async () => {
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-6",
      branchName: "mullion/task-6",
    });
    expect(created).not.toBeNull();

    const result = await clearOrphanedTaskWorktree(tmpDir, created!.path, "mullion/task-6");

    expect(result).toEqual({ cleared: true });
    const branches = execFileSync("git", ["branch", "--list", "mullion/task-6"], {
      cwd: tmpDir,
      env: gitEnv(),
    }).toString();
    expect(branches).not.toContain("mullion/task-6");
  });

  it("never deletes a branch outside the mullion/task-<id> namespace, even when directory content was cleared (independent review, PR #476 — defense in depth)", async () => {
    // Not something task-claim.ts ever produces (it only ever derives
    // `mullion/task-<task.id>`) — this simulates a caller that reused this
    // function/route incorrectly.
    git(tmpDir, ["branch", "someone-elses-feature-branch", "main"]);
    const worktreePath = deriveWorktreePath(tmpDir, "mullion/task-not-actually-used-as-branch");

    const result = await clearOrphanedTaskWorktree(
      tmpDir,
      worktreePath,
      "someone-elses-feature-branch",
    );

    expect(result).toEqual({ cleared: true });
    const branches = execFileSync("git", ["branch", "--list", "someone-elses-feature-branch"], {
      cwd: tmpDir,
      env: gitEnv(),
    }).toString();
    expect(branches).toContain("someone-elses-feature-branch");
  });
});

describe("resumeTaskWorktree (#483)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-resume-"));
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    commitAll(tmpDir, "initial");
    clearGitStatusCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks out a preserved branch (real committed work, worktree already removed) into a fresh worktree at the same deterministic path", async () => {
    // Mirrors the real →failed lifecycle exactly like
    // clearOrphanedTaskWorktree's own "stale branch...resolve manually"
    // test above: removeWorktreeIfClean already cleanly removed the
    // worktree directory, deliberately leaving the branch (and its commit)
    // intact.
    const throwawayPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-throwaway-"));
    fs.rmdirSync(throwawayPath);
    git(tmpDir, ["branch", "mullion/task-7", "main"]);
    git(tmpDir, ["worktree", "add", throwawayPath, "mullion/task-7"]);
    fs.writeFileSync(path.join(throwawayPath, "work.txt"), "real committed work");
    git(throwawayPath, ["add", "-A"]);
    git(throwawayPath, ["commit", "-m", "agent did real work", "--no-verify"]);
    git(tmpDir, ["worktree", "remove", throwawayPath]);

    const result = await resumeTaskWorktree(tmpDir, "mullion/task-7");

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("mullion/task-7");
    expect(result!.path).toBe(deriveWorktreePath(tmpDir, "mullion/task-7"));
    // The prior commit is there — this is a real branch checkout, not a
    // fresh branch from baseRef.
    expect(fs.readFileSync(path.join(result!.path, "work.txt"), "utf8")).toBe(
      "real committed work",
    );
    // A real (non-detached) checkout — HEAD resolves to the branch itself.
    const headRef = execFileSync("git", ["symbolic-ref", "HEAD"], {
      cwd: result!.path,
      env: gitEnv(),
    }).toString();
    expect(headRef).toContain("mullion/task-7");
  });

  it("returns null when the branch doesn't exist", async () => {
    const result = await resumeTaskWorktree(tmpDir, "mullion/task-999");
    expect(result).toBeNull();
  });

  it("returns null when the branch is already checked out elsewhere (git worktree add refuses without --force)", async () => {
    const created = await createWorktree({
      cwd: tmpDir,
      baseRef: "main",
      seed: "mullion/task-8",
      branchName: "mullion/task-8",
    });
    expect(created).not.toBeNull();
    // Deliberately NOT removed — the branch is still checked out at
    // created!.path, so a second checkout must be refused.

    const result = await resumeTaskWorktree(tmpDir, "mullion/task-8");
    expect(result).toBeNull();
  });

  it("refuses a branch name outside the mullion/task-<id> namespace, even if it exists", async () => {
    git(tmpDir, ["branch", "someone-elses-feature-branch", "main"]);
    const result = await resumeTaskWorktree(tmpDir, "someone-elses-feature-branch");
    expect(result).toBeNull();
  });
});

describe("preview-worktree sync timer (B9 — .unref())", () => {
  afterEach(() => {
    // Best-effort: drain any refs a failed assertion left behind so this
    // doesn't bleed into a later test — the timer/refcount are module-level
    // singletons (see git-worktree.ts's own doc comment on previewWorktrees).
    // stopPreviewSyncTick() is a no-op once syncTickRefs hits 0, so this is
    // bounded rather than an unconditional `while`, which would spin forever
    // (turning a bug into a CI hang, not a failure) if that state were ever
    // reached with a non-null timer — unreachable today, but a bounded loop
    // costs nothing and fails loudly instead.
    for (let i = 0; i < 10 && syncTimerHasRefForTests() !== null; i++) {
      stopPreviewSyncTick();
    }
  });

  it("is unref'd so it never keeps the process alive on its own", () => {
    expect(syncTimerHasRefForTests()).toBeNull(); // nothing running yet
    ensurePreviewSyncTick();
    try {
      expect(syncTimerHasRefForTests()).toBe(false);
    } finally {
      stopPreviewSyncTick();
    }
    expect(syncTimerHasRefForTests()).toBeNull();
  });
});
