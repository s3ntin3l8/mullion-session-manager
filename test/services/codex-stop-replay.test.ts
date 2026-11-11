// Issue #2939 — a Stop rejected before adoption is still applied from the
// rollout once the session is adopted, and only once.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions, tasks } from "../../src/db/schema.js";
import { adoptSurvivingSession } from "../../src/services/session-adopt.js";
import { replayDroppedCodexStop } from "../../src/services/codex-stop-replay.js";
import { mapCodexStop } from "../../src/hooks/forwarder-core.mjs";
import type { SessionLiveness } from "../../src/services/session-process.js";

vi.mock("node-pty", () => plainNodePtyMock());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const COMPLETED_AT = 1_792_791_560;
const originalCodexHome = process.env.CODEX_HOME;

function rollout(payload: Record<string, unknown>, extra = ""): string {
  return `${JSON.stringify({
    type: "event_msg",
    ordinal: 7,
    payload,
  })}\n${extra}`;
}

function cleanPayload(over: Record<string, unknown> = {}) {
  return {
    type: "task_complete",
    turn_id: "turn-clean",
    last_agent_message: "done",
    completed_at: COMPLETED_AT,
    ...over,
  };
}

function writeRollout(contents: string): { path: string; codexHome: string } {
  const codexHome = process.env.CODEX_HOME!;
  const dir = join(codexHome, "sessions", "2026", "10", "24");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-replay.jsonl");
  writeFileSync(path, contents);
  return { path, codexHome };
}

describe("replayDroppedCodexStop (issue #2939)", () => {
  beforeEach(() => {
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-replay-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  async function seedRunning(contents: string, claimedAt: Date) {
    const app = await buildTestApp();
    await app.ready();
    const [project] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/work/p" })
      .returning()
      .all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "codex" })
      .returning()
      .all();
    app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "in_progress",
        sessionId: session.id,
        claimedAt,
        branchName: "mullion/task-1",
      })
      .run();
    const id = String(session.id);
    app.pty.getOrCreate({ id, cwd: "/tmp", command: "codex", cols: 80, rows: 24 });
    const written = writeRollout(contents);
    app.pty.setCodexTranscriptPath(id, written.path);
    return { app, id };
  }

  it("applies a clean completion once the session is adopted, and not twice", async () => {
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    const { app, id } = await seedRunning(rollout(cleanPayload()), claimedAt);
    const emit = vi.spyOn(app.pty, "emitHookEvent");

    await replayDroppedCodexStop(app, id);
    await replayDroppedCodexStop(app, id);

    expect(emit).toHaveBeenCalledTimes(1);
    const message = emit.mock.calls[0][1];
    expect(message).toEqual(mapCodexStop({ last_assistant_message: "done" }));
    expect(emit.mock.calls[0][3]).toEqual({ provesHookPipeline: false });
  });

  it("does not replay a completion older than the claim", async () => {
    const claimedAt = new Date((COMPLETED_AT + 60) * 1000);
    const { app, id } = await seedRunning(rollout(cleanPayload()), claimedAt);
    const emit = vi.spyOn(app.pty, "emitHookEvent");
    await replayDroppedCodexStop(app, id);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not replay a completion a later prompt follows", async () => {
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    const later = `${JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "keep going" },
    })}\n`;
    const { app, id } = await seedRunning(rollout(cleanPayload(), later), claimedAt);
    const emit = vi.spyOn(app.pty, "emitHookEvent");
    await replayDroppedCodexStop(app, id);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not replay a v2 completion a later turn_started follows", async () => {
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    const later = `${JSON.stringify({
      type: "event_msg",
      payload: { type: "turn_started" },
    })}\n`;
    const { app, id } = await seedRunning(
      rollout(cleanPayload({ type: "turn_complete" }), later),
      claimedAt,
    );
    const emit = vi.spyOn(app.pty, "emitHookEvent");
    await replayDroppedCodexStop(app, id);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not turn a rate-limited completion into a finished turn", async () => {
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    const { app, id } = await seedRunning(
      rollout(
        cleanPayload({
          error: {
            message: "You've hit your usage limit. try again at Nov 4th, 2026 3:39 AM",
            codex_error_info: "usage_limit_exceeded",
          },
        }),
      ),
      claimedAt,
    );
    const emit = vi.spyOn(app.pty, "emitHookEvent");
    await replayDroppedCodexStop(app, id);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not replay a completion that failed for a non-quota error", async () => {
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    const { app, id } = await seedRunning(
      rollout(
        cleanPayload({
          error: {
            message: "internal server error",
            codex_error_info: { internal_server_error: { http_status_code: 500 } },
          },
        }),
      ),
      claimedAt,
    );
    const emit = vi.spyOn(app.pty, "emitHookEvent");
    await replayDroppedCodexStop(app, id);
    expect(emit).not.toHaveBeenCalled();
  });

  it("replays when adopt attaches a session whose Stop was already dropped", async () => {
    const app = await buildTestApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/work/p" })
      .returning()
      .all();
    const [session] = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "codex", cwd: "/work/p" })
      .returning()
      .all();
    const id = String(session.id);
    const claimedAt = new Date((COMPLETED_AT - 60) * 1000);
    app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "t",
        status: "in_progress",
        sessionId: session.id,
        claimedAt,
      })
      .run();
    const written = writeRollout(rollout(cleanPayload()));
    const tracked = new Set<string>();
    vi.spyOn(app.pty, "get").mockImplementation(((key: string) =>
      tracked.has(key) ? { isAlive: true } : undefined) as unknown as typeof app.pty.get);
    vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue("alive" as SessionLiveness);
    vi.spyOn(app.pty, "getOrCreate").mockImplementation(((opts: { id: string }) => {
      tracked.add(opts.id);
      return { spawnOutcome: async () => {} };
    }) as unknown as typeof app.pty.getOrCreate);
    vi.spyOn(app.pty, "codexTranscriptPathSessions").mockReturnValue([
      { id, transcriptPath: written.path, codexHome: written.codexHome },
    ]);
    const emit = vi.spyOn(app.pty, "emitHookEvent");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("adopted");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toEqual(mapCodexStop({ last_assistant_message: "done" }));

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("live");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
