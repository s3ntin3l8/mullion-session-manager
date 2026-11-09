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
const { closeDb } = await import("../../src/db/client.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const {
  reseedTaskIfSessionExited,
  promptLiveTaskWorker,
  readLiveWorkerState,
  recheckAdoptedSeeds,
  resetPendingAdoptedSeeds,
  ADOPTED_SEED_GRACE_MS,
} = await import("../../src/services/task-reseed.js");

const tmpDb = path.join(os.tmpdir(), `task-reseed-test-${process.pid}.db`);

describe("reseedTaskIfSessionExited", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "reseed-test", cwd: "/tmp" },
    });
    projectId = res.json().id;
  });

  afterAll(async () => {
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

  function insertSessionRow(status: "active" | "exited") {
    return app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status })
      .returning()
      .all()[0];
  }

  function insertTaskWithSession(status: "active" | "exited") {
    const sessionRow = insertSessionRow(status);
    const taskRow = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "in_progress",
        sessionId: sessionRow.id,
        worktreePath: "/tmp/wt",
        agentCommand: "claude",
        claimedAt: new Date(),
      })
      .returning()
      .all()[0];
    return { task: taskRow, sessionId: sessionRow.id };
  }

  // A real (freshly-inserted) session row for createSessionRecord's mocked
  // "spawn succeeded" result to point at — tasks.sessionId is a real FK, so
  // a fabricated numeric id the DB has never seen would fail the write this
  // function does on success.
  function mockSuccessfulSpawn() {
    const newSession = insertSessionRow("active");
    mockCreateSessionRecord.mockResolvedValue({
      ok: true,
      row: newSession,
      project: { hostId: "local" },
      initialPromptApplied: true,
    });
    return newSession.id;
  }

  const project = { id: 1, hostId: "local" } as never;

  it("no-ops when the task has no sessionId/worktreePath/agentCommand", async () => {
    const [row] = app.db
      .insert(tasks)
      .values({ projectId, title: "t", status: "backlog" })
      .returning()
      .all();

    const result = await reseedTaskIfSessionExited(app, row, project, "prompt", "test");

    expect(result).toBe(false);
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    expect(mockTerminate).not.toHaveBeenCalled();
  });

  it("spawns a fresh session when the previous one has already exited", async () => {
    const { task } = insertTaskWithSession("exited");
    const newSessionId = mockSuccessfulSpawn();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(true);
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockCreateSessionRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cwd: "/tmp/wt",
        command: "claude",
        initialPrompt: "prompt text",
        // Named like every other worker spawn, so the UI reads it as task #N's worker.
        name: `Task #${task.id} · worker`,
        nameLocked: true,
      }),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(newSessionId);
  });

  it("without force: does nothing at all when the previous session is still active", async () => {
    const { task } = insertTaskWithSession("active");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
  });

  it("with force: true — terminates the still-active session, then spawns fresh", async () => {
    const { task, sessionId } = insertTaskWithSession("active");
    const newSessionId = mockSuccessfulSpawn();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(true);
    expect(mockTerminate).toHaveBeenCalledWith(String(sessionId));
    expect(mockCreateSessionRecord).toHaveBeenCalledTimes(1);
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(newSessionId);
    // #772 — the OLD session's row must flip to "killed" once terminate is
    // CONFIRMED to have succeeded, not left "active" for the 30s
    // exited-session reconciler to eventually mark "exited".
    const [oldSessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    expect(oldSessionRow.status).toBe("killed");
    // Fresh subagent review, PR #773 follow-up — killSession() isn't used
    // here (see the comment at the call site), so this side effect has to
    // be triggered explicitly on the same confirmed-success path, or a
    // stale session-browser binding lingers forever.
    expect(mockCloseSessionBrowserBindings).toHaveBeenCalledTimes(1);
    expect(mockCloseSessionBrowserBindings.mock.calls[0][1]).toBe(sessionId);
  });

  // Issue #988 — the session row must read "killed" for the ENTIRE
  // terminate() await window, not just after it resolves. `terminate()`
  // itself awaits `systemctl --user stop`, which can block for up to
  // systemd's own DefaultTimeoutStopSec (90s in the incident that motivated
  // this) — for that whole window the OLD shape here left the row reading
  // "active", squarely inside reconcileExitedSessions's own candidate query.
  // Asserting the ordering (not just the eventual end state, which the two
  // tests above already cover) requires observing the row from INSIDE
  // terminate()'s own mock, before it resolves.
  it("with force: true — marks the session 'killed' BEFORE awaiting terminate, not after", async () => {
    const { task, sessionId } = insertTaskWithSession("active");
    mockSuccessfulSpawn();
    let statusDuringTerminate: string | undefined;
    mockTerminate.mockImplementation(async () => {
      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      statusDuringTerminate = row.status;
    });

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(true);
    expect(statusDuringTerminate).toBe("killed");
  });

  // Issue #988 — the CAS marking the session "killed" before terminate can
  // itself lose a race (a concurrent kill, or the session genuinely exited
  // on its own between the read above and this write). Nothing left to
  // terminate and no live session left to spawn a second agent alongside,
  // so this must bail out cleanly rather than proceed.
  it("with force: true — bails out cleanly when the pre-terminate CAS loses a race", async () => {
    const { task, sessionId } = insertTaskWithSession("active");
    const updateSpy = vi.spyOn(app.db, "update").mockReturnValueOnce({
      set: () => ({
        where: () => ({
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        }),
      }),
    } as never);
    const warnSpy = vi.spyOn(app.log, "warn");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(false);
    expect(mockTerminate).not.toHaveBeenCalled();
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, sessionId }),
      expect.stringContaining("lost a race marking"),
    );
    updateSpy.mockRestore();
  });

  it("with force: true — does NOT spawn a second agent when terminate itself fails", async () => {
    mockTerminate.mockRejectedValue(new Error("host unreachable"));
    const { task, sessionId } = insertTaskWithSession("active");
    const warnSpy = vi.spyOn(app.log, "warn");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test review-feedback",
      { force: true },
    );

    expect(result).toBe(false);
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      expect.stringContaining("failed to terminate"),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
    // #772 — a FAILED terminate must NOT flip the row to "killed" — that
    // would misrepresent a session we couldn't actually confirm is dead
    // (and this function's own contract is to leave it as-is for a later
    // pass to retry, not silently declare it gone).
    const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    expect(sessionRow.status).toBe("active");
    expect(mockCloseSessionBrowserBindings).not.toHaveBeenCalled();
  });

  it("logs and does not update the task row when the spawn itself fails", async () => {
    mockCreateSessionRecord.mockResolvedValue({ ok: false, reason: "spawn-failed" });
    const { task } = insertTaskWithSession("exited");
    const warnSpy = vi.spyOn(app.log, "warn");

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      expect.stringContaining("re-seed spawn failed"),
    );
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
  });

  it("adopts the kept session on an unknown spawn outcome and does not re-seed again while it is alive (#2637)", async () => {
    const { task } = insertTaskWithSession("exited");
    const kept = insertSessionRow("active");
    mockCreateSessionRecord.mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      sessionId: kept.id,
    });

    const result = await reseedTaskIfSessionExited(app, task, project, "prompt", "test reject");

    expect(result).toBe(true);
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(kept.id);
    expect(updated.seedDelivered).toBe(false);

    // The next tick sees a live session bound to the task: no second spawn.
    mockCreateSessionRecord.mockClear();
    const again = await reseedTaskIfSessionExited(app, updated, project, "prompt", "test reject");
    expect(again).toBe(false);
    expect(mockCreateSessionRecord).not.toHaveBeenCalled();
  });

  describe("re-checking an adopted re-seed session (#2637)", () => {
    const SEED = "Reviewer feedback: please fix the flaky test\nmore detail";

    async function adopt(opts: { agentCommand?: string; hostId?: string; seed?: string } = {}) {
      const { agentCommand = "claude", hostId = "local", seed = SEED } = opts;
      const { task: inserted, sessionId } = insertTaskWithSession("exited");
      app.db.update(tasks).set({ agentCommand }).where(eq(tasks.id, inserted.id)).run();
      // The worker's host is the host of the session it was on (#1722): that is
      // what decides whether this build is the one that attached the argv.
      app.db.update(sessions).set({ hostId }).where(eq(sessions.id, sessionId)).run();
      const task = { ...inserted, agentCommand };
      const kept = insertSessionRow("active");
      mockCreateSessionRecord.mockResolvedValue({
        ok: false,
        reason: "outcome-unknown",
        sessionId: kept.id,
      });
      await reseedTaskIfSessionExited(app, task, project, seed, "test reject");
      mockCreateSessionRecord.mockClear();
      return { task, kept };
    }
    const seedOf = (id: number) =>
      app.db.select().from(tasks).where(eq(tasks.id, id)).all()[0].seedDelivered;
    const later = () => Date.now() + ADOPTED_SEED_GRACE_MS + 1000;

    it("types the seed into the adopted session once, never spawning a second one", async () => {
      const { task } = await adopt();
      // The transcript answered and holds no such user turn: positive evidence
      // the seed never arrived (the screen alone is not).
      mockTranscript.mockResolvedValue(transcriptOf({ role: "user", text: "something else" }));

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(mockPrompt).toHaveBeenCalledWith(expect.any(String), { text: SEED, submit: true });
      expect(mockCreateSessionRecord).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);

      await recheckAdoptedSeeds(app, later());
      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it("does not type over an agent that already has its seed", async () => {
      const { task } = await adopt();
      mockRenderedScrollback.mockResolvedValue("> Reviewer  feedback: please fix\nthe flaky test");

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);
    });

    it("recognises a seed the TUI wrapped, indented and put a border through", async () => {
      const { task } = await adopt();
      mockRenderedScrollback.mockResolvedValue(
        "│ > Reviewer feed │\n│ back: please fix  │\n│ the flaky test   │\n",
      );

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);
    });

    const transcriptOf = (...entries: Array<{ role: string; text: string }>) => ({
      ok: true,
      entries: entries.map((e, seq) => ({ seq, ts: null, ...e })),
      nextSeq: entries.length,
      more: false,
      file: "f",
    });

    it("types the seed once when neither the screen nor the transcript shows it", async () => {
      const { task } = await adopt();
      mockRenderedScrollback.mockResolvedValue("some unrelated later output\n> ");
      mockTranscript.mockResolvedValue(
        transcriptOf({ role: "user", text: "an unrelated first message" }),
      );

      await recheckAdoptedSeeds(app, later());
      await recheckAdoptedSeeds(app, later());

      expect(mockTranscript).toHaveBeenCalledTimes(1);
      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(seedOf(task.id)).toBe(true);
    });

    it("does not type the seed a second time when it scrolled off or was collapsed to a paste placeholder but the transcript has it (#2703)", async () => {
      const { task } = await adopt();
      mockRenderedScrollback.mockResolvedValue("[Pasted text #1 +2 lines]\n> ");
      mockTranscript.mockResolvedValue(
        transcriptOf(
          { role: "assistant", text: "Reviewer feedback: not a user turn, ignored" },
          { role: "user", text: SEED },
        ),
      );

      await recheckAdoptedSeeds(app, later());
      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);
    });

    it("only counts the user's own turns in the transcript, not the assistant quoting the seed", async () => {
      await adopt();
      mockRenderedScrollback.mockResolvedValue("unrelated\n> ");
      mockTranscript.mockResolvedValue(transcriptOf({ role: "assistant", text: SEED }));

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    // A seed-capable agent got the seed on argv from the very request that
    // spawned it, so a screen that does not show it (a paste placeholder, a line
    // that scrolled off) with a transcript that cannot answer is not evidence it
    // is missing: typing it again would make the worker do the task twice.
    it.each([
      ["a transcript the agent does not keep (404)", () => undefined],
      [
        "a transcript call that fails",
        () => mockTranscript.mockRejectedValue(new Error("host went away")),
      ],
    ])("does not retype a seed-capable agent's seed with %s", async (_name, arrange) => {
      const { task } = await adopt();
      mockRenderedScrollback.mockResolvedValue("[Pasted text #1 +2 lines]\n> ");
      arrange();

      await recheckAdoptedSeeds(app, later());
      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);
    });

    it("still falls back to the screen's verdict for an agent whose spawn carried no seed", async () => {
      // Not seed-capable: the argv carried nothing, so a screen without the seed
      // does mean it has to be typed.
      await adopt({ agentCommand: "bash" });
      mockRenderedScrollback.mockResolvedValue("unrelated\n> ");
      mockTranscript.mockRejectedValue(new Error("host went away"));

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    // On a remote host the spawn can strip `initialPrompt` silently (an agent
    // build too old for it, #538), and with the outcome unknown there is no
    // `initialPromptApplied` to tell. A 404/501 transcript is that same old
    // build, so "cannot say" there is not reassurance: the seed is typed.
    it.each([
      ["a transcript the agent does not keep (404)", () => undefined],
      [
        "a transcript call that fails",
        () => mockTranscript.mockRejectedValue(new Error("host went away")),
      ],
    ])(
      "types a remote worker's seed when nothing can say it arrived (%s)",
      async (_name, arrange) => {
        const { task } = await adopt({ hostId: "remote-mac" });
        mockRenderedScrollback.mockResolvedValue("[Pasted text #1 +2 lines]\n> ");
        arrange();

        await recheckAdoptedSeeds(app, later());

        expect(mockPrompt).toHaveBeenCalledTimes(1);
        expect(seedOf(task.id)).toBe(true);
      },
    );

    // The warn that records a typed seed is the diagnostic for this whole
    // scenario, so it must say WHY it typed: absence shown, or only that delivery
    // could not be confirmed.
    it.each([
      ["absence shown", "claude", "local", /had no seed — typed it/],
      ["delivery not certain", "claude", "remote-mac", /could not confirm the seed reached/],
    ])("logs why the seed was typed: %s", async (_name, agentCommand, hostId, message) => {
      const warn = vi.spyOn(app.log, "warn");
      await adopt({ agentCommand, hostId });
      mockRenderedScrollback.mockResolvedValue("> ");
      // Absent for the local worker (the transcript answered); unanswerable for
      // the remote one.
      mockTranscript.mockResolvedValue(
        hostId === "local"
          ? transcriptOf({ role: "user", text: "something else" })
          : { ok: false, status: 404, error: "no transcript" },
      );

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map((c) => String(c[1]))).toEqual(
        expect.arrayContaining([expect.stringMatching(message)]),
      );
      warn.mockRestore();
    });

    it("does not call an unmeasurable seed absent: a terse re-seed prompt is cannot-say", async () => {
      // "PR fails CI" has no fragment long enough to look for, so neither the
      // screen nor the transcript can ever show it.
      const { task } = await adopt({ seed: "PR fails CI" });
      mockRenderedScrollback.mockResolvedValue("> ");
      mockTranscript.mockResolvedValue(transcriptOf({ role: "user", text: "something else" }));

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(true);
    });

    it("types a terse seed where delivery was not certain", async () => {
      await adopt({ hostId: "remote-mac", seed: "PR fails CI" });
      mockRenderedScrollback.mockResolvedValue("> ");
      mockTranscript.mockResolvedValue(transcriptOf({ role: "user", text: "something else" }));

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it("types the seed when a seed-capable agent's transcript answers with an empty conversation", async () => {
      await adopt();
      mockRenderedScrollback.mockResolvedValue("> ");
      mockTranscript.mockResolvedValue(transcriptOf());

      await recheckAdoptedSeeds(app, later());

      expect(mockPrompt).toHaveBeenCalledTimes(1);
    });

    it("waits out the boot grace window", async () => {
      const { task } = await adopt();

      await recheckAdoptedSeeds(app, Date.now() + 1000);

      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(false);
    });

    it("leaves an unreachable host for the next tick and drops a gone session", async () => {
      const { task, kept } = await adopt();
      mockLiveStatus.mockRejectedValueOnce(new Error("down"));
      await recheckAdoptedSeeds(app, later());
      expect(mockPrompt).not.toHaveBeenCalled();
      expect(seedOf(task.id)).toBe(false);

      app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, kept.id)).run();
      await recheckAdoptedSeeds(app, later());
      await recheckAdoptedSeeds(app, later());
      expect(mockPrompt).not.toHaveBeenCalled();
    });
  });

  // Hermes review, PR #580 — the final sessionId write had no status guard;
  // force:true's new caller (task-reconciler.ts's review-feedback
  // auto-return) makes the window between its own CAS (reviewing ->
  // in_progress) and this write reachable by a concurrent transition in a
  // way reject's own path never was.
  it("does not clobber sessionId, and returns false, when a concurrent transition moves the task off 'in_progress' before the final write", async () => {
    const { task } = insertTaskWithSession("exited");
    const spawnedId = mockSuccessfulSpawn();
    // Simulates a concurrent approve/reject/give-up landing between
    // createSessionRecord resolving and this function's own final CAS'd
    // write — the row itself has already moved off "in_progress".
    app.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id)).run();

    const result = await reseedTaskIfSessionExited(
      app,
      task,
      project,
      "prompt text",
      "test reject",
    );

    expect(result).toBe(false);
    const [updated] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
    expect(updated.sessionId).toBe(task.sessionId);
    expect(updated.status).toBe("done");
    // Nothing points at the freshly spawned session, so it is ended rather than
    // left live and promptable (#2804).
    const [spawned] = app.db.select().from(sessions).where(eq(sessions.id, spawnedId)).all();
    expect(spawned.status).toBe("killed");
  });

  describe("readLiveWorkerState", () => {
    it("is quiet for an idle live worker, and names the host that owns it", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      expect(await readLiveWorkerState(app, taskRow)).toMatchObject({ kind: "quiet" });
    });

    it("is blocked while the worker waits on a dialog", async () => {
      const { task: taskRow, sessionId } = insertTaskWithSession("active");
      mockLiveStatus.mockResolvedValue({ [String(sessionId)]: { permissionState: "pending" } });
      expect(await readLiveWorkerState(app, taskRow)).toEqual({
        kind: "blocked",
        status: "awaiting_permission",
      });
    });

    it("can still be typed into while busy: a stale background job never settles", async () => {
      const { task: taskRow, sessionId } = insertTaskWithSession("active");
      mockLiveStatus.mockResolvedValue({ [String(sessionId)]: { activity: "working" } });
      expect(await readLiveWorkerState(app, taskRow)).toMatchObject({ kind: "quiet" });
    });

    it("is none for no session, and for one that has exited", async () => {
      expect(await readLiveWorkerState(app, { sessionId: null })).toEqual({ kind: "none" });
      const { task: exited } = insertTaskWithSession("exited");
      expect(await readLiveWorkerState(app, exited)).toEqual({ kind: "none" });
    });

    it("is unreachable when the host cannot be read", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      mockLiveStatus.mockRejectedValue(new Error("connect ETIMEDOUT"));
      expect(await readLiveWorkerState(app, taskRow)).toEqual({ kind: "unreachable" });
    });
  });

  describe("promptLiveTaskWorker", () => {
    it("types the prompt into an idle live worker and submits it", async () => {
      const { task: taskRow, sessionId } = insertTaskWithSession("active");
      const ok = await promptLiveTaskWorker(app, taskRow, "please fix X", "test");
      expect(ok).toBe("typed");
      expect(mockPrompt).toHaveBeenCalledWith(String(sessionId), {
        text: "please fix X",
        submit: true,
      });
      expect(mockTerminate).not.toHaveBeenCalled();
    });

    it("does not type into a worker that is blocked on a permission dialog", async () => {
      const { task: taskRow, sessionId } = insertTaskWithSession("active");
      mockLiveStatus.mockResolvedValue({ [String(sessionId)]: { permissionState: "pending" } });
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("declined");
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("types into a busy worker, and reuses a state the caller already read", async () => {
      const { task: taskRow, sessionId } = insertTaskWithSession("active");
      mockLiveStatus.mockResolvedValue({ [String(sessionId)]: { activity: "working" } });
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("typed");
      mockLiveStatus.mockClear();
      const known = { kind: "quiet", hostId: "local" } as const;
      expect(await promptLiveTaskWorker(app, taskRow, "y", "test", known)).toBe("typed");
      // No second read of the session: the caller's own was used.
      expect(mockLiveStatus).not.toHaveBeenCalled();
    });

    it("returns false when the session has already exited", async () => {
      const { task: taskRow } = insertTaskWithSession("exited");
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("declined");
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("returns false when the task has no session", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      expect(await promptLiveTaskWorker(app, { ...taskRow, sessionId: null }, "x", "test")).toBe(
        "declined",
      );
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("returns false when the agent refuses the prompt", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      mockPrompt.mockResolvedValue({ ok: false, status: 501, error: "not supported" });
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("declined");
    });

    it("reports an unreachable host, and types nothing, rather than treating it as a refusal", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      mockLiveStatus.mockRejectedValue(new Error("connect ETIMEDOUT"));
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("unreachable");
      expect(mockPrompt).not.toHaveBeenCalled();
    });

    it("declines, rather than throwing, when the prompt itself throws", async () => {
      const { task: taskRow } = insertTaskWithSession("active");
      mockPrompt.mockRejectedValue(new Error("host unreachable"));
      expect(await promptLiveTaskWorker(app, taskRow, "x", "test")).toBe("declined");
    });
  });
});
