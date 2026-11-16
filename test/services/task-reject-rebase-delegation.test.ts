import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as TaskPrompt from "../../src/services/task-prompt.js";
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";

vi.mock("node-pty", () => plainNodePtyMock());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

vi.mock("../../src/services/git-worktree.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resumeTaskWorktree: vi.fn().mockResolvedValue({
    path: "/tmp/task-delegation",
    branch: "mullion/task-delegation",
  }),
}));
vi.mock("../../src/services/task-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskPrompt>();
  return {
    ...actual,
    buildRejectPrompt: vi.fn(actual.buildRejectPrompt),
    buildRebasePrompt: vi.fn(actual.buildRebasePrompt),
  };
});
vi.mock("../../src/services/task-issue-context.js", () => ({
  resolveTaskIssueContextSafe: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/services/task-reseed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reseedTaskIfSessionExited: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/checkout-removal.js", () => ({
  forceRemoveCheckout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/worker-rapid-exit.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPrHeadSha: vi.fn().mockResolvedValue("head-sha"),
}));
vi.mock("../../src/services/session-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSessionRecord: vi.fn().mockResolvedValue({ ok: false, reason: "spawn-failed" }),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { deliverRejectFeedback } = await import("../../src/services/task-reject.js");
const { attemptAutoRebase } = await import("../../src/services/task-auto-rebase.js");
const { buildRejectPrompt, buildRebasePrompt } = await import("../../src/services/task-prompt.js");
const tmpDb = path.join(os.tmpdir(), `task-reject-rebase-delegation-${process.pid}.db`);

describe("fresh reject and rebase workers receive delegation context", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(buildRejectPrompt).mockClear();
    vi.mocked(buildRebasePrompt).mockClear();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  for (const delegateModel of ["sonnet", null]) {
    for (const mode of ["reject", "rebase"] as const) {
      it(`${mode}: ${delegateModel ? "renders a cheaper configured delegate" : "omits delegation when unset"}`, async () => {
        const app = await buildApp();
        apps.push(app);
        const response = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "delegation", cwd: "/tmp" },
        });
        const projectId = response.json().id as number;
        app.db.update(projects).set({ autoApprove: true }).where(eq(projects.id, projectId)).run();
        const settings = await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { claudeCode: { defaultModel: "opus", delegateModel } },
        });
        expect(settings.statusCode).toBe(200);
        const [session] = app.db
          .insert(sessions)
          .values({
            projectId,
            command: "claude",
            cwd: "/tmp",
            status: "exited",
          })
          .returning()
          .all();
        const [task] = app.db
          .insert(tasks)
          .values({
            projectId,
            title: "Follow-up",
            body: "Implement the task",
            status: "done",
            agentCommand: "claude",
            sessionId: session.id,
            branchName: "mullion/task-delegation",
            worktreePath: "/tmp/task-delegation",
          })
          .returning()
          .all();
        const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
        if (mode === "reject") {
          expect(await deliverRejectFeedback(app, task, project, "Fix feedback")).toBe(true);
        } else {
          await attemptAutoRebase(app, task, project, "main");
        }
        const builder = mode === "reject" ? buildRejectPrompt : buildRebasePrompt;
        expect(builder).toHaveBeenCalledWith(
          expect.objectContaining({
            delegation: { workerModel: "opus", delegateModel },
          }),
        );
        const rendered = vi.mocked(builder).mock.results[0].value as string;
        expect(rendered.includes('model: "sonnet"')).toBe(delegateModel !== null);
      });
    }
  }
});
