// attemptAutoRebase holds while another worker round or a review post is in
// flight in the task's worktree, bounded by REBASE_HOLD_MAX_MS.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
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
const { attemptAutoRebase, resetRebaseHolds, REBASE_HOLD_MAX_MS } =
  await import("../../src/services/task-auto-rebase.js");
const lifecycle = await import("../../src/services/session-lifecycle.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-rebase-hold-${process.pid}.db`);

describe("auto-rebase hold-back", () => {
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
  beforeEach(() => resetRebaseHolds());

  const apps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function setup(name: string, taskValues: Record<string, unknown>) {
    mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
    mockResolveGitHubToken.mockResolvedValue("tok");
    mockResume.mockResolvedValue({
      path: "/tmp/.mullion-worktrees/mullion-task-x",
      branch: "mullion/task-x",
    });
    mockGetPullRequestByNumber.mockResolvedValue({
      number: 9,
      htmlUrl: "https://github.com/o/r/pull/9",
      nodeId: "PR_node9",
      draft: false,
      headSha: "sha-head",
      headRef: "mullion/task-x",
      baseRef: "main",
      title: "fix: x",
      state: "open",
      merged: false,
      mergeable: false,
      mergeableState: "dirty",
    });
    const app = await buildApp();
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name, cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { autoApprove: true },
    });
    const [session] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all();
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
        sessionId: session.id,
        ...taskValues,
      } as never)
      .returning()
      .all();
    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    return { app, task: task as typeof tasks.$inferSelect, project };
  }
  const getTask = (app: Awaited<ReturnType<typeof buildApp>>, id: number) =>
    app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;

  it("(a) holds while a suggestions worker is still working, counting no attempt", async () => {
    const { app, task, project } = await setup("hold-suggestions", {
      status: "reviewing",
      approvalCarriedAt: new Date(),
    });
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => ({ workFinishedAt: null, lastTurnEndedAt: null }),
    } as never);
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    await attemptAutoRebase(app, task, project, "main");
    expect(create).not.toHaveBeenCalled();
    expect(getTask(app, task.id).rebaseAttempts).toBe(0);
    expect(getTask(app, task.id).mergeError).toContain("suggestions round is in flight");
  });

  it("(a) holds a task still in progress", async () => {
    const { app, task, project } = await setup("hold-in-progress", { status: "in_progress" });
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    await attemptAutoRebase(app, task, project, "main");
    expect(create).not.toHaveBeenCalled();
    expect(getTask(app, task.id).rebaseAttempts).toBe(0);
  });

  it("(b) holds while a review post is pending", async () => {
    const { app, task, project } = await setup("hold-post", { reviewPostPending: "{}" });
    const create = vi.spyOn(lifecycle, "createSessionRecord");
    await attemptAutoRebase(app, task, project, "main");
    expect(create).not.toHaveBeenCalled();
    const row = getTask(app, task.id);
    expect(row.rebaseAttempts).toBe(0);
    expect(row.mergeError).toContain("review post is pending");
  });

  it("(c) proceeds after the hold limit and warns", async () => {
    const { app, task, project } = await setup("hold-expiry", { reviewPostPending: "{}" });
    const create = vi.spyOn(lifecycle, "createSessionRecord").mockResolvedValue({
      ok: true,
      row: { id: task.sessionId },
      initialPromptApplied: true,
    } as never);
    const warn = vi.spyOn(app.log, "warn");
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await attemptAutoRebase(app, task, project, "main");
    expect(create).not.toHaveBeenCalled();
    now.mockReturnValue(t0 + REBASE_HOLD_MAX_MS + 1000);
    await attemptAutoRebase(app, getTask(app, task.id), project, "main");
    expect(create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, blocker: "a review post is pending" }),
      expect.stringContaining("held back past the limit"),
    );
  });

  it("(d) spawns as before when nothing blocks", async () => {
    const { app, task, project } = await setup("hold-none", {});
    const create = vi.spyOn(lifecycle, "createSessionRecord").mockResolvedValue({
      ok: true,
      row: { id: task.sessionId },
      initialPromptApplied: true,
    } as never);
    await attemptAutoRebase(app, task, project, "main");
    expect(create).toHaveBeenCalledTimes(1);
    expect(getTask(app, task.id).rebaseAttempts).toBe(1);
  });
});
