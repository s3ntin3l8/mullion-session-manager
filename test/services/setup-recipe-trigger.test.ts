import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";

// Issue #2245 — the trigger points: a worktree cut by createSessionRecord (and
// a promote's `ownedWorktree`) runs the project's recipe; a plain session or a
// resumed tree (cwd only) does not. node-pty and every session-scope spawn are
// faked (#1137); only `sh` — the recipe itself — runs for real.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["sh"] });
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");

const tmpDb = path.join(os.tmpdir(), `setup-recipe-trigger-${process.pid}.db`);
let wt: string;

describe("setup recipe trigger", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "setup-trigger-wt-"));
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(wt, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(recipe: string | null) {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: `p-${Math.random()}`, cwd: "/tmp", setupRecipe: recipe })
      .returning()
      .all();
    const backend = {
      createWorktree: vi.fn().mockResolvedValue({ created: true, path: wt, branch: "mullion/s-1" }),
      checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: wt }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn(async () => ({})),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
    const status = (id: number) =>
      app.db.select().from(sessions).where(eq(sessions.id, id)).all()[0]?.setupStatus ?? null;
    return { app, project, status };
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(check()).toBe(true);
  }

  it("runs the recipe in a freshly cut worktree without blocking the create", async () => {
    const { app, project, status } = await setup("touch installed.marker && sleep 0.2");
    const res = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      worktree: { baseRef: "main" },
    });
    if (!res.ok) throw new Error("create failed");
    // The create returned while the recipe is still going.
    expect(status(res.row.id)).toBe("running");
    await until(() => status(res.row.id) === "ok");
    expect(fs.existsSync(path.join(wt, "installed.marker"))).toBe(true);
    await app.close();
  });

  it("flags a failing recipe but leaves the session alive", async () => {
    const { app, project, status } = await setup("exit 2");
    const res = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      worktree: { baseRef: "main" },
    });
    if (!res.ok) throw new Error("create failed");
    await until(() => status(res.row.id) === "failed");
    const row = app.db.select().from(sessions).where(eq(sessions.id, res.row.id)).all()[0];
    expect(row.status).toBe("active");
    await app.close();
  });

  it("runs for a dock preview's checked-out branch tree and a promote's owned worktree", async () => {
    const { app, project, status } = await setup("true");
    const preview = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      worktree: { branch: "feat/x" },
    });
    if (!preview.ok) throw new Error("create failed");
    await until(() => status(preview.row.id) === "ok");
    const promoted = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      cwd: wt,
      ownedWorktree: { branch: "mullion/s-1", repoCwd: "/tmp" },
    });
    if (!promoted.ok) throw new Error("create failed");
    await until(() => status(promoted.row.id) === "ok");
    await app.close();
  });

  it("does not run for a session with no recipe, or for an existing tree (resume)", async () => {
    const none = await setup(null);
    const a = await createSessionRecord(none.app, {
      projectId: none.project.id,
      command: "bash",
      worktree: { baseRef: "main" },
    });
    if (!a.ok) throw new Error("create failed");
    expect(none.status(a.row.id)).toBeNull();
    await none.app.close();

    const { app, project, status } = await setup("touch resumed.marker");
    const b = await createSessionRecord(app, {
      projectId: project.id,
      command: "bash",
      cwd: wt,
    });
    if (!b.ok) throw new Error("create failed");
    await new Promise((r) => setTimeout(r, 150));
    expect(status(b.row.id)).toBeNull();
    expect(fs.existsSync(path.join(wt, "resumed.marker"))).toBe(false);
    await app.close();
  });
});
