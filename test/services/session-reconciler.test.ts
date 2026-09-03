import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { EventEmitter } from "node:events";

// Session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked the same way as test/routes/sessions.test.ts, since
// this test drives real create/list through the actual app + DB rather
// than hand-faking drizzle's query builder.
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
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const mockSyncTaskTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: mockSyncTaskTransition,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { reconcileExitedSessions } = await import("../../src/services/session-reconciler.js");

const tmpDb = path.join(os.tmpdir(), `session-reconciler-test-${process.pid}.db`);

describe("reconcileExitedSessions", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSyncTaskTransition.mockClear();
  });

  // Perf audit finding B8(2) — LocalSessionBackend.isMasterAlive(ids) now
  // calls app.pty.isMasterAliveBatch(ids) (a single `systemctl --user
  // list-units` call for the whole batch) instead of Promise.all-ing
  // app.pty.isMasterAlive(id) once per id. Every test below used to stub
  // the old per-id method uniformly (every id "alive" or every id "not
  // alive") — this stubs the batch method the same uniform way, answering
  // every id in whatever batch it's called with identically.
  function mockMasterAlive(app: Awaited<ReturnType<typeof buildApp>>, alive: boolean) {
    return vi.spyOn(app.pty, "isMasterAliveBatch").mockImplementation(async (ids: string[]) => {
      const result: Record<string, boolean> = Object.create(null);
      for (const id of ids) result[id] = alive;
      return result;
    });
  }

  async function createSession(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    return created.json().id as number;
  }

  // Runs first, deliberately, while the shared test-file DB still has zero
  // rows — later tests create sessions whose active/exited state would
  // otherwise make "no active sessions at all" untrue by the time this ran.
  it("is a no-op when there are no active sessions", async () => {
    const app = await buildApp();
    const isMasterAliveSpy = mockMasterAlive(app, true);

    await expect(reconcileExitedSessions(app)).resolves.toBeUndefined();
    expect(isMasterAliveSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("leaves an active session alone when its scope is still alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    mockMasterAlive(app, true);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("active");

    await app.close();
  });

  // Perf audit finding B8(2), trust-rule regression — isMasterAliveBatch
  // resolves an EMPTY record (not all-false) on a systemctl spawn/parse
  // failure (see its own doc comment in pty-manager.ts). This pins that a
  // local session's row is left alone in that case — the reconciler's
  // `alive === undefined` -> skip branch must treat "the batch call itself
  // failed" exactly like "a reachable host's response omitted this key,"
  // not like "confirmed not alive." Getting this wrong would mass-exit
  // every active local session on a single transient systemctl error.
  it("leaves an active session alone when the batch liveness check itself fails (empty record, not all-false)", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    vi.spyOn(app.pty, "isMasterAliveBatch").mockResolvedValue(Object.create(null));

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("active");

    await app.close();
  });

  it("flips an active session to exited once its scope is no longer alive", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    mockMasterAlive(app, false);

    await reconcileExitedSessions(app);

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("exited");

    await app.close();
  });

  // B9 — once isMasterAlive confirms the process is genuinely gone, any
  // seed stashed for this id (the promote flow) can never be picked up by a
  // SessionStart hook again — discard it rather than leaking it forever.
  // Deliberately NOT covered by plain kill()'s own behavior (see
  // pty-manager.test.ts's own coverage of that): this asserts the
  // reconciler's explicit discardPendingSeed() call, independent of
  // whatever kill() itself does or doesn't clear.
  it("discards a stashed seed once a session is confirmed exited (B9)", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    app.pty.stashSeed(String(sessionId), "some initial prompt");
    mockMasterAlive(app, false);

    await reconcileExitedSessions(app);

    expect(app.pty.consumeSeed(String(sessionId))).toBeNull();

    await app.close();
  });

  // A9 — kill/attach TOCTOU: the row must read non-"active" BEFORE this
  // function awaits cleanupPreviewWorktree, not only after it resolves.
  // Before the fix, a `/ws/terminal` upgrade landing in that window would
  // still see "active" (preValidation/attach re-check both just read that
  // column) and spawn a brand-new systemd-run scope for a program this
  // function had already confirmed (via isMasterAlive) was dead — orphaning
  // it the moment this function then flips the row underneath it.
  it("flips the row to exited BEFORE cleanupPreviewWorktree resolves, not after (A9)", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    mockMasterAlive(app, false);

    const gitWorktreeModule = await import("../../src/services/git-worktree.js");
    let resolveCleanup!: (value: boolean) => void;
    const cleanupPromise = new Promise<boolean>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanupSpy = vi
      .spyOn(gitWorktreeModule, "cleanupPreviewWorktree")
      .mockReturnValue(cleanupPromise);

    const { sessions } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");

    const reconcilePromise = reconcileExitedSessions(app);

    // Poll for the flip rather than assuming a fixed number of microtask
    // ticks — isMasterAlive resolves through a couple of its own layers
    // (LocalBackend.isMasterAlive -> app.pty.isMasterAliveBatch) before the
    // reconciler reaches the DB write, and hard-coding that depth would be
    // an implementation detail this test shouldn't need to know.
    let row: { status: string } | undefined;
    for (let i = 0; i < 50; i++) {
      [row] = app.db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .all();
      if (row?.status === "exited") break;
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The cleanup call is still pending (we haven't resolved it) — proving
    // this observation genuinely happened DURING the await, not after.
    expect(cleanupSpy).toHaveBeenCalled();
    expect(row?.status).toBe("exited");

    resolveCleanup(true);
    await reconcilePromise;
    cleanupSpy.mockRestore();

    await app.close();
  });

  it("closes a bound project browser once its session flips to exited (#182)", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    const { sessions } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    const { recordSessionBrowserBinding } = await import("../../src/services/session-browsers.js");
    recordSessionBrowserBinding(app, sessionId, row.projectId);
    const closeForProjectSpy = vi
      .spyOn(app.browser, "closeForProject")
      .mockResolvedValue(undefined);
    mockMasterAlive(app, false);

    await reconcileExitedSessions(app);

    expect(closeForProjectSpy).toHaveBeenCalledWith(row.projectId);

    await app.close();
  });

  describe("Task Master (6.2/#215, issue #282)", () => {
    async function createTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      sessionId: number,
      status: "claimed" | "in_progress" | "reviewing",
      issueNumber: number | null = null,
    ) {
      const { tasks } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, title: "t", status, sessionId, issueNumber, claimedAt: new Date() })
        .returning()
        .all();
      return row.id;
    }

    async function getProjectId(app: Awaited<ReturnType<typeof buildApp>>, sessionId: number) {
      const { sessions } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      return row.projectId;
    }

    it("flips a claimed task to failed when its session exits before completion", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      mockMasterAlive(app, false);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (
        res.json() as { id: number; status: string; failureReason: string | null }[]
      ).find((t) => t.id === taskId);
      expect(row?.status).toBe("failed");
      expect(row?.failureReason).toContain("session exited");

      await app.close();
    });

    // Issue #973's incident, #988's fix — a scope Mullion itself asked
    // systemd to stop (e.g. task-reseed.ts's force re-seed, terminating a
    // still-active session before spawning a fresh one) sits in
    // "deactivating" for up to systemd's own DefaultTimeoutStopSec before
    // settling. isMasterAliveBatch() now folds that into "alive" (see
    // session-process.test.ts for the unit-level coverage of the actual
    // systemctl `--state` widening); this pins the consequence one layer up
    // — the reconciler must not race that window and flip the task to
    // failed / delete the worktree out from under an in-flight re-seed.
    it("does not fail a claimed task or touch its worktree while its scope is deactivating (issue #973/#988)", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      const { tasks } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-988" })
        .where(eq(tasks.id, taskId))
        .run();
      // Mimics what isMasterAliveBatch() itself now reports for a
      // deactivating scope — "alive" — rather than re-deriving the
      // systemctl state string here.
      mockMasterAlive(app, true);

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn();
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (res.json() as { id: number; status: string }[]).find((t) => t.id === taskId);
      expect(row?.status).toBe("claimed");
      expect(removeWorktreeIfCleanMock).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      // Unlike every other test in this describe block, this one
      // deliberately leaves the session "active" and the task "claimed" —
      // that's the whole point. reconcileExitedSessions() scans the shared
      // on-disk test DB for ALL "active" sessions, not just ones the current
      // test created, so left as-is this row would still be a live
      // candidate for a LATER test's own reconcile pass (with THAT test's
      // own, different liveness mock) and get caught by it, corrupting that
      // test's assertions. Every other test here naturally clears its own
      // candidacy by failing/completing the row; this one has to do it
      // explicitly.
      const { sessions } = await import("../../src/db/schema.js");
      app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
      await app.close();
    });

    // Issue #988's residual gap, on top of #973/#1001 above — even with the
    // deactivating-as-alive widening, this sweep's own SELECT (top of
    // reconcileExitedSessions) can cache an "active" snapshot a moment
    // before some other writer (task-reseed.ts's force re-seed CAS'ing the
    // same session to "killed" before it awaits its own terminate()) wins
    // the race. If that other writer's target process responds to SIGTERM
    // fast enough, THIS pass's own isMasterAlive check can legitimately
    // report "not alive" against the now-stale snapshot. Simulated here by
    // having the liveness mock itself flip the row to "killed" as a side
    // effect before resolving `false` — reproducing "another writer already
    // moved this row off 'active' while the liveness check was in flight."
    // The reconciler must lose its own CAS on that write and back off
    // entirely, not clobber "killed" back to "exited" and race ahead to
    // fail the task / delete the worktree out from under the in-flight
    // re-seed (task 258971's incident, PR #136).
    it("backs off the task-failure/worktree-removal block when another writer wins the race to flip the session first (issue #988)", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "in_progress");
      const { tasks, sessions } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-988-residual" })
        .where(eq(tasks.id, taskId))
        .run();

      vi.spyOn(app.pty, "isMasterAliveBatch").mockImplementation(async (ids: string[]) => {
        // Mimics task-reseed.ts's own kill-CAS landing while this exact
        // liveness check is in flight — after this pass's SELECT already
        // read the row as "active", before this pass's own flip-to-exited
        // write runs.
        app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, sessionId)).run();
        const result: Record<string, boolean> = Object.create(null);
        for (const id of ids) result[id] = false;
        return result;
      });

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      // mockResolvedValue, not a bare vi.fn() — matches removeWorktreeIfClean's
      // real Promise<RemoveIfCleanResult> return shape (see the "cleans up
      // the worktree..." test above), so a regression that lets this get
      // called fails on the intended `not.toHaveBeenCalled()` assertion
      // below rather than an unrelated TypeError from session-reconciler.ts
      // awaiting `undefined`.
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      await reconcileExitedSessions(app);

      const [sessionRow] = app.db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .all();
      expect(sessionRow?.status).toBe("killed");

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (res.json() as { id: number; status: string }[]).find((t) => t.id === taskId);
      expect(row?.status).toBe("in_progress");
      expect(removeWorktreeIfCleanMock).not.toHaveBeenCalled();
      expect(mockSyncTaskTransition).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("syncs the failed transition to GitHub for a linked task, with the freshly-updated row and its project", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed", 77);
      mockMasterAlive(app, false);

      await reconcileExitedSessions(app);

      expect(mockSyncTaskTransition).toHaveBeenCalledTimes(1);
      const [, syncedTask, syncedProject, syncedEvent] = mockSyncTaskTransition.mock.calls[0];
      expect(syncedEvent).toBe("failed");
      expect(syncedTask).toMatchObject({ id: taskId, issueNumber: 77, status: "failed" });
      expect(syncedTask.failureReason).toContain("session exited");
      expect(syncedProject).toMatchObject({ id: projectId });

      await app.close();
    });

    it("cleans up the worktree once a claimed task's session-death flips it to failed (6.8/#283), only when one was recorded", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      const { tasks } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-1" })
        .where(eq(tasks.id, taskId))
        .run();
      mockMasterAlive(app, false);

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const realResolveBackend = sessionBackendModule.resolveBackend;
      const removeWorktreeIfCleanMock = vi.fn().mockResolvedValue({ removed: true });
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockImplementation((appArg, hostId) => {
          const real = realResolveBackend(appArg, hostId);
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (prop === "removeWorktreeIfClean") return removeWorktreeIfCleanMock;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });

      await reconcileExitedSessions(app);

      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/.mullion-worktrees/mullion-task-1",
        "/tmp",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("still calls syncTaskTransition for a local task (no issueNumber) — the local/GitHub-linked distinction is syncTaskTransition's own job, not duplicated here", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      mockMasterAlive(app, false);

      await reconcileExitedSessions(app);

      expect(mockSyncTaskTransition).toHaveBeenCalledTimes(1);
      const [, syncedTask] = mockSyncTaskTransition.mock.calls[0];
      expect(syncedTask).toMatchObject({ id: taskId, issueNumber: null });

      await app.close();
    });

    it("flips an in_progress task to failed the same way", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "in_progress");
      mockMasterAlive(app, false);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (res.json() as { id: number; status: string }[]).find((t) => t.id === taskId);
      expect(row?.status).toBe("failed");

      await app.close();
    });

    // A9 — the session/task flips used to be gated on `cleanupPreviewWorktree`
    // succeeding (PR #341), specifically because a failed cleanup left the
    // session row "active" for a future reconcile pass to retry, and the
    // task transition was kept in lockstep with that same retry. Now that
    // the session row always flips to "exited" up front (closing A9's
    // reattach race), there IS no future retry pass over this row —
    // `cleanupPreviewWorktree`'s own `pendingRemoval` + sync tick (see
    // git-worktree.ts) is what retries the directory removal instead. If
    // the task transition were still gated on `cleaned`, a session whose
    // worktree happened to fail removal would leave its task stuck at
    // "claimed"/"in_progress" forever, since nothing would ever revisit it
    // again. This is the regression guard for that.
    it("still flips the task to failed even when cleanupPreviewWorktree fails (A9 — no longer gated on cleanup success)", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      mockMasterAlive(app, false);

      const gitWorktreeModule = await import("../../src/services/git-worktree.js");
      const cleanupSpy = vi
        .spyOn(gitWorktreeModule, "cleanupPreviewWorktree")
        .mockResolvedValue(false);

      await reconcileExitedSessions(app);

      const sessionRes = await app.inject({ method: "GET", url: "/api/sessions" });
      const sessionRow = (sessionRes.json() as Array<{ id: number; status: string }>).find(
        (s) => s.id === sessionId,
      );
      expect(sessionRow?.status).toBe("exited");

      const taskRes = await app.inject({ method: "GET", url: "/api/tasks" });
      const taskRow = (taskRes.json() as { id: number; status: string }[]).find(
        (t) => t.id === taskId,
      );
      expect(taskRow?.status).toBe("failed");

      cleanupSpy.mockRestore();
      await app.close();
    });

    it("does not fail a reviewing task whose session exits — the turn is already over", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "reviewing");
      mockMasterAlive(app, false);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (res.json() as { id: number; status: string }[]).find((t) => t.id === taskId);
      expect(row?.status).toBe("reviewing");

      await app.close();
    });

    it("does not fail the task when the session is still alive", async () => {
      const app = await buildApp();
      const sessionId = await createSession(app);
      const projectId = await getProjectId(app, sessionId);
      const taskId = await createTask(app, projectId, sessionId, "claimed");
      mockMasterAlive(app, true);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/tasks" });
      const row = (res.json() as { id: number; status: string }[]).find((t) => t.id === taskId);
      expect(row?.status).toBe("claimed");

      await app.close();
    });
  });

  it("does not touch an already-killed session", async () => {
    const app = await buildApp();
    const sessionId = await createSession(app);
    await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

    const isMasterAliveSpy = mockMasterAlive(app, false);
    await reconcileExitedSessions(app);

    // The row was already "killed" (not "active"), so it's outside the
    // query the reconciler selects — this file's shared on-disk DB can
    // still have OTHER leftover "active" sessions from earlier tests
    // (no per-test cleanup here), so the batch call itself may still
    // happen for those — this only asserts THIS session's id was never
    // included in any batch it was asked about.
    for (const call of isMasterAliveSpy.mock.calls) {
      expect(call[0]).not.toContain(String(sessionId));
    }

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const row = (res.json() as Array<{ id: number; status: string }>).find(
      (s) => s.id === sessionId,
    );
    expect(row?.status).toBe("killed");

    await app.close();
  });

  describe("multi-host (issue #26)", () => {
    it("skips an unreachable remote host's sessions entirely, never flipping them to exited", async () => {
      const app = await buildApp();
      // A local session, alive, alongside a remote one on an unreachable
      // host — the whole point of this test is that the *local* group must
      // still reconcile normally even while the remote group's host is
      // down (grouped-by-host, one failure doesn't abort the other group).
      const localSessionId = await createSession(app);
      mockMasterAlive(app, true);

      const badHost = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "goes-down", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remoteProject = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-p", cwd: "/x", hostId: badHost.json().id },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [remoteRow] = app.db
        .insert(sessions)
        .values({ projectId: remoteProject.json().id, command: "bash" })
        .returning()
        .all();

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = res.json() as Array<{ id: number; status: string }>;
      // Local session still reconciles (still active — its scope reports
      // alive above), and the remote one is left untouched at "active"
      // rather than being wrongly flipped to "exited" for a host that's
      // merely unreachable right now.
      expect(rows.find((s) => s.id === localSessionId)?.status).toBe("active");
      expect(rows.find((s) => s.id === remoteRow.id)?.status).toBe("active");

      await app.close();
    });

    it("does not exit a session a reachable host's liveness response omits (Hermes review, PR #34)", async () => {
      const app = await buildApp();
      // Earlier tests in this describe block leave "active" LOCAL sessions
      // behind in this file's shared on-disk DB (no per-test cleanup) —
      // reconcileExitedSessions groups those into a "local" host group too,
      // and this file's child_process mock only ever emits "exit" (never
      // "close"), which real isMasterAlive() waits on — so any test that
      // doesn't stub it hangs forever on that leftover group. Every other
      // test here either stubs this or never leaves an active local
      // session; this one only cares about the remote group below.
      mockMasterAlive(app, true);
      let omittedId: string | null = null;

      const server = http.createServer((req, res) => {
        if (req.url !== "/internal/sessions/liveness") {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const { ids } = JSON.parse(body) as { ids: string[] };
          // Simulate agent version skew / a partial response: every
          // requested id gets an answer EXCEPT `omittedId`. Built via
          // Map/fromEntries rather than a keyed assignment onto a plain
          // object (CodeQL: remote property injection on a request-derived
          // key — this is a test-only fake server with no real attack
          // surface, but the safer shape is just as easy to write).
          const entries = ids.filter((id) => id !== omittedId).map((id) => [id, true] as const);
          const payload = JSON.stringify(Object.fromEntries(entries));
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          res.end(payload);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "partial-liveness",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "t",
        },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p", cwd: "/x", hostId: host.json().id },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [omitted] = app.db
        .insert(sessions)
        .values({ projectId: project.json().id, command: "bash" })
        .returning()
        .all();
      const [included] = app.db
        .insert(sessions)
        .values({ projectId: project.json().id, command: "bash" })
        .returning()
        .all();
      omittedId = String(omitted.id);

      await reconcileExitedSessions(app);

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = res.json() as Array<{ id: number; status: string }>;
      // Omitted key -> "unknown," must be skipped, never treated as "not
      // alive" -> exited (the exact landmine this fix closes).
      expect(rows.find((s) => s.id === omitted.id)?.status).toBe("active");
      expect(rows.find((s) => s.id === included.id)?.status).toBe("active");

      // server.close()'s callback otherwise hangs until every keep-alive
      // connection closes on its own — fetch()'s undici client holds one
      // open well past this test's assertions.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });

    it("logs a HostRequestError distinctly from unreachable, without exiting the session (Hermes review, PR #34)", async () => {
      const app = await buildApp();
      mockMasterAlive(app, true);

      // A reachable agent whose bulk liveness endpoint has a persistent
      // bug (always 400s) is a fundamentally different situation from a
      // network blip — it'll recur every cycle rather than resolve on its
      // own — so the warn log should say so distinctly.
      const server = http.createServer((req, res) => {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound port");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "buggy-liveness",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: "t",
        },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p", cwd: "/x", hostId: host.json().id },
      });
      const { sessions } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(sessions)
        .values({ projectId: project.json().id, command: "bash" })
        .returning()
        .all();

      const warnSpy = vi.spyOn(app.log, "warn");
      await reconcileExitedSessions(app);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("rejected the liveness request"),
      );

      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = res.json() as Array<{ id: number; status: string }>;
      expect(rows.find((s) => s.id === row.id)?.status).toBe("active");

      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    });
  });
});
