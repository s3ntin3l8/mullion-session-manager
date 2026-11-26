// Issue #3068 — POST /api/projects/:id/git-branch-pull: fast-forward any
// local branch from its Branches row. The guard depends on where the branch
// is checked out; a refusal is a 200 with a reason, and every refusal leaves
// the branch where it was. Real temporary repositories, never this repo.

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "../../src/services/git-clone-busy.js";
import { HostRequestError, RemoteHostClient } from "../../src/services/remote-host-client.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString().trim();

function commit(cwd: string, file: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message, "--no-verify"]);
}

interface Fixture {
  root: string;
  repo: string;
  wt: string;
  projectId: number;
  /** Pushes a commit to origin's `branch` from a second clone. */
  advance: (branch: string) => string;
}

async function makeFixture(app: FastifyInstance): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-pull-route-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const other = path.join(root, "other");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["clone", "-q", origin, repo]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  commit(repo, "a.txt", "initial");
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  for (const b of ["idle", "in-wt"]) {
    git(repo, ["push", "-q", "origin", `main:${b}`]);
  }
  git(repo, ["fetch", "-q", "origin"]);
  git(repo, ["branch", "-q", "--track", "idle", "origin/idle"]);
  git(repo, ["branch", "-q", "--track", "in-wt", "origin/in-wt"]);
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), ".wt/\n");
  const wt = path.join(repo, ".wt", "in-wt");
  git(repo, ["worktree", "add", "-q", wt, "in-wt"]);
  git(root, ["clone", "-q", origin, other]);
  const projectId = app.db
    .insert(projects)
    .values({ name: "branch-pull", cwd: repo })
    .returning({ id: projects.id })
    .get().id;
  const advance = (branch: string) => {
    git(other, ["fetch", "-q", "origin"]);
    git(other, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
    commit(other, `${branch}-${Date.now()}.txt`, `upstream ${branch}`);
    git(other, ["push", "-q", "origin", branch]);
    return git(other, ["rev-parse", "HEAD"]);
  };
  return { root, repo, wt, projectId, advance };
}

const pull = (app: FastifyInstance, projectId: number, branch: string, query = "") =>
  app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/git-branch-pull${query}`,
    payload: { branch },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/projects/:id/git-branch-pull (issue #3068)", () => {
  it("404s an unknown project and 400s a malformed body", async () => {
    const app = await buildApp();
    try {
      expect((await pull(app, 999999, "main")).statusCode).toBe(404);
      const bad = await app.inject({
        method: "POST",
        url: "/api/projects/1/git-branch-pull",
        payload: {},
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("fast-forwards a branch checked out nowhere, even with a session in the checkout", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      app.db.insert(sessions).values({ projectId: fx.projectId, command: "bash", cwd: null }).run();
      const target = fx.advance("idle");
      expect((await pull(app, fx.projectId, "idle")).json()).toEqual({
        ok: true,
        detail: "origin/idle",
      });
      expect(git(fx.repo, ["rev-parse", "idle"])).toBe(target);
      expect(git(fx.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      expect(isCloneBusy("local", fx.repo)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("fast-forwards a linked worktree nobody works in", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      const target = fx.advance("in-wt");
      expect((await pull(app, fx.projectId, "in-wt")).json()).toEqual({ ok: true });
      expect(git(fx.wt, ["rev-parse", "HEAD"])).toBe(target);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("refuses while a session works in the linked worktree, and the branch does not move", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      const inserted = app.db
        .insert(sessions)
        .values({ projectId: fx.projectId, command: "bash", cwd: fx.wt })
        .run();
      fx.advance("in-wt");
      const before = git(fx.wt, ["rev-parse", "HEAD"]);
      expect((await pull(app, fx.projectId, "in-wt")).json()).toEqual({
        ok: false,
        reason: "sessions-active",
        detail: String(Number(inserted.lastInsertRowid)),
      });
      expect(git(fx.wt, ["rev-parse", "HEAD"])).toBe(before);
      expect(isCloneBusy("local", fx.repo)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("refuses a dirty worktree", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      fx.advance("in-wt");
      fs.writeFileSync(path.join(fx.wt, "wip.txt"), "wip");
      expect((await pull(app, fx.projectId, "in-wt")).json()).toMatchObject({
        ok: false,
        reason: "dirty-tree",
      });
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("pulls the main checkout's branch only while no session works there", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      // A session in a linked worktree nested below the checkout is not in it.
      app.db
        .insert(sessions)
        .values({ projectId: fx.projectId, command: "bash", cwd: fx.wt })
        .run();
      const target = fx.advance("main");
      expect((await pull(app, fx.projectId, "main")).json()).toEqual({ ok: true });
      expect(git(fx.repo, ["rev-parse", "HEAD"])).toBe(target);

      const inserted = app.db
        .insert(sessions)
        .values({ projectId: fx.projectId, command: "bash", cwd: null })
        .run();
      fx.advance("main");
      expect((await pull(app, fx.projectId, "main")).json()).toEqual({
        ok: false,
        reason: "sessions-active",
        detail: String(Number(inserted.lastInsertRowid)),
      });
      expect(git(fx.repo, ["rev-parse", "HEAD"])).toBe(target);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("guards the main checkout for a project rooted in a nested worktree", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      const nested = app.db
        .insert(projects)
        .values({ name: "rooted-in-wt", cwd: fx.wt })
        .returning({ id: projects.id })
        .get().id;
      const inMain = app.db
        .insert(sessions)
        .values({ projectId: fx.projectId, command: "bash", cwd: fx.repo })
        .run();
      fx.advance("main");
      const before = git(fx.repo, ["rev-parse", "HEAD"]);
      expect((await pull(app, nested, "main")).json()).toEqual({
        ok: false,
        reason: "sessions-active",
        detail: String(Number(inMain.lastInsertRowid)),
      });
      expect(git(fx.repo, ["rev-parse", "HEAD"])).toBe(before);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("refuses a diverged branch and one with no upstream", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    try {
      git(fx.repo, ["branch", "-q", "--no-track", "lonely", "main"]);
      expect((await pull(app, fx.projectId, "lonely")).json()).toMatchObject({
        ok: false,
        reason: "no-upstream",
      });
      git(fx.repo, ["checkout", "-q", "idle"]);
      commit(fx.repo, "local.txt", "local");
      git(fx.repo, ["checkout", "-q", "main"]);
      const before = git(fx.repo, ["rev-parse", "idle"]);
      fx.advance("idle");
      expect((await pull(app, fx.projectId, "idle")).json()).toMatchObject({
        ok: false,
        reason: "not-fast-forward",
      });
      expect(git(fx.repo, ["rev-parse", "idle"])).toBe(before);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  it("refuses while another git operation holds the clone", async () => {
    const app = await buildApp();
    const fx = await makeFixture(app);
    markCloneBusy("local", fx.repo);
    try {
      expect((await pull(app, fx.projectId, "idle")).json()).toMatchObject({
        ok: false,
        reason: "busy",
      });
    } finally {
      releaseClone("local", fx.repo);
      fs.rmSync(fx.root, { recursive: true, force: true });
      await app.close();
    }
  });

  describe("remote hosts", () => {
    async function remoteProject(app: FastifyInstance, hostId: string) {
      app.db
        .insert(hosts)
        .values({ id: hostId, name: hostId, baseUrl: "http://127.0.0.1:1", approvedAt: new Date() })
        .run();
      return app.db
        .insert(projects)
        .values({ name: `p-${hostId}`, cwd: "/x", hostId })
        .returning({ id: projects.id })
        .get().id;
    }

    it("runs on the agent, passing the checkout it guarded", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "pull-agent");
        vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
          branches: [],
          worktrees: [{ path: "/x", branch: "main", isMain: true, head: "abc" }],
          remoteBranches: [],
        } as never);
        const run = vi
          .spyOn(RemoteHostClient.prototype, "resolveGitBranchPull")
          .mockResolvedValue({ ok: true, detail: "origin/feature" });
        expect((await pull(app, id, "feature")).json()).toEqual({
          ok: true,
          detail: "origin/feature",
        });
        expect(run).toHaveBeenCalledWith("/x", "feature", null);
        expect((await pull(app, id, "main")).json()).toMatchObject({ ok: true });
        expect(run).toHaveBeenLastCalledWith("/x", "main", "/x");
      } finally {
        await app.close();
      }
    });

    it("refuses when the agent cannot list its worktrees", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "pull-agent-nolist");
        vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue(null);
        const run = vi.spyOn(RemoteHostClient.prototype, "resolveGitBranchPull");
        expect((await pull(app, id, "feature")).json()).toMatchObject({
          ok: false,
          reason: "failed",
        });
        expect(run).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    // The same answer git-rebase gives: a rejection, not "unreachable" (and a
    // 501 `unsupported` when the request is scoped to a session).
    it("says an agent that predates the route rejected it", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "pull-agent-old");
        vi.spyOn(RemoteHostClient.prototype, "resolveGitBranches").mockResolvedValue({
          branches: [],
          worktrees: [],
          remoteBranches: [],
        } as never);
        vi.spyOn(RemoteHostClient.prototype, "resolveGitBranchPull").mockRejectedValue(
          new HostRequestError("pull-agent-old", 404, ""),
        );
        const res = await pull(app, id, "feature");
        expect(res.statusCode).toBe(503);
        expect(res.json().message).toMatch(/^Host pull-agent-old rejected git branch pull/);
        expect(isCloneBusy("pull-agent-old", "/x")).toBe(false);
      } finally {
        await app.close();
      }
    });

    it("503s for an unreachable agent", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "pull-agent-down");
        const res = await pull(app, id, "feature");
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });
  });
});
