import { describe, it, expect, vi, afterEach } from "vitest";
import {
  reconcilerMocks,
  mockPushDeliveryFactory,
  mockHermesIntegrationFactory,
  mockHermesTaskReviewFactory,
  mockNodePtyFactory,
  mockChildProcessFactory,
  mockTaskPromoteFactory,
  mockTaskReseedFactory,
  mockHostGitFactory,
  mockGitWorktreeFactory,
  mockGithubIntegrationFactory,
  mockGithubWriteFactory,
  mockGithubFactory,
  setupReconcilerTestLifecycle,
  fakeInfo,
  getTask,
  createSessionAndTaskWithBase,
} from "../helpers/task-reconciler-harness.js";

vi.mock("../../src/services/push-delivery.js", (io) => mockPushDeliveryFactory(io));
vi.mock("../../src/services/hermes-integration.js", (io) => mockHermesIntegrationFactory(io));
vi.mock("../../src/services/hermes-task-review.js", (io) => mockHermesTaskReviewFactory(io));
vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
vi.mock("../../src/services/task-promote.js", (io) => mockTaskPromoteFactory(io));
vi.mock("../../src/services/task-reseed.js", (io) => mockTaskReseedFactory(io));
vi.mock("../../src/services/host-git.js", (io) => mockHostGitFactory(io));
vi.mock("../../src/services/git-worktree.js", (io) => mockGitWorktreeFactory(io));
vi.mock("../../src/services/github-integration.js", (io) => mockGithubIntegrationFactory(io));
vi.mock("../../src/services/github-write.js", (io) => mockGithubWriteFactory(io));
vi.mock("../../src/services/github.js", (io) => mockGithubFactory(io));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedHostResponse } from "../helpers/hosts.js";

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const render = await import("../../src/services/scrollback-render.js");
const { recordTaskTransition } = await import("../../src/services/task-state.js");
const { querySessionEvents } = await import("../../src/services/event-history.js");

describe("reconcileTasks — worker never started", () => {
  setupReconcilerTestLifecycle("task-worker-start");
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(
    options: {
      started?: boolean;
      unreadable?: boolean;
      restored?: boolean;
      timeout?: number;
      age?: number;
      format?: "codex" | "claude-code";
    } = {},
  ) {
    const app = await buildApp();
    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { taskMaster: { workerStartTimeoutMinutes: options.timeout ?? 10 } },
    });
    const { taskId, sessionId } = await createSessionAndTaskWithBase(app, "in_progress");
    const since = Date.now() - (options.age ?? 11) * 60_000;
    app.db
      .update(sessions)
      .set({
        createdAt: new Date(since),
        command: options.format === "claude-code" ? "claude" : "codex",
      })
      .where(eq(sessions.id, sessionId))
      .run();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-start-"));
    scratch.push(home);
    const root = path.join(home, "sessions");
    fs.mkdirSync(root);
    const file = path.join(root, "rollout.jsonl");
    function writeTurn() {
      const line =
        options.format === "claude-code"
          ? {
              type: "user",
              timestamp: new Date().toISOString(),
              message: { role: "user", content: "task seed" },
            }
          : {
              type: "session_meta",
              payload: { cwd: "/tmp/worker", timestamp: new Date().toISOString() },
            };
      fs.writeFileSync(file, JSON.stringify(line) + "\n");
    }
    if (options.started) writeTurn();
    const note = vi.fn();
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working", lastTurnEndedAt: null }),
      startupTranscriptSearch: () => ({
        format: options.format ?? "codex",
        roots: [options.unreadable ? path.join(home, "missing", "sessions") : root],
        cwd: "/tmp/worker",
        since: options.restored ? Date.now() : since,
      }),
      getRenderableScrollback: () => Buffer.from("raw"),
      size: { cols: 80, rows: 24 },
      emitTaskStartupNote: note,
    } as never);
    const terminate = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
    vi.spyOn(render, "renderScrollback").mockResolvedValue(
      "Codex /hooks trust screen\nTrust these hooks?\n",
    );
    return { app, taskId, sessionId, note, terminate, writeTurn };
  }

  it("flags an alive worker once and quotes its screen without killing it", async () => {
    const { app, taskId, note, terminate } = await setup();
    await reconcileTasks(app);
    expect((await getTask(app, taskId)).needsHumanReason).toBe("worker-not-started");
    expect((await getTask(app, taskId)).status).toBe("in_progress");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Trust these hooks?"));
    expect(note.mock.calls[0][0]).toMatch(/^Codex \/hooks trust screen\nTrust these hooks\?/);
    expect(reconcilerMocks.mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
    await reconcileTasks(app);
    expect(note).toHaveBeenCalledTimes(1);
    expect(reconcilerMocks.mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["codex", "claude-code"] as const)(
    "does not flag a long first %s turn with no assistant output or hooks",
    async (format) => {
      const { app, taskId, note } = await setup({ started: true, format });
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
      expect(note).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("clears the flag on the next tick when a turn appears", async () => {
    const { app, taskId, writeTurn } = await setup();
    await reconcileTasks(app);
    writeTurn();
    await reconcileTasks(app);
    expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
    await app.close();
  });

  it.each([{ unreadable: true }, { timeout: 0 }, { age: 1 }, { restored: true }])(
    "does not flag when %j",
    async (options) => {
      const { app, taskId, note } = await setup(options);
      await reconcileTasks(app);
      expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
      expect(note).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("clears when leaving in_progress and cleans stale flags through a tick", async () => {
    const { app, taskId } = await setup();
    await reconcileTasks(app);
    const row = await getTask(app, taskId);
    app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
    recordTaskTransition(app, {
      taskId,
      projectId: row.projectId,
      from: "in_progress",
      to: "failed",
      via: "test",
    });
    expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
    app.db
      .update(tasks)
      .set({ needsHumanReason: "worker-not-started" })
      .where(eq(tasks.id, taskId))
      .run();
    await reconcileTasks(app);
    expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
    await app.close();
  });
  it.each(["empty", "screen-unavailable", "user", "unsupported", "partial", "throw"] as const)(
    "reads a remote worker's transcript: %s",
    async (mode) => {
      const { app, taskId, sessionId } = await setup();
      vi.mocked(app.pty.get).mockRestore();
      // The shared fixture initially spawns locally. A remote worker has no
      // entry in the primary's PtyManager, so discard that fixture-only PTY.
      app.pty.kill(String(sessionId));
      expect(app.pty.get(String(sessionId))).toBeUndefined();
      const host = await seedHostResponse(app, {
        name: "remote-start",
        baseUrl: "http://127.0.0.1:1",
        token: "test",
      });
      const hostId = host.json().id as string;
      app.db.update(sessions).set({ hostId }).where(eq(sessions.id, sessionId)).run();
      const backendModule = await import("../../src/services/session-backend.js");
      const realResolve = backendModule.resolveBackend;
      vi.spyOn(backendModule, "resolveBackend").mockImplementation((appArg, id) => {
        const real = realResolve(appArg, id);
        if (id !== hostId) return real;
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "liveStatus")
              return async () => ({
                [sessionId]: fakeInfo({ activity: "working", lastTurnEndedAt: null }),
              });
            if (prop === "getRenderedScrollback")
              return async () => {
                if (mode === "screen-unavailable") throw new Error("screen unavailable");
                return "Codex /hooks trust screen\nTrust these hooks?\n";
              };
            if (prop === "getTranscript")
              return async () => {
                if (mode === "throw") throw new Error("unreachable");
                if (mode === "unsupported") return { ok: false, status: 501, error: "unsupported" };
                return {
                  ok: true,
                  entries:
                    mode === "user" ? [{ role: "user", text: "seed", seq: 1, ts: null }] : [],
                  more: mode === "partial",
                  nextSeq: 1,
                  file: "f",
                };
              };
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      await reconcileTasks(app);
      const shouldFlag = mode === "empty" || mode === "screen-unavailable";
      expect((await getTask(app, taskId)).needsHumanReason).toBe(
        shouldFlag ? "worker-not-started" : null,
      );
      const notes = () =>
        querySessionEvents(app.db, { sessionId }).events.filter(
          (event) => event.payload?.reason === "worker-not-started",
        );
      expect(notes()).toHaveLength(shouldFlag ? 1 : 0);
      if (shouldFlag) {
        expect(notes()[0]).toMatchObject({
          kind: "status_change",
          payload: {
            note: expect.stringMatching(
              mode === "empty"
                ? /^Codex \/hooks trust screen\nTrust these hooks\?/
                : /^\(screen unavailable\)/,
            ),
          },
        });
        await reconcileTasks(app);
        expect(notes()).toHaveLength(1);
        expect(reconcilerMocks.mockNotifyTaskNeedsAttention).toHaveBeenCalledTimes(1);
      }
      await app.close();
    },
  );
  it("accepts positive turn evidence for an adopted worker even when its environment was lost", async () => {
    const { app, taskId, writeTurn } = await setup({ restored: true });
    app.db
      .update(tasks)
      .set({ needsHumanReason: "worker-not-started" })
      .where(eq(tasks.id, taskId))
      .run();
    writeTurn();
    await reconcileTasks(app);
    expect((await getTask(app, taskId)).needsHumanReason).toBeNull();
    await app.close();
  });
});
