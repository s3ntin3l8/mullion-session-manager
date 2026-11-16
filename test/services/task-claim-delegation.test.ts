import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as TaskPrompt from "../../src/services/task-prompt.js";

// Same fakes as task-claim-retry-reused.test.ts: no real systemd/pty, real git.
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
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
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
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/task-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskPrompt>();
  return { ...actual, buildWorkerPrompt: vi.fn(actual.buildWorkerPrompt) };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { enqueueTask, dispatchClaimedTask } = await import("../../src/services/task-claim.js");
const { retryTask } = await import("../helpers/retry-task.js");
const { buildWorkerPrompt } = await import("../../src/services/task-prompt.js");
const { tasks } = await import("../../src/db/schema.js");
const { createTaskGitRepo, createTaskProject, insertFailedTaskWithPreservedBranch } =
  await import("../helpers/task-retry-fixture.js");

const tmpDb = path.join(os.tmpdir(), `task-claim-delegation-${process.pid}.db`);

// The delegation clause only exists if a spawn site threads `delegation` into
// the worker prompt. The builder and the tier comparison are tested in
// isolation; a claim or retry call site that dropped the argument would
// silently turn the feature off with the whole suite green.
describe("worker spawns pass the delegation context to the prompt", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
  });
  beforeEach(() => {
    vi.mocked(buildWorkerPrompt).mockClear();
  });

  async function setup() {
    const app = await buildApp();
    const cwd = createTaskGitRepo("task-claim-delegation-repo-");
    const projectId = await createTaskProject(app, cwd, "claim-delegation-p");
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { claudeCode: { defaultModel: "opus", delegateModel: "sonnet" } },
    });
    return { app, cwd, projectId };
  }

  it("claim: the resolved worker model and the configured delegate model", async () => {
    const { app, cwd, projectId } = await setup();
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 91, title: "t", body: "details", status: "ready" })
      .returning()
      .all();

    expect((await enqueueTask(app, task.id, { auto: false })).ok).toBe(true);
    expect((await dispatchClaimedTask(app, task.id)).ok).toBe(true);

    expect(buildWorkerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "claim",
        delegation: { workerModel: "opus", delegateModel: "sonnet" },
      }),
    );
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("retry: the same context, honouring the task's own model", async () => {
    const { app, cwd, projectId } = await setup();
    const task = await insertFailedTaskWithPreservedBranch(app, projectId, cwd, 92);

    expect((await retryTask(app, task.id)).ok).toBe(true);

    expect(buildWorkerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "retry",
        delegation: { workerModel: "opus", delegateModel: "sonnet" },
      }),
    );
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });
});
