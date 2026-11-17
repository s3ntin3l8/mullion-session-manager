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
});
