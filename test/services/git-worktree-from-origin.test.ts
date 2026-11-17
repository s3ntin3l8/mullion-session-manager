// Issue #3194 — a retry that was re-placed onto a host that never had the
// branch resumes it FROM origin.
//
// The git-level half of that: `resumeTaskWorktree(cwd, branch, { fromOrigin:
// true })` fetches the branch into a local ref and checks it out, where the
// ordinary resume must fail when the branch is missing locally (there the
// branch really is gone — fetching it would silently restart the task from
// a different commit).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createWorktree, resumeTaskWorktree } from "../../src/services/git-worktree.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

describe("resumeTaskWorktree from origin (#3194)", () => {
  let origin: string;
  let remote: string;
  let clone: string;

  beforeEach(async () => {
    // The shared remote both "hosts" push to and fetch from.
    remote = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-remote-"));
    git(remote, ["init", "--bare", "-b", "main"]);

    origin = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-origin-"));
    git(origin, ["init", "-b", "main"]);
    git(origin, ["remote", "add", "origin", remote]);
    fs.writeFileSync(path.join(origin, "a.txt"), "a");
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-m", "initial", "--no-verify"]);
    git(origin, ["push", "origin", "main"]);

    // The branch only ever exists on the "original" host: it is committed
    // there and pushed to origin from there.
    const branch = "mullion/task-8-from-origin";
    const created = await createWorktree({
      cwd: origin,
      baseRef: "main",
      seed: branch,
      branchName: branch,
    });
    expect(created.created).toBe(true);
    fs.writeFileSync(path.join(created.path as string, "wip.txt"), "work");
    git(created.path as string, ["add", "-A"]);
    git(created.path as string, ["commit", "-m", "agent work", "--no-verify"]);
    git(created.path as string, ["push", "origin", branch]);

    // The replacement host: a fresh clone that has the branch on origin but
    // never fetched it into a local ref.
    clone = fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-clone-"));
    git(clone, ["init", "-b", "main"]);
    git(clone, ["remote", "add", "origin", remote]);
    git(clone, ["fetch", "--quiet", "origin", "main"]);
    git(clone, ["reset", "--hard", "origin/main"]);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it("checks the branch out from origin when the host does not have it", async () => {
    const branch = "mullion/task-8-from-origin";

    // Without the flag: the branch is missing locally, so the resume fails
    // (the ordinary resume must never silently start over).
    expect(await resumeTaskWorktree(clone, branch)).toBeNull();

    // With it: the branch is fetched from origin and checked out.
    const result = await resumeTaskWorktree(clone, branch, { fromOrigin: true });
    expect(result).not.toBeNull();
    expect(result?.branch).toBe(branch);
    expect(fs.readFileSync(path.join(result!.path, "wip.txt"), "utf8")).toBe("work");
  });

  it("still fails when the branch is on neither the host nor origin", async () => {
    const result = await resumeTaskWorktree(clone, "mullion/task-8-nowhere", {
      fromOrigin: true,
    });
    expect(result).toBeNull();
  });

  // Issue #3194 — a branch ref outlives the worktree it was checked out in,
  // so a host that ran this task at some earlier point still holds a local
  // ref that is BEHIND origin. Resuming that ref would continue the task
  // from an older commit while the transition context says the branch is on
  // origin — the resume has to take origin's tip.
  it("resumes the ORIGIN tip when the host still holds a stale local ref", async () => {
    const branch = "mullion/task-8-from-origin";

    // The original host pushes one more commit, so origin's tip moves on.
    git(origin, ["checkout", "-q", "--detach", `refs/heads/${branch}`]);
    fs.writeFileSync(path.join(origin, "wip.txt"), "work2");
    git(origin, ["add", "-A"]);
    git(origin, ["commit", "-m", "more work", "--no-verify"]);
    // The commit is on a detached HEAD — push THAT onto the branch.
    git(origin, ["push", "origin", `HEAD:refs/heads/${branch}`]);

    // The replacement host has a STALE local ref for the branch: it ran this
    // task earlier, at an older commit, and the ref outlived the worktree.
    git(clone, ["fetch", "--quiet", "origin", "main"]);
    git(clone, ["branch", branch, "origin/main"]);

    const result = await resumeTaskWorktree(clone, branch, { fromOrigin: true });
    expect(result).not.toBeNull();
    // The origin tip, not the stale local ref.
    expect(fs.readFileSync(path.join(result!.path, "wip.txt"), "utf8")).toBe("work2");
  });

  it("refuses to resume when the local branch has commits origin does not", async () => {
    const branch = "mullion/task-8-from-origin";
    git(clone, ["fetch", "--quiet", "origin", "main"]);
    // A local commit the origin does not have, on the branch itself — and
    // the branch is NOT checked out anywhere, so the ONLY thing that can
    // refuse the resume is the divergence.
    git(clone, ["checkout", "-q", "-b", "local-only", "origin/main"]);
    fs.writeFileSync(path.join(clone, "local.txt"), "local");
    git(clone, ["add", "-A"]);
    git(clone, ["commit", "-m", "local only", "--no-verify"]);
    git(clone, ["branch", "-f", branch, "local-only"]);
    git(clone, ["checkout", "-q", "main"]);

    // The local branch has diverged from origin: it cannot be moved to
    // origin's tip, so this host cannot resume from origin at all — and the
    // retry must not continue from the local commit instead.
    const result = await resumeTaskWorktree(clone, branch, { fromOrigin: true });
    expect(result).toBeNull();
  });

  it("does not adopt a leftover checkout of the branch", async () => {
    const branch = "mullion/task-8-from-origin";
    git(clone, ["fetch", "--quiet", "origin", "main"]);
    git(clone, ["branch", branch, "origin/main"]);
    const worktreePath = path.join(clone, ".mullion-worktrees", "mullion-task-8-from-origin");
    git(clone, ["worktree", "add", "-q", worktreePath, branch]);

    // The branch is checked out here, so it cannot be moved to origin's tip:
    // the resume is refused rather than adopting a checkout that may be
    // behind origin (with whatever uncommitted work it holds).
    const result = await resumeTaskWorktree(clone, branch, { fromOrigin: true });
    expect(result).toBeNull();
  });

  // Issue #3194 (review round 2) — a worktree REGISTRATION outlives the
  // directory it points at when that directory is removed out of band (a
  // crash mid-cleanup, a manual `rm -rf`, a disk-cleanup sweep). Git checks
  // the registration, not the directory, when it refuses to fetch into a
  // branch that is "checked out" — so a registration with nothing behind it
  // refuses the fetch forever, and the retry can never start on that host.
  // The prune has to happen BEFORE the fetch for that to clear.
  it("resumes from origin when a stale worktree registration is left behind", async () => {
    const branch = "mullion/task-8-from-origin";
    git(clone, ["fetch", "--quiet", "origin", "main"]);
    git(clone, ["branch", branch, "origin/main"]);
    const worktreePath = path.join(clone, ".mullion-worktrees", "mullion-task-8-from-origin");
    git(clone, ["worktree", "add", "-q", worktreePath, branch]);
    // The directory goes away out of band; the registration does not.
    fs.rmSync(worktreePath, { recursive: true, force: true });

    const result = await resumeTaskWorktree(clone, branch, { fromOrigin: true });
    expect(result).not.toBeNull();
    expect(result?.branch).toBe(branch);
    // Origin's tip, checked out fresh.
    expect(fs.readFileSync(path.join(result!.path, "wip.txt"), "utf8")).toBe("work");
  });
});
