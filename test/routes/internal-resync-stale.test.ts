import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";

// The agent-side /internal/git-resync-stale: the remote-host counterpart of
// resyncStaleWorktree, over a real temp repo.
const TOKEN = "test-agent-token-resync-stale";
const { buildApp } = await import("../../src/app.js");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();

describe("POST /internal/git-resync-stale (agent role)", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-resync-stale-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = root;
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("resyncs a worktree left stale by an outside branch move, and reports not-stale after", async () => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    const wt = path.join(root, "wt");
    git(cwd, ["worktree", "add", "-b", "task", wt, "main"]);
    fs.writeFileSync(path.join(wt, "b.txt"), "b");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-m", "work", "--no-verify"]);
    // Move the branch ref from outside the worktree.
    const old = git(wt, ["rev-parse", "HEAD"]).trim();
    const parent = git(wt, ["rev-parse", "HEAD~1"]).trim();
    git(cwd, ["update-ref", "-m", "outside", "refs/heads/task", parent]);
    expect(git(wt, ["status", "--porcelain"]).trim()).not.toBe("");

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/git-resync-stale",
      headers: auth,
      payload: { cwd: wt, branch: "task" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "resynced", matchedCommit: old, head: parent });
    expect(git(wt, ["status", "--porcelain"]).trim()).toBe("");

    const again = await app.inject({
      method: "POST",
      url: "/internal/git-resync-stale",
      headers: auth,
      payload: { cwd: wt, branch: "task" },
    });
    expect(again.json()).toEqual({ outcome: "not-stale" });

    const missing = await app.inject({
      method: "POST",
      url: "/internal/git-resync-stale",
      headers: auth,
      payload: { cwd: wt },
    });
    expect(missing.statusCode).toBe(400);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "internal-resync-out-"));
    const rejected = await app.inject({
      method: "POST",
      url: "/internal/git-resync-stale",
      headers: auth,
      payload: { cwd: outside, branch: "task" },
    });
    expect(rejected.statusCode).toBe(400);
    fs.rmSync(outside, { recursive: true, force: true });
    await app.close();
  });
});
