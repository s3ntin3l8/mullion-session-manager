// #2637 — an auto-rebase worker whose spawn outcome is unknown is adopted (rebase
// CAS and attempt count recorded), so the next tick does not spawn another one.
// Its own file: the reconciler's test file is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const { mockResolveRepoRef, mockResolveGitHubToken, mockGetPullRequestByNumber, mockResume } =
  vi.hoisted(() => ({
    mockResolveRepoRef: vi.fn(),
    mockResolveGitHubToken: vi.fn(),
    mockGetPullRequestByNumber: vi.fn(),
    mockResume: vi.fn(),
  }));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRepoRef: mockResolveRepoRef,
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));
vi.mock("../../src/services/github-write.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPullRequestByNumber: mockGetPullRequestByNumber,
}));
vi.mock("../../src/services/git-worktree.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resumeTaskWorktree: mockResume,
}));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const lifecycle = await import("../../src/services/session-lifecycle.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-outcome-unknown-${process.pid}.db`);

describe("auto-rebase spawn with an unknown outcome (#2637)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  it("adopts the kept session and never spawns a second worker", async () => {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
      headRef: "mullion/task-x",
      baseRef: "main",
      title: "feat: do the thing",
      state: "open",
      merged: false,
      mergeable: true,
      mergeableState: "dirty",
    });
    mockResume.mockResolvedValue({
      path: "/tmp/.mullion-worktrees/mullion-task-x",
      branch: "mullion/task-x",
    });
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-rebase", cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "conflicted",
        status: "done",
        claimedAt: new Date(),
        completedAt: new Date(),
        prNumber: 9,
        prUrl: "https://github.com/o/r/pull/9",
        mergeRequestedAt: new Date(),
        branchName: "mullion/task-x",
        agentCommand: "claude",
      })
      .returning()
      .all();
    const [kept] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
    const create = vi.spyOn(lifecycle, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      sessionId: kept.id,
    });

    await reconcileTasks(app);

    let row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.sessionId).toBe(kept.id);
    expect(row.rebaseAttempts).toBe(1);
    expect(row.rebaseStartedAt).not.toBeNull();
    expect(row.mergeError).toContain("in progress");
    const spawnsAfterFirstTick = create.mock.calls.length;

    await reconcileTasks(app);

    row = app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.rebaseAttempts).toBe(1);
    expect(create.mock.calls.length).toBe(spawnsAfterFirstTick);
    await app.close();
  });
});
