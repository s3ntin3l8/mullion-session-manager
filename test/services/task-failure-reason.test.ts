// The "no commits" failure REASON (checkReviewingGate, task-reconciler.ts).
//
// Its own file, not a block in task-reconciler.test.ts: that file is at the
// file-size ratchet's ceiling (scripts/check-max-file-lines.mjs), so it
// cannot grow.
//
// Issue #2505 — the reason a task card shows when the worker ended its turn
// without committing. A provider error that ended the turn must be NAMED
// there: "agent ended its turn with no commits" reads as "the agent gave
// up", which is a different story from "the provider's plan ran out".

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const { mockResolveHostGitStatus } = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
}));

vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHostGitStatus: mockResolveHostGitStatus,
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
const { checkReviewingGate } = await import("../../src/services/task-reconciler.js");
const { projects, sessions, tasks } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const tmpDb = path.join(os.tmpdir(), `task-failure-reason-${process.pid}.db`);

// Low-entropy on purpose (not a real commit hash) — a realistic-looking
// 40-char hex string trips detect-secrets' hex-high-entropy heuristic.
const BASE_SHA = "0000000111122223333444455556666777788889";

/** The parts of SessionInfo checkReviewingGate reads. */
function sessionInfo(errorState: string, errorDetail: string | null) {
  return { errorState, errorDetail } as never;
}

describe("checkReviewingGate — the failure reason (issue #2505)", () => {
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
    // HEAD is still at the base — the gate fails the task.
    mockResolveHostGitStatus.mockResolvedValue({
      ok: true,
      value: {
        isRepo: true,
        status: {
          branch: "mullion/task-999",
          hash: "0000000",
          ahead: 0,
          behind: 0,
          files: [],
          isClean: false,
        },
      },
    });
  });

  async function setup() {
    const app = await buildApp();
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-reason", cwd: "/tmp" },
    });
    const projectId = projectRes.json().id as number;
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = sessionRes.json().id as number;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        sessionId,
        claimedAt: new Date(),
        worktreePath: "/tmp/mullion-task-worktree",
        branchName: "mullion/task-999",
        baseSha: BASE_SHA,
      })
      .returning()
      .all();
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    return { app, task, project, session };
  }

  it("names the provider error that ended the turn", async () => {
    const { app, task, project } = await setup();
    const message = "Token Plan usage limit reached: Upgrade your Token Plan (2056)";

    const gate = await checkReviewingGate(
      app,
      task,
      project,
      sessionInfo("api_error", message),
      "local",
    );

    expect(gate.ok).toBe(false);
    const reason = (gate as { failureReason: string }).failureReason;
    expect(reason).toContain("no commits");
    // Truncated to the same 48 chars every other human-facing detail uses
    // (PR #726) — the reason is posted verbatim to a public issue comment.
    expect(reason).toContain(`${message.slice(0, 48)}…`);
    await app.close();
  });

  it("truncates a long provider error (the reason is posted to a public issue)", async () => {
    const { app, task, project } = await setup();
    const message = `x${"y".repeat(200)}`;

    const gate = await checkReviewingGate(
      app,
      task,
      project,
      sessionInfo("api_error", message),
      "local",
    );

    const reason = (gate as { failureReason: string }).failureReason;
    expect(reason).toContain("…");
    expect(reason.length).toBeLessThan(200);
    await app.close();
  });

  it("leaves the reason unchanged when the session had no failure", async () => {
    const { app, task, project } = await setup();

    const gate = await checkReviewingGate(app, task, project, sessionInfo("idle", null), "local");

    expect(gate.ok).toBe(false);
    const reason = (gate as { failureReason: string }).failureReason;
    expect(reason).toContain("no commits");
    expect(reason).not.toContain("(");
    await app.close();
  });

  it("names a rate_limit failure with the quota prefix", async () => {
    const { app, task, project } = await setup();

    const gate = await checkReviewingGate(
      app,
      task,
      project,
      sessionInfo("api_error", "rate_limit"),
      "local",
    );

    const reason = (gate as { failureReason: string }).failureReason;
    expect(reason).toContain("rate_limit quota exhausted");
    await app.close();
  });
});
