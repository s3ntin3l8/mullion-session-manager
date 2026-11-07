import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";

// #2725 — the entry points that remove a worktree, driven for real: each one
// must close the checkout's browsers and delete their stored state, through
// the shared helper. Only the host backend is faked (a worktree on a "remote"
// host cannot be cut here); the browser manager is a real one on a temp dir.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects, sessions, tasks } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");
const { BrowserManager } = await import("../../src/services/browser-manager.js");
const { createSessionRecord, killSession } =
  await import("../../src/services/session-lifecycle.js");
const { enqueueTask, dispatchClaimedTask } = await import("../../src/services/task-claim.js");
const { deriveTaskBranchName, deriveWorktreePath, trackPreviewWorktree } =
  await import("../../src/services/git-worktree.js");
const { previewRemover } = await import("../../src/services/checkout-removal.js");

const tmpDb = path.join(os.tmpdir(), `checkout-removal-entrypoints-${process.pid}.db`);

describe("worktree removal entry points release the checkout's browsers (#2725)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let manager: InstanceType<typeof BrowserManager>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
    app = await buildApp();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-entrypoints-"));
    manager = new BrowserManager({ enabled: true, maxContexts: 2, dataDir });
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });
  afterEach(() => vi.restoreAllMocks());

  const newProject = (cwd: string, hostId = "local") =>
    app.db
      .insert(projects)
      .values({ name: `p-${Math.random()}`, cwd, hostId })
      .returning({ id: projects.id })
      .get().id;

  /** Leaves the checkout's stored browser state on disk and routes
   * `forgetCheckout` to the real manager, which deletes it. */
  function seedStorage(projectId: number, hostId: string, checkout: string) {
    const file = (manager as unknown as { storageStatePath(t: unknown): string }).storageStatePath({
      projectId,
      hostId,
      checkoutRoot: checkout,
      legacy: false,
    });
    fs.writeFileSync(file, "{}");
    const forget = vi
      .spyOn(app.browser, "forgetCheckout")
      .mockImplementation((p, h, c) => manager.forgetCheckout(p, h, c));
    return { file, forget };
  }

  function useBackend(overrides: Record<string, unknown>) {
    const backend = {
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      // The app's own dispatch sweep keeps running while this file does and
      // reaches whichever backend a test installed: give it the calls a claim
      // makes, so it cannot trip over a missing one.
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      createWorktree: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
    return backend;
  }

  it("a task claim clearing the previous attempt's worktree", async () => {
    // A local checkout: `forgetCheckout` is the local release (a remote one is a
    // request to the agent), and the fake backend stands in for git.
    const hostId = "local";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "entry-claim-"));
    const projectId = newProject(cwd, hostId);
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 7001, title: "t", body: "b", status: "ready" })
      .returning()
      .all();
    // The worktree path this claim will predict, where the previous attempt's
    // browser state sits.
    const { file, forget } = seedStorage(
      projectId,
      hostId,
      deriveWorktreePath(cwd, deriveTaskBranchName(task)),
    );
    useBackend({
      clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      // Stop the claim right after the clear: this test is about the clear.
      createWorktree: vi.fn().mockResolvedValue(null),
    });
    vi.spyOn(hostGitModule, "resolveHostBaseRef").mockResolvedValue({
      ok: true,
      value: { baseRef: "HEAD", sha: null },
    });

    const enqueued = await enqueueTask(app, task.id, { auto: false });
    expect(enqueued.ok).toBe(true);
    await dispatchClaimedTask(app, task.id);

    expect(forget).toHaveBeenCalledWith(
      projectId,
      hostId,
      expect.stringContaining(".mullion-worktrees"),
    );
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("a create that fails after cutting its worktree rolls the worktree's browser state back", async () => {
    const projectId = newProject("/tmp");
    const WT = "/tmp/.mullion-worktrees/entry-rollback";
    const { file, forget } = seedStorage(projectId, "local", WT);
    useBackend({
      createWorktree: vi.fn().mockResolvedValue({ created: true, path: WT, branch: "mullion/x" }),
      spawn: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      worktree: { baseRef: "main" },
    });

    expect(res.ok).toBe(false);
    expect(forget).toHaveBeenCalledWith(projectId, "local", WT);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("ending a dock preview session removes its worktree through the helper", async () => {
    const projectId = newProject("/tmp");
    const WT = "/tmp/.mullion-worktrees/entry-dock-preview";
    const { file, forget } = seedStorage(projectId, "local", WT);
    useBackend({});
    const session = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "active" })
      .returning()
      .get();
    // What session-lifecycle tracks for a dock preview: the remove closure is
    // previewRemover, which is the helper.
    trackPreviewWorktree(session.id, {
      worktreePath: WT,
      branch: "main",
      worktreeRefresh: false,
      parentCwd: "/tmp",
      projectId,
      hostId: "local",
      remove: previewRemover(
        app,
        { projectId, hostId: "local", worktreePath: WT, parentCwd: "/tmp" },
        () => false,
      ),
    });

    await killSession(app, session.id, "detach");

    expect(forget).toHaveBeenCalledWith(projectId, "local", WT);
    expect(fs.existsSync(file)).toBe(false);
    expect(app.db.select().from(sessions).where(eq(sessions.id, session.id)).get()?.status).toBe(
      "killed",
    );
  });
});
