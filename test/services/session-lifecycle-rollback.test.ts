import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";

// M5 — createSessionRecord's rollback scope. Never lets a real systemd-run
// fire (#1137): both node-pty and node:child_process's spawn are faked, and
// every resolveBackend() call is replaced with a fake backend.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const settingsModule = await import("../../src/services/settings.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-rollback-${process.pid}.db`);
const WT = "/tmp/proj/.mullion-worktrees/session-1";
const BRANCH = "mullion/session-1";

describe("createSessionRecord rollback (M5)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(spawn?: () => Promise<unknown>) {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${Math.random()}`, cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const backend = {
      createWorktree: vi.fn().mockResolvedValue({ created: true, path: WT, branch: BRANCH }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn(spawn ?? (async () => ({}))),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
    return { app, projectId, backend };
  }

  const params = (projectId: number, extra: Record<string, unknown> = {}) => ({
    projectId,
    command: "bash",
    worktree: { baseRef: "main" },
    ...extra,
  });

  function expectWorktreeAndBranchRemoved(backend: Awaited<ReturnType<typeof setup>>["backend"]) {
    expect(backend.removeWorktree).toHaveBeenCalledWith(WT, "/tmp");
    expect(backend.deleteBranch).toHaveBeenCalledWith("/tmp", BRANCH, { force: true });
  }

  it("spawn failure terminates the backend session, removes the worktree and branch, and deletes the row", async () => {
    const { app, projectId, backend } = await setup(async () => {
      throw new Error("boom");
    });
    const res = await createSessionRecord(app, params(projectId));
    expect(res.ok).toBe(false);
    expectWorktreeAndBranchRemoved(backend);
    expect(backend.terminate).toHaveBeenCalledTimes(1);
    expect(app.db.select().from(sessions).all()).toEqual([]);
    await app.close();
  });

  it("unique-conflict removes the worktree and its branch", async () => {
    const { app, projectId, backend } = await setup();
    const dock = { kind: "dock" as const, name: "docker-stack:demo" };
    const first = await createSessionRecord(app, { projectId, command: "bash", ...dock });
    expect(first.ok).toBe(true);
    const res = await createSessionRecord(app, params(projectId, dock));
    expect(res).toMatchObject({ ok: false, reason: "unique-conflict" });
    expectWorktreeAndBranchRemoved(backend);
    // Nothing was inserted, so there is no session to terminate.
    expect(backend.terminate).not.toHaveBeenCalled();
    await app.close();
  });

  it("child-cap-exceeded removes the worktree and its branch", async () => {
    const { app, projectId, backend } = await setup();
    const parent = await createSessionRecord(app, { projectId, command: "bash" });
    if (!parent.ok) throw new Error("parent create failed");
    const parentId = parent.row.id;
    const cap = settingsModule.getStoredSettings(app.db).sessions.maxChildSessionsPerParent;
    for (let i = 0; i < cap; i++) {
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", parentSessionId: parentId })
        .run();
    }
    backend.removeWorktree.mockClear();
    const res = await createSessionRecord(app, params(projectId, { parentSessionId: parentId }));
    expect(res).toMatchObject({ ok: false, reason: "child-cap-exceeded" });
    expectWorktreeAndBranchRemoved(backend);
    await app.close();
  });

  it("a throw between insert and spawn unwinds the worktree, branch, session and row, then rethrows", async () => {
    const { app, projectId, backend } = await setup();
    const real = settingsModule.getStoredSettings;
    let calls = 0;
    vi.spyOn(settingsModule, "getStoredSettings").mockImplementation((db) => {
      // 1st call = child cap (pre-insert); a later one runs after the insert.
      if (++calls >= 2) throw new Error("post-insert failure");
      return real(db);
    });
    await expect(createSessionRecord(app, params(projectId))).rejects.toThrow(
      "post-insert failure",
    );
    expectWorktreeAndBranchRemoved(backend);
    expect(backend.terminate).toHaveBeenCalledTimes(1);
    expect(backend.spawn).not.toHaveBeenCalled();
    expect(app.db.select().from(sessions).where(eq(sessions.projectId, projectId)).all()).toEqual(
      [],
    );
    await app.close();
  });

  it("does not delete a branch it did not create (existing-branch checkout path)", async () => {
    const { app, projectId, backend } = await setup(async () => {
      throw new Error("boom");
    });
    Object.assign(backend, {
      checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: WT, branch: "main" }),
    });
    const res = await createSessionRecord(app, {
      projectId,
      command: "bash",
      worktree: { branch: "main" },
    });
    expect(res.ok).toBe(false);
    expect(backend.removeWorktree).toHaveBeenCalledWith(WT, "/tmp");
    expect(backend.deleteBranch).not.toHaveBeenCalled();
    await app.close();
  });
});
