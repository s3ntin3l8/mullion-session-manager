import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import type { SessionBackend } from "../../src/services/session-backend.js";
import { tasks } from "../../src/db/schema.js";

// POST /api/tasks/:id/reject on a task whose worker is still running (the
// normal state of a task in review): the feedback is typed into that session,
// or — when it can't take it — the worker is replaced. Split out of
// tasks.test.ts, which this repo's file-size ratchet won't let grow; the
// session spawn is faked the same way (node-pty / systemd-run), git is real.
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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `tasks-reject-live-test-${process.pid}.db`);

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-reject-live-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  git(["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(["add", "-A"]);
  git(["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("POST /api/tasks/:id/reject on a task with a live worker", () => {
  let codexHome: string;
  let fakeHome: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // The session's hook adapters write into the agent's real config dir.
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reject-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-reject-fake-home-"));
    process.env.HOME = fakeHome;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  // The reject feedback reaches a worker that is still alive (the normal
  // state of a task in review — the agent idles at its prompt). `liveStatus`
  // is pinned to "no signal" (idle) so the outcome doesn't depend on what a
  // freshly spawned mock PTY happens to look like; `prompt`/`terminate` are
  // the seams under test.
  async function rejectActiveWorker(
    overrides: Partial<Pick<SessionBackend, "prompt" | "terminate" | "liveStatus">>,
  ) {
    const app = await buildApp();
    const cwd = createGitRepo();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "reject-live-p", cwd },
    });
    const projectId = project.json().id;
    const sessionRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude" },
    });
    const activeSessionId = sessionRes.json().id;
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "under review",
        body: "the widget explodes",
        status: "reviewing",
        sessionId: activeSessionId,
        worktreePath: cwd,
        branchName: "mullion/task-reject-live",
        agentCommand: "claude",
      })
      .returning()
      .all();
    const sessionBackendModule = await import("../../src/services/session-backend.js");
    const realResolveBackend = sessionBackendModule.resolveBackend;
    const resolveBackendSpy = vi
      .spyOn(sessionBackendModule, "resolveBackend")
      .mockImplementation((appArg, hostId) => {
        const real = realResolveBackend(appArg, hostId);
        const stubs: Partial<SessionBackend> = {
          liveStatus: () => Promise.resolve({}),
          ...overrides,
        };
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop in stubs) return stubs[prop as keyof SessionBackend];
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/reject`,
      payload: { feedback: "please fix the tests" },
    });
    return {
      res,
      activeSessionId,
      cleanup: async () => {
        resolveBackendSpy.mockRestore();
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      },
    };
  }

  it("types the feedback into a still-active worker instead of re-seeding", async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 });
    const terminate = vi.fn().mockResolvedValue(undefined);
    const { res, activeSessionId, cleanup } = await rejectActiveWorker({ prompt, terminate });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("in_progress");
    expect(res.json().sessionId).toBe(activeSessionId);
    expect(prompt).toHaveBeenCalledTimes(1);
    const [id, opts] = prompt.mock.calls[0] as [string, { text: string; submit: boolean }];
    expect(id).toBe(String(activeSessionId));
    expect(opts.submit).toBe(true);
    // The live agent already has the spec and preamble — only the feedback
    // and the branch it keeps working on.
    expect(opts.text).toContain("please fix the tests");
    expect(opts.text).toContain("mullion/task-reject-live");
    expect(opts.text).not.toContain("as a Mullion Task Master worker");
    expect(opts.text).not.toContain("the widget explodes");
    expect(terminate).not.toHaveBeenCalled();
    await cleanup();
  });

  it("leaves a worker whose host is not answering alone, rather than failing the task", async () => {
    const prompt = vi.fn();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const liveStatus = vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT"));
    const { res, activeSessionId, cleanup } = await rejectActiveWorker({
      prompt,
      terminate,
      liveStatus,
    });

    // A sleeping host says nothing about the session: no typing, no terminate,
    // and the task is not failed for a spawn that was never attempted.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("in_progress");
    expect(res.json().sessionId).toBe(activeSessionId);
    expect(prompt).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    await cleanup();
  });

  it("re-seeds the worker when it cannot take a typed prompt", async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: false, status: 501, error: "unsupported" });
    const terminate = vi.fn().mockResolvedValue(undefined);
    const { res, activeSessionId, cleanup } = await rejectActiveWorker({ prompt, terminate });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("in_progress");
    // The feedback must not be dropped: the stuck worker was replaced.
    expect(terminate).toHaveBeenCalledWith(String(activeSessionId));
    expect(res.json().sessionId).not.toBe(activeSessionId);
    expect(res.json().sessionId).not.toBeNull();
    await cleanup();
  });
});
