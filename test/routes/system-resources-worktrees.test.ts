import { describe, expect, it, vi } from "vitest";
import type { DevWorktreeOptions } from "../../src/services/dev-worktrees.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as GithubWrite from "../../src/services/github-write.js";
import type * as HostGit from "../../src/services/host-git.js";

const inspectDevWorktrees = vi.fn(async (_options: DevWorktreeOptions) => ({
  available: true,
  candidates: [],
  totalBytes: 0,
}));
const pruneDevWorktrees = vi.fn(async (_options: DevWorktreeOptions) => ({
  output: "Removed 0 stale developer worktrees.",
  reclaimedBytes: 3,
}));
vi.mock("../../src/services/dev-worktrees.js", () => ({
  inspectDevWorktrees: (options: DevWorktreeOptions) => inspectDevWorktrees(options),
  pruneDevWorktrees: (options: DevWorktreeOptions) => pruneDevWorktrees(options),
}));

const resolveRepoRef = vi.fn(
  async (..._args: unknown[]) =>
    ({
      owner: "acme",
      repo: "widgets",
    }) as { owner: string; repo: string } | null,
);
vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostGit>()),
  resolveRepoRef: (...args: unknown[]) => resolveRepoRef(...args),
}));
const resolveGitHubToken = vi.fn(async (..._args: unknown[]) => "tok" as string | null);
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIntegration>()),
  resolveGitHubToken: (...args: unknown[]) => resolveGitHubToken(...args),
}));
const findMergedPullRequestByHead = vi.fn(
  async (..._args: unknown[]) =>
    ({ number: 42, headSha: "tipsha", baseRef: "main" }) as {
      number: number;
      headSha: string;
      baseRef: string;
    } | null,
);
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubWrite>()),
  findMergedPullRequestByHead: (...args: unknown[]) => findMergedPullRequestByHead(...args),
}));

import { projects, sessions, tasks } from "../../src/db/schema.js";
import { buildTestApp } from "../helpers/app.js";

/** The options the route hands the service, as built for the latest request. */
async function optionsFor(app: Awaited<ReturnType<typeof buildTestApp>>) {
  inspectDevWorktrees.mockClear();
  // A fresh app has an empty cache; bust it for the second look in a test.
  await app.inject({ method: "POST", url: "/api/storage/worktrees/prune" });
  return pruneDevWorktrees.mock.lastCall![0];
}

describe("/api/storage/worktrees", () => {
  it("prunes with nothing a client can steer, and returns the result", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/storage/worktrees/prune",
      payload: { paths: ["/etc"], projects: [{ id: 1, cwd: "/etc" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      output: "Removed 0 stale developer worktrees.",
      reclaimedBytes: 3,
    });
  });

  it("caches inspection across polls and refreshes after a prune", async () => {
    inspectDevWorktrees.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/worktrees" });
    await app.inject({ method: "GET", url: "/api/storage/worktrees" });
    expect(inspectDevWorktrees).toHaveBeenCalledTimes(1);
    await app.inject({ method: "POST", url: "/api/storage/worktrees/prune" });
    await app.inject({ method: "GET", url: "/api/storage/worktrees" });
    expect(inspectDevWorktrees).toHaveBeenCalledTimes(2);
  });

  it("maps an in-progress prune to 409 and other failures to 500", async () => {
    const app = await buildTestApp();
    pruneDevWorktrees.mockRejectedValueOnce(new Error("DEV_WORKTREE_PRUNE_IN_PROGRESS"));
    expect(
      (await app.inject({ method: "POST", url: "/api/storage/worktrees/prune" })).statusCode,
    ).toBe(409);
    pruneDevWorktrees.mockRejectedValueOnce(new Error("disk on fire"));
    expect(
      (await app.inject({ method: "POST", url: "/api/storage/worktrees/prune" })).statusCode,
    ).toBe(500);
  });

  it("offers only local projects", async () => {
    const app = await buildTestApp();
    app.db.insert(projects).values({ name: "loc", cwd: "/tmp/wt-route-local" }).run();
    app.db
      .insert(projects)
      .values({ name: "rem", cwd: "/tmp/wt-route-remote", hostId: "remote-1" })
      .run();
    const names = (await optionsFor(app)).projects.map((p) => p.name);
    expect(names).toContain("loc");
    expect(names).not.toContain("rem");
  });

  describe("what counts as using a worktree", () => {
    it("counts a live session in the worktree, whichever project it belongs to", async () => {
      const app = await buildTestApp();
      const insert = (name: string, cwd: string, hostId?: string) =>
        Number(
          app.db
            .insert(projects)
            .values({ name, cwd, ...(hostId ? { hostId } : {}) })
            .run().lastInsertRowid,
        );
      const repo = insert("repo", "/tmp/wt-use/repo");
      // The worktree registered as a project of its own, with its own session.
      const ownProject = insert("worktree-as-project", "/tmp/wt-use/repo/.wt/own");
      const remote = insert("remote", "/tmp/wt-use/remote", "remote-1");
      app.db
        .insert(sessions)
        .values([
          { projectId: repo, command: "bash", cwd: "/tmp/wt-use/repo/.wt/busy/src" },
          { projectId: ownProject, command: "bash", cwd: "/tmp/wt-use/repo/.wt/own" },
          {
            projectId: repo,
            command: "bash",
            cwd: "/tmp/wt-use/repo/.wt/finished",
            status: "killed",
          },
          {
            projectId: repo,
            command: "bash",
            cwd: "/tmp/wt-use/repo/.wt/exited",
            status: "exited",
          },
          // A path on another machine that happens to look the same.
          { projectId: remote, command: "bash", cwd: "/tmp/wt-use/repo/.wt/elsewhere" },
        ])
        .run();
      const { inUse, projects: listed } = await optionsFor(app);
      const p = listed.find((x) => x.name === "repo")!;
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/busy")).toBe(true);
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/own")).toBe(true);
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/finished")).toBe(false);
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/exited")).toBe(false);
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/elsewhere")).toBe(false);
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/untouched")).toBe(false);
      // A prefix match on a path segment is not inside the directory.
      expect(inUse!(p, "/tmp/wt-use/repo/.wt/bus")).toBe(false);
    });

    it("counts a task that can still resume in the worktree, but not a finished one", async () => {
      const app = await buildTestApp();
      const repo = Number(
        app.db.insert(projects).values({ name: "tasks-repo", cwd: "/tmp/wt-use-tasks" }).run()
          .lastInsertRowid,
      );
      app.db
        .insert(tasks)
        .values([
          {
            projectId: repo,
            title: "a",
            status: "in_progress",
            worktreePath: "/tmp/wt-use-tasks/.wt/a",
          },
          {
            projectId: repo,
            title: "b",
            status: "failed",
            worktreePath: "/tmp/wt-use-tasks/.wt/b",
          },
          { projectId: repo, title: "c", status: "done", worktreePath: "/tmp/wt-use-tasks/.wt/c" },
          {
            projectId: repo,
            title: "d",
            status: "cancelled",
            worktreePath: "/tmp/wt-use-tasks/.wt/d",
          },
          { projectId: repo, title: "e", status: "backlog" },
        ])
        .run();
      const { inUse, projects: listed } = await optionsFor(app);
      const p = listed.find((x) => x.name === "tasks-repo")!;
      expect(inUse!(p, "/tmp/wt-use-tasks/.wt/a")).toBe(true);
      expect(inUse!(p, "/tmp/wt-use-tasks/.wt/b")).toBe(true);
      expect(inUse!(p, "/tmp/wt-use-tasks/.wt/c")).toBe(false);
      expect(inUse!(p, "/tmp/wt-use-tasks/.wt/d")).toBe(false);
    });
  });

  describe("merged-PR lookup", () => {
    const at = (n: string) => ({ id: 1, name: "p", cwd: `/tmp/wt-route-${n}` });

    it("returns the PR only when it merged exactly this commit into the default branch", async () => {
      const options = await optionsFor(await buildTestApp());
      expect(await options.mergedPr!(at("merged"), "feat-a", "tipsha", "main")).toBe(42);
      expect(findMergedPullRequestByHead).toHaveBeenLastCalledWith(
        "tok",
        "acme",
        "widgets",
        "acme:feat-a",
      );
      // The branch has moved on since the PR merged: not the same work.
      expect(await options.mergedPr!(at("merged"), "feat-b", "newersha", "main")).toBeNull();
      // Merged into some other branch, not the default one.
      expect(await options.mergedPr!(at("merged"), "feat-c", "tipsha", "develop")).toBeNull();
    });

    it("asks GitHub once per branch and commit, whatever the answer", async () => {
      const options = await optionsFor(await buildTestApp());
      findMergedPullRequestByHead.mockClear();
      const p = at("cache");
      await options.mergedPr!(p, "feat-c", "tipsha", "main");
      await options.mergedPr!(p, "feat-c", "tipsha", "main");
      await options.mergedPr!(p, "feat-c", "othersha", "main");
      expect(findMergedPullRequestByHead).toHaveBeenCalledTimes(2);
    });

    it("answers null without remembering it when GitHub, the remote or the token isn't there", async () => {
      const options = await optionsFor(await buildTestApp());
      findMergedPullRequestByHead.mockClear();
      resolveRepoRef.mockResolvedValueOnce(null);
      expect(await options.mergedPr!(at("norepo"), "b", "tipsha", "main")).toBeNull();
      resolveGitHubToken.mockResolvedValueOnce(null);
      expect(await options.mergedPr!(at("notoken"), "b", "tipsha", "main")).toBeNull();
      findMergedPullRequestByHead.mockRejectedValueOnce(new Error("rate limited"));
      expect(await options.mergedPr!(at("error"), "b", "tipsha", "main")).toBeNull();
      // Each of those asked again next time, rather than being stuck on "no".
      expect(await options.mergedPr!(at("norepo"), "b", "tipsha", "main")).toBe(42);
      expect(await options.mergedPr!(at("notoken"), "b", "tipsha", "main")).toBe(42);
      expect(await options.mergedPr!(at("error"), "b", "tipsha", "main")).toBe(42);
    });
  });
});
