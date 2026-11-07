import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, tasks } from "../../src/db/schema.js";
import * as sessionBackendModule from "../../src/services/session-backend.js";
import {
  removeCheckoutForced,
  removeCheckoutIfClean,
} from "../../src/services/checkout-removal.js";
import { cleanupMergedTaskBranch, cleanupTaskWorktree } from "../../src/services/task-approve.js";
import { BrowserManager } from "../../src/services/browser-manager.js";

// Issue #2687 — every worktree removal closes the checkout's browsers and
// deletes their stored state, through the one shared helper.
const tmpDb = path.join(os.tmpdir(), `checkout-removal-test-${process.pid}.db`);

describe("checkout removal releases browsers", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let manager: BrowserManager;
  const root = "/work/removal-root";
  const worktree = "/work/removal-root/.mullion-worktrees/mullion-task-1";
  let projectId: number;

  const backend = {
    removeWorktreeIfClean: vi.fn(),
    removeWorktree: vi.fn(),
    deleteBranch: vi.fn(),
  };

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-removal-"));
    manager = new BrowserManager({ enabled: true, maxContexts: 2, dataDir });
    projectId = app.db
      .insert(projects)
      .values({ name: "removal", cwd: root, hostId: "local" })
      .returning({ id: projects.id })
      .get().id;
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => vi.restoreAllMocks());

  /** Leaves the worktree's stored state on disk and routes `forgetCheckout` to
   * a manager that really deletes it. */
  function seedStorage() {
    const file = (manager as unknown as { storageStatePath(t: unknown): string }).storageStatePath({
      projectId,
      hostId: "local",
      checkoutRoot: worktree,
      legacy: false,
    });
    fs.writeFileSync(file, "{}");
    const forget = vi
      .spyOn(app.browser, "forgetCheckout")
      .mockImplementation((p, h, c) => manager.forgetCheckout(p, h, c));
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
    return { file, forget };
  }

  it("removeCheckoutIfClean closes the browsers and deletes the storage file once removed", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktreeIfClean.mockResolvedValue({ removed: true });
    const result = await removeCheckoutIfClean(app, {
      projectId,
      hostId: "local",
      worktreePath: worktree,
      parentCwd: root,
    });
    expect(result).toEqual({ removed: true });
    expect(forget).toHaveBeenCalledWith(projectId, "local", worktree);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("removeCheckoutIfClean leaves the browsers alone when the worktree is kept", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktreeIfClean.mockResolvedValue({ removed: false, reason: "dirty" });
    await removeCheckoutIfClean(app, {
      projectId,
      hostId: "local",
      worktreePath: worktree,
      parentCwd: root,
    });
    expect(forget).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(file);
  });

  it("removeCheckoutForced releases on success only", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktree.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ref = { projectId, hostId: "local", worktreePath: worktree, parentCwd: root };
    expect(await removeCheckoutForced(app, ref)).toBe(false);
    expect(forget).not.toHaveBeenCalled();
    expect(await removeCheckoutForced(app, ref)).toBe(true);
    expect(forget).toHaveBeenCalledWith(projectId, "local", worktree);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("task approval's worktree cleanup deletes the worktree's browser state", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktreeIfClean.mockResolvedValue({ removed: true });
    cleanupTaskWorktree(
      app,
      { worktreePath: worktree, sessionId: null, projectId },
      { id: projectId, cwd: root, hostId: "local", hostCwds: null },
    );
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith(projectId, "local", worktree));
    expect(fs.existsSync(file)).toBe(false);
  });

  it("the merged-task cleanup deletes the worktree's browser state before the branch", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktreeIfClean.mockResolvedValue({ removed: true });
    backend.deleteBranch.mockResolvedValue({ deleted: true });
    cleanupMergedTaskBranch(
      app,
      { branchName: "mullion/task-1", worktreePath: worktree, sessionId: null, projectId },
      { id: projectId, cwd: root, hostId: "local", hostCwds: null },
    );
    await vi.waitFor(() => expect(backend.deleteBranch).toHaveBeenCalled());
    expect(forget).toHaveBeenCalledWith(projectId, "local", worktree);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("abandoning a task deletes its worktree's browser state", async () => {
    const { file, forget } = seedStorage();
    backend.removeWorktree.mockResolvedValue(true);
    backend.deleteBranch.mockResolvedValue({ deleted: true });
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "abandon me",
        status: "failed",
        failureReason: "session exited unexpectedly",
        worktreePath: worktree,
        branchName: "mullion/task-1",
      })
      .returning()
      .all();
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${row.id}?force=true` });
    expect(res.statusCode).toBe(204);
    expect(forget).toHaveBeenCalledWith(projectId, "local", worktree);
    expect(fs.existsSync(file)).toBe(false);
  });
});
