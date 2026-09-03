// #939/#1016 — resolveTaskIssueContext/resolveTaskIssueContextSafe, tested
// against a real app+DB (siblings come off a real `tasks` table query — the
// same "real-DB semantics a hand mock can't faithfully replicate" reasoning
// task-watcher-ingest.test.ts/task-watcher-hierarchy.test.ts already use for
// this exact table), with only the GitHub network layer mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as GitHubIntegrationModule from "../../src/services/github-integration.js";
import type * as GitHubModule from "../../src/services/github.js";

const mockResolveRepoRef = vi.hoisted(() => vi.fn());
const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
const mockGetIssue = vi.hoisted(() => vi.fn());
const mockListIssueComments = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/host-git.js", () => ({
  resolveRepoRef: mockResolveRepoRef,
}));
// importOriginal, not a bare stand-in: task-github-sync.ts (pulled in
// transitively by app.js's buildApp()) imports other exports off this same
// module — a bare `{ resolveGitHubToken: ... }` mock would break those.
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubIntegrationModule>();
  return { ...actual, resolveGitHubToken: mockResolveGitHubToken };
});
vi.mock("../../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return { ...actual, getIssue: mockGetIssue, listIssueComments: mockListIssueComments };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");
const { upsertIssueTask } = await import("../../src/services/task-watcher.js");
const { resolveTaskIssueContext, resolveTaskIssueContextSafe } =
  await import("../../src/services/task-issue-context.js");
const { eq, and } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-issue-context-test-${process.pid}.db`);

describe("resolveTaskIssueContext (#939/#1016)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  const project = { cwd: "/tmp/whatever", hostId: "local" };

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-issue-context-test-project-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "issue-context-test-project", cwd },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    mockResolveRepoRef.mockReset();
    mockResolveGitHubToken.mockReset();
    mockGetIssue.mockReset();
    mockListIssueComments.mockReset();
    mockResolveRepoRef.mockResolvedValue({ owner: "acme", repo: "widgets" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockListIssueComments.mockResolvedValue([]);
    mockGetIssue.mockResolvedValue({ number: 0, title: "Parent", body: null });
  });

  function rowFor(issueNumber: number) {
    return app.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issueNumber)))
      .get()!;
  }

  it("returns null without any GitHub call for a local task (no issueNumber)", async () => {
    const result = await resolveTaskIssueContext(
      app,
      { id: 1, projectId, issueNumber: null, parentIssueNumber: null, parentIssueRepo: null },
      project,
    );
    expect(result).toBeNull();
    expect(mockResolveRepoRef).not.toHaveBeenCalled();
  });

  it("returns null when the project's repo can't be resolved", async () => {
    mockResolveRepoRef.mockResolvedValue(null);
    upsertIssueTask(app, projectId, {
      number: 700,
      title: "T",
      body: null,
      htmlUrl: "https://x/700",
    });
    const result = await resolveTaskIssueContext(app, rowFor(700), project);
    expect(result).toBeNull();
    expect(mockResolveGitHubToken).not.toHaveBeenCalled();
  });

  it("returns null when no GitHub token is available", async () => {
    mockResolveGitHubToken.mockResolvedValue(null);
    upsertIssueTask(app, projectId, {
      number: 701,
      title: "T",
      body: null,
      htmlUrl: "https://x/701",
    });
    const result = await resolveTaskIssueContext(app, rowFor(701), project);
    expect(result).toBeNull();
    expect(mockListIssueComments).not.toHaveBeenCalled();
  });

  it("resolves the task's own comments", async () => {
    mockListIssueComments.mockResolvedValue([
      { author: "alice", body: "hi", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    upsertIssueTask(app, projectId, {
      number: 702,
      title: "T",
      body: null,
      htmlUrl: "https://x/702",
    });
    const result = await resolveTaskIssueContext(app, rowFor(702), project);
    expect(result?.comments).toEqual([
      { author: "alice", body: "hi", createdAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(mockListIssueComments).toHaveBeenCalledWith("tok", "acme", "widgets", 702, 10);
    expect(result?.parent).toBeNull();
    expect(result?.siblings).toEqual([]);
  });

  it("resolves parent title/body and the parent's own comments, splitting owner/repo from parentIssueRepo", async () => {
    mockGetIssue.mockResolvedValue({ number: 939, title: "Epic", body: "the spec" });
    mockListIssueComments.mockImplementation(
      async (_token: string, owner: string, repo: string, issueNumber: number) => {
        if (issueNumber === 939) {
          return [{ author: "carol", body: "spike result", createdAt: "2026-01-01T00:00:00Z" }];
        }
        return [];
      },
    );
    upsertIssueTask(app, projectId, {
      number: 703,
      title: "Child",
      body: null,
      htmlUrl: "https://x/703",
      parent: { repo: "other-owner/other-repo", number: 939 },
    });
    const result = await resolveTaskIssueContext(app, rowFor(703), project);
    expect(result?.parent).toEqual({
      number: 939,
      repo: "other-owner/other-repo",
      title: "Epic",
      body: "the spec",
      comments: [{ author: "carol", body: "spike result", createdAt: "2026-01-01T00:00:00Z" }],
    });
    expect(mockGetIssue).toHaveBeenCalledWith("tok", "other-owner", "other-repo", 939);
  });

  it("resolves sibling sub-issues from the local DB, excluding the task itself", async () => {
    upsertIssueTask(app, projectId, {
      number: 704,
      title: "Sibling A",
      body: null,
      htmlUrl: "https://x/704",
      parent: { repo: "acme/widgets", number: 950 },
    });
    upsertIssueTask(app, projectId, {
      number: 705,
      title: "Sibling B",
      body: null,
      htmlUrl: "https://x/705",
      parent: { repo: "acme/widgets", number: 950 },
    });
    upsertIssueTask(app, projectId, {
      number: 706,
      title: "This one",
      body: null,
      htmlUrl: "https://x/706",
      parent: { repo: "acme/widgets", number: 950 },
    });
    const result = await resolveTaskIssueContext(app, rowFor(706), project);
    expect(result?.siblings).toHaveLength(2);
    expect(result?.siblings.map((s) => s.issueNumber).sort()).toEqual([704, 705]);
  });

  it("does not treat a same-number-different-repo issue as a sibling (#701's cross-repo case)", async () => {
    upsertIssueTask(app, projectId, {
      number: 710,
      title: "Real sibling",
      body: null,
      htmlUrl: "https://x/710",
      parent: { repo: "acme/widgets", number: 960 },
    });
    upsertIssueTask(app, projectId, {
      number: 711,
      title: "Coincidental same number, different parent repo",
      body: null,
      htmlUrl: "https://x/711",
      parent: { repo: "other-owner/other-repo", number: 960 },
    });
    upsertIssueTask(app, projectId, {
      number: 712,
      title: "This one",
      body: null,
      htmlUrl: "https://x/712",
      parent: { repo: "acme/widgets", number: 960 },
    });
    const result = await resolveTaskIssueContext(app, rowFor(712), project);
    expect(result?.siblings.map((s) => s.issueNumber)).toEqual([710]);
  });
});

describe("resolveTaskIssueContextSafe (#939/#1016)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const project = { cwd: "/tmp/whatever", hostId: "local" };

  beforeAll(async () => {
    app = { db: {}, log: { warn: vi.fn() } } as unknown as Awaited<ReturnType<typeof buildApp>>;
  });

  afterAll(() => {
    // No real DB/app lifecycle here — this describe block never called
    // buildApp() for real, unlike the block above.
  });

  beforeEach(() => {
    mockResolveRepoRef.mockReset();
  });

  it("fails open: returns null and logs a warning instead of throwing", async () => {
    mockResolveRepoRef.mockRejectedValue(new Error("network is down"));
    const result = await resolveTaskIssueContextSafe(
      app,
      { id: 1, projectId: 1, issueNumber: 5, parentIssueNumber: null, parentIssueRepo: null },
      project,
    );
    expect(result).toBeNull();
    expect(app.log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ taskId: 1, issueNumber: 5 }),
      expect.stringContaining("proceeding with the plain prompt"),
    );
  });
});
