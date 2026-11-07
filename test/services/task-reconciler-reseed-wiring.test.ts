import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockCreateSessionRecord = vi.fn();
const mockTerminate = vi.fn();
const mockLiveStatus = vi.fn();
const mockPrompt = vi.fn();
const mockRenderedScrollback = vi.fn();
const mockTranscript = vi.fn();
const mockResolveBackend = vi.fn(() => ({
  terminate: mockTerminate,
  liveStatus: mockLiveStatus,
  prompt: mockPrompt,
  getRenderedScrollback: mockRenderedScrollback,
  getTranscript: mockTranscript,
}));
const mockCloseSessionBrowserBindings = vi.fn();

vi.mock("../../src/services/session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createSessionRecord: mockCreateSessionRecord };
});
vi.mock("../../src/services/session-backend.js", () => ({
  resolveBackend: mockResolveBackend,
}));
vi.mock("../../src/services/session-browsers.js", () => ({
  closeSessionBrowserBindings: mockCloseSessionBrowserBindings,
}));

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { reseedTaskIfSessionExited, resetPendingAdoptedSeeds, ADOPTED_SEED_GRACE_MS } =
  await import("../../src/services/task-reseed.js");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-reseed-wiring-${process.pid}.db`);

// #2691 — recheckAdoptedSeeds is called from reconcileTasks; its own tests call it
// directly, so dropping that call would still pass them. This goes through the
// reconciler.
describe("reconcileTasks re-checks an adopted re-seed session", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;
  const SEED = "Reviewer feedback: please fix the flaky test";

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "reseed-wiring", cwd: "/tmp" },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminate.mockResolvedValue(undefined);
    mockLiveStatus.mockResolvedValue({});
    mockPrompt.mockResolvedValue({ ok: true, outputOffset: 0 });
    mockRenderedScrollback.mockResolvedValue("");
    mockTranscript.mockResolvedValue({ ok: false, status: 404, error: "no transcript" });
    resetPendingAdoptedSeeds();
  });

  /** An in-progress task whose re-seed spawn outcome was unknown: adopted, seedDelivered false. */
  async function adoptedTask() {
    const dead = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "exited" })
      .returning()
      .all()[0];
    const kept = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active" })
      .returning()
      .all()[0];
    const task = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        sessionId: dead.id,
        worktreePath: "/tmp/wt",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all()[0];
    mockCreateSessionRecord.mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      sessionId: kept.id,
    });
    await reseedTaskIfSessionExited(
      app,
      task,
      { id: projectId, hostId: "local" } as never,
      SEED,
      "t",
    );
    mockCreateSessionRecord.mockClear();
    const seedOf = () =>
      app.db.select().from(tasks).where(eq(tasks.id, task.id)).all()[0].seedDelivered;
    return { kept, seedOf };
  }

  it("types the seed into an adopted session once, through reconcileTasks, and never spawns", async () => {
    const { kept, seedOf } = await adoptedTask();
    // The transcript answered and holds no such user turn: the seed never arrived.
    mockTranscript.mockResolvedValue({
      ok: true,
      entries: [{ seq: 0, ts: null, role: "user", text: "something else" }],
      nextSeq: 1,
      more: false,
      file: "f",
    });
    expect(seedOf()).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ADOPTED_SEED_GRACE_MS + 1000);
    try {
      await reconcileTasks(app);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(mockPrompt).toHaveBeenCalledWith(String(kept.id), { text: SEED, submit: true });
      expect(seedOf()).toBe(true);

      await reconcileTasks(app);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retype a collapsed seed when no transcript can say, through reconcileTasks", async () => {
    // The paste placeholder is all the screen shows, and the agent keeps no
    // transcript: the spawn carried the seed on argv, so it is not typed again.
    const { seedOf } = await adoptedTask();
    mockRenderedScrollback.mockResolvedValue("[Pasted text #1 +2 lines]\n> ");
    expect(seedOf()).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ADOPTED_SEED_GRACE_MS + 1000);
    try {
      await reconcileTasks(app);
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf()).toBe(true);
      expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
