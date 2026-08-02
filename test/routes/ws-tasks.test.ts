import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";

// Real integration test against a genuine listening server, same harness
// shape as test/routes/events.test.ts — app.inject() can't drive a full
// WebSocket upgrade.
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
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const mockSyncTaskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: mockSyncTaskTransition,
  computeTaskDiffStat: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `ws-tasks-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tasks-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

interface WireTaskEvent {
  taskId: number;
  projectId: number;
  kind: string;
  from: string;
  to: string;
  ts: number;
}

function collectJsonMessages(ws: WebSocket): WireTaskEvent[] {
  const messages: WireTaskEvent[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as WireTaskEvent);
  });
  return messages;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
}

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("tasks WS route (/ws/tasks, #488)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  afterEach(() => {
    mockSyncTaskTransition.mockClear();
  });

  async function buildAndListen() {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  it("broadcasts a live event to every connected client when a task transitions via claim", async () => {
    const { app, port } = await buildAndListen();
    const cwd = createGitRepo();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "ws-tasks-p", cwd },
    });
    const projectId = project.json().id as number;
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, issueNumber: 1, title: "t", status: "ready" })
      .returning()
      .all();

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks`);
    const messages1 = collectJsonMessages(ws1);
    const messages2 = collectJsonMessages(ws2);
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    const claimRes = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/claim`,
    });
    expect(claimRes.statusCode).toBe(201);

    await waitUntil(() => messages1.length > 0 && messages2.length > 0);

    for (const messages of [messages1, messages2]) {
      expect(messages[0]).toMatchObject({
        taskId: task.id,
        projectId,
        kind: "transition",
        from: "ready",
        to: "claimed",
      });
      expect(typeof messages[0].ts).toBe("number");
    }

    ws1.close();
    ws2.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    await app.close();
  });

  it("does not broadcast a boardOrder-only PATCH (no status change)", async () => {
    const { app, port } = await buildAndListen();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "ws-tasks-p2", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "backlog", boardOrder: 0 })
      .returning()
      .all();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks`);
    const messages = collectJsonMessages(ws);
    await waitForOpen(ws);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { boardOrder: 5 },
    });
    expect(patchRes.statusCode).toBe(200);

    // Give the event loop a few ticks to prove nothing arrives, rather than
    // asserting on a fixed timeout racing the broadcast.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toHaveLength(0);

    ws.close();
    await app.close();
  });

  it("broadcasts a status-changing PATCH (backlog -> ready)", async () => {
    const { app, port } = await buildAndListen();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "ws-tasks-p3", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const [task] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "backlog" })
      .returning()
      .all();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tasks`);
    const messages = collectJsonMessages(ws);
    await waitForOpen(ws);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: { status: "ready" },
    });
    expect(patchRes.statusCode).toBe(200);

    await waitUntil(() => messages.length > 0);
    expect(messages[0]).toMatchObject({
      taskId: task.id,
      projectId,
      from: "backlog",
      to: "ready",
    });

    ws.close();
    await app.close();
  });
});
