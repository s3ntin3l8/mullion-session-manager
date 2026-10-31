// failReviewingGate's diagnostic snapshot (the no-commits failure path).
// The reconciler's own test file covers the transition itself and is at its
// file-size ceiling, so the snapshot's tests live here, calling the function
// directly with a stub backend.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const { mockResolveHostGitStatus, mockCommitHostWipChanges } = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
  mockCommitHostWipChanges: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHostGitStatus: mockResolveHostGitStatus,
  commitHostWipChanges: mockCommitHostWipChanges,
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
const { failReviewingGate } = await import("../../src/services/task-gate-failure.js");
const { projects, sessions, tasks, sessionEvents } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-gate-failure-${process.pid}.db`);

describe("failReviewingGate — failure diagnostics", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  beforeEach(() => {
    mockResolveHostGitStatus.mockReset();
    mockCommitHostWipChanges.mockReset();
  });

  async function setup(scrollback: () => Promise<Buffer>) {
    const app = await buildApp();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-diag", cwd: "/tmp" },
    });
    const projectId = projectRes.json().id as number;
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = sessionRes.json().id as number;
    const claimedAt = new Date(Date.now() - 20 * 60_000);
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        sessionId,
        claimedAt,
        worktreePath: "/tmp/mullion-task-worktree",
        branchName: "mullion/task-999",
        agentCommand: "agy",
        model: "gemini-3.8-flash-medium",
      })
      .returning()
      .all();
    app.db
      .insert(sessionEvents)
      .values({ sessionId, seq: 1, kind: "agentIdle", ts: Date.now(), payload: null })
      .run();
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    const backend = {
      getScrollback: scrollback,
      removeWorktreeIfClean: vi.fn().mockResolvedValue(undefined),
    };
    const run = () =>
      failReviewingGate(
        app,
        task,
        session,
        project,
        backend as never,
        "in_progress",
        "agent ended its turn with no commits on mullion/task-999",
        new Date(),
      );
    const row = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    return { app, run, row };
  }

  it("stores the scrollback tail, agent, model, runtime, git status and salvage outcome", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const { app, run, row } = await setup(async () =>
      Buffer.from(`\u001b[31m${lines}\u001b[0m\nsk-ant-abc123secret\nI give up\n`),
    );
    mockResolveHostGitStatus.mockResolvedValue({
      ok: true,
      value: {
        isRepo: true,
        status: { files: [{ path: "x.ts", status: "M" }], hash: "0000000" },
      },
    });
    mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

    await run();

    const r = row();
    expect(r.status).toBe("failed");
    const d = r.failureDiagnostics!;
    expect(d).toContain("Agent: agy");
    expect(d).toContain("Model: gemini-3.8-flash-medium");
    expect(d).toContain("Runtime: 20 min");
    expect(d).toContain("M x.ts");
    expect(d).toContain("committed a WIP commit");
    expect(d).toContain("agentIdle");
    expect(d).toContain("I give up");
    expect(d).not.toContain("line 5\n"); // only the last 40 lines
    expect(d).not.toContain("\u001b");
    expect(d).not.toContain("sk-ant-abc123secret");
    await app.close();
  });

  it("still fails the task and names what was unavailable when collection throws", async () => {
    const { app, run, row } = await setup(async () => {
      throw new Error("session gone");
    });
    mockResolveHostGitStatus.mockRejectedValue(new Error("git exploded"));
    mockCommitHostWipChanges.mockResolvedValue({
      ok: true,
      value: { committed: false, error: "git add -u failed" },
    });

    await run();

    const r = row();
    expect(r.status).toBe("failed");
    expect(r.failureReason).toContain("no commits");
    expect(r.failureDiagnostics).toContain("Terminal tail: unavailable");
    expect(r.failureDiagnostics).toContain("Git status: unavailable");
    expect(r.failureDiagnostics).toContain("failed (git add -u failed)");
    await app.close();
  });

  it("caps an oversized scrollback", async () => {
    const { app, run, row } = await setup(async () => Buffer.from("z".repeat(200_000)));
    mockResolveHostGitStatus.mockResolvedValue({
      ok: true,
      value: { isRepo: false, status: null },
    });
    mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: false } });

    await run();

    expect(row().failureDiagnostics!.length).toBeLessThanOrEqual(4000);
    await app.close();
  });
});
