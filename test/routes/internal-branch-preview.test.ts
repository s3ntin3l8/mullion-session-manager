import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { dockPreviewWorktreePath } from "../../src/services/git-worktree.js";

// Issue #3428 — the agent side of a remote project's branch preview, through
// the real handlers over a real temp repo: /internal/git-ensure-branch,
// /internal/worktree-clear-stale and /internal/preview-port.
const TOKEN = "test-agent-token-branch-preview";
const { buildApp } = await import("../../src/app.js");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "gc.auto=0", "-C", cwd, ...args], {
    stdio: "pipe",
    env: {
      ...gitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).toString();

describe("agent routes for a remote branch preview (#3428)", () => {
  let root: string;
  let cwd: string;
  let origin: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-branch-preview-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = root;
    origin = path.join(root, "origin.git");
    cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    git(root, "init", "--quiet", "--bare", origin);
    git(cwd, "init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "init");
    git(cwd, "branch", "feat/x");
    git(cwd, "remote", "add", "origin", origin);
    git(cwd, "push", "--quiet", "origin", "main", "main:feat/remote-only");
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  const post = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: auth, payload: payload as object });

  describe("POST /internal/git-ensure-branch", () => {
    it("keeps a local branch, fetches one only origin has, and says no to the rest", async () => {
      expect((await post("/internal/git-ensure-branch", { cwd, branch: "feat/x" })).json()).toEqual(
        { ok: true },
      );
      const fetched = await post("/internal/git-ensure-branch", {
        cwd,
        branch: "feat/remote-only",
        fastForward: true,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toEqual({ ok: true });
      expect(git(cwd, "rev-parse", "--verify", "refs/heads/feat/remote-only").trim()).toMatch(
        /^[0-9a-f]{40}$/,
      );
      // A git-level "no" is an outcome (200), not an error status.
      const missing = await post("/internal/git-ensure-branch", { cwd, branch: "feat/nowhere" });
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({ ok: false });
    });

    it("refuses a cwd outside the agent's roots, and a malformed body", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bp-out-"));
      try {
        const res = await post("/internal/git-ensure-branch", { cwd: outside, branch: "main" });
        expect(res.statusCode).toBe(400);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
      expect((await post("/internal/git-ensure-branch", { cwd })).statusCode).toBe(400);
    });
  });

  describe("POST /internal/worktree-clear-stale", () => {
    it("is a no-op when nothing is there, and removes a leftover preview worktree", async () => {
      const wt = dockPreviewWorktreePath(cwd, "feat/x");
      expect((await post("/internal/worktree-clear-stale", { cwd, path: wt })).json()).toEqual({
        outcome: "absent",
        worktreePath: wt,
      });
      git(cwd, "worktree", "add", "--quiet", "--detach", wt, "feat/x");
      fs.writeFileSync(path.join(wt, "dirty.txt"), "hmr output\n");
      // The primary sends the directory's name: the agent resolves it under
      // its own checkout (a remote cwd may be stored as `~/…`).
      const res = await post("/internal/worktree-clear-stale", { cwd, path: path.basename(wt) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "removed", worktreePath: wt });
      expect(fs.existsSync(wt)).toBe(false);
      expect(git(cwd, "worktree", "list")).not.toContain(wt);
    });

    it("reports a directory git can't remove as not removed", async () => {
      const wt = dockPreviewWorktreePath(cwd, "feat/plain");
      fs.mkdirSync(wt, { recursive: true });
      const res = await post("/internal/worktree-clear-stale", { cwd, path: wt });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: "not-removed" });
      expect(fs.existsSync(wt)).toBe(true);
    });

    it("resolves a ~ cwd and answers with the absolute path", async () => {
      const home = process.env.HOME;
      process.env.HOME = root;
      try {
        const res = await post("/internal/worktree-clear-stale", {
          cwd: "~/repo",
          path: path.basename(dockPreviewWorktreePath(cwd, "feat/tilde")),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          outcome: "absent",
          worktreePath: dockPreviewWorktreePath(cwd, "feat/tilde"),
        });
      } finally {
        process.env.HOME = home;
      }
    });

    it("refuses a dock-preview entry that is a symlink out of the roots", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bp-link-"));
      const link = dockPreviewWorktreePath(cwd, "feat/link");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link);
      try {
        const res = await post("/internal/worktree-clear-stale", { cwd, path: link });
        expect(res.statusCode).toBe(400);
        expect(fs.existsSync(outside)).toBe(true);
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("runs the path guard agent-side: only a dock-preview dir under cwd's .mullion-worktrees", async () => {
      const base = path.join(cwd, ".mullion-worktrees");
      const task = path.join(base, "mullion-task-7-thing");
      fs.mkdirSync(task, { recursive: true });
      for (const p of [
        task,
        base,
        path.join(base, "..", "..", "elsewhere"),
        path.join(base, "dock-preview-x", "nested"),
        "/etc",
        "../outside",
      ]) {
        const res = await post("/internal/worktree-clear-stale", { cwd, path: p });
        // A refusal is an outcome (200), like any git-level "no".
        expect(res.statusCode, p).toBe(200);
        expect(res.json(), p).toEqual({ outcome: "invalid-path" });
      }
      expect(fs.existsSync(task)).toBe(true);
    });
  });

  describe("POST /internal/preview-port", () => {
    it("returns a free loopback port outside the ones it is told are taken", async () => {
      const first = (await post("/internal/preview-port", { taken: [] })).json() as {
        port: number;
      };
      expect(first.port).toBeGreaterThan(0);
      // It is genuinely free: it binds.
      await new Promise<void>((resolve, reject) => {
        const s = net.createServer().once("error", reject);
        s.listen(first.port, "127.0.0.1", () => s.close(() => resolve()));
      });
      const second = (await post("/internal/preview-port", { taken: [first.port] })).json() as {
        port: number;
      };
      expect(second.port).not.toBe(first.port);
    });

    it("refuses a taken list that isn't ports", async () => {
      expect((await post("/internal/preview-port", { taken: [0] })).statusCode).toBe(400);
      expect((await post("/internal/preview-port", { taken: [70000] })).statusCode).toBe(400);
      expect((await post("/internal/preview-port", {})).statusCode).toBe(400);
    });
  });
});
