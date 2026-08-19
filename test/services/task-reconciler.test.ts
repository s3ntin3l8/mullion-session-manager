import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn as childProcessSpawn } from "node:child_process";
import type * as TaskReseedModule from "../../src/services/task-reseed.js";

// Same fakes as session-reconciler.test.ts / test/routes/sessions.test.ts —
// session creation still spawns real OS processes (systemd-run, dtach) via
// PtyManager, faked so this file exercises reconcileTasks against a real
// app + DB without needing a real systemd --user session in CI.
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

// Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring into both
// "-> reviewing" transitions was previously untested: every existing
// reviewing-transition test here ran the REAL openDraftPRForTask, which
// silently no-ops on "no-token"/"remote-not-supported" in this file's test
// DB and never proved the reconciler actually calls it or persists its
// result. Mocked (importOriginal-preserved) so those existing tests keep
// their prior no-op behavior, while new tests below assert the call
// directly.
const mockOpenDraftPRForTask = vi.fn();
vi.mock("../../src/services/task-promote.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    openDraftPRForTask: mockOpenDraftPRForTask,
  };
});

// Hermes review, PR #580 — the review-feedback auto-return's rollback of a
// spent `reviewRounds` when the re-seed fails needs a controllable failure;
// engineering a REAL terminate/spawn failure through this file's full
// integration setup (real createSessionRecord, mocked node-pty/
// child_process that always "succeed") isn't practical. Pass-through by
// default (calls the real implementation, same behavior every other test
// here already relies on) — only overridden with `.mockResolvedValueOnce`
// in the one test that needs to simulate a failed re-seed.
const actualReseedModule = await vi.importActual<typeof TaskReseedModule>(
  "../../src/services/task-reseed.js",
);
const mockReseedTaskIfSessionExited = vi.fn(actualReseedModule.reseedTaskIfSessionExited);
vi.mock("../../src/services/task-reseed.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reseedTaskIfSessionExited: mockReseedTaskIfSessionExited,
  };
});

// #722 — checkReviewingGate (task-reconciler.ts) reads real git status via
// host-git.ts's resolveHostGitStatus, which on the local path shells out to
// `git status` — impossible to exercise for real in this file, since the
// node:child_process mock above replaces every spawn with an
// immediately-exiting fake. Mocked the same importOriginal-preserving way as
// task-promote.js/task-reseed.js above so the new tests below can drive the
// gate directly; every existing test's tasks have no baseSha set, so
// checkReviewingGate's own first fail-open check short-circuits before ever
// calling this mock, leaving their behavior unaffected regardless of its
// default return value.
//
// `vi.hoisted()`, not a plain top-level `const` (matching
// event-store.test.ts/github-pr-poller.test.ts's own precedent, and
// test/helpers/mock-pty.ts's doc comment on exactly this failure mode) —
// the task-reseed.js mock above's `importOriginal()` transitively imports
// session-backend.js -> git-worktree.js during file evaluation, which
// triggers THIS mock's own factory before a plain `const` below it would
// have run yet, throwing "Cannot access before initialization".
const { mockResolveHostGitStatus, mockCommitWipChanges } = vi.hoisted(() => ({
  mockResolveHostGitStatus: vi.fn(),
  mockCommitWipChanges: vi.fn(),
}));
vi.mock("../../src/services/host-git.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHostGitStatus: mockResolveHostGitStatus,
  };
});

// Same reasoning — the #722 "no commits ahead of base" failure path's WIP
// salvage commit also shells out to real git, mocked here so tests can
// assert it was (or wasn't) invoked without needing a real worktree.
vi.mock("../../src/services/git-worktree.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    commitWipChanges: mockCommitWipChanges,
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb, getDb } = await import("../../src/db/client.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { and, eq, isNull } = await import("drizzle-orm");
const { taskReviewFindingsPath } = await import("../../src/services/task-prompt.js");

const tmpDb = path.join(os.tmpdir(), `task-reconciler-test-${process.pid}.db`);

// A minimal, fully-idle SessionInfo — every field defaultDeriveStatusInfo
// would otherwise default, but supplied explicitly so each test only
// overrides the one or two fields it cares about (activity /
// lastTurnEndedAt / outstandingBackgroundTasks), matching the exact
// precedence deriveSessionStatus documents (session-status.ts).
function fakeInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activity: "idle",
    attention: false,
    attentionKind: null,
    permissionState: "idle",
    planState: "idle",
    gateState: "idle",
    promoteState: "idle",
    elicitationState: "idle",
    questionState: "idle",
    errorState: "idle",
    errorDetail: null,
    endedReason: null,
    exitCode: null,
    compactState: "idle",
    subagentCount: 0,
    lastTurnEndedAt: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("reconcileTasks", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    // Reconciler tests exercise already-claimed tasks (inserted directly,
    // bypassing POST .../claim) — Task Master enabled by default here so
    // the review-agent-spawn tests exercise their happy path; the one test
    // that specifically covers Hermes review PR #480's gate overrides this
    // back off via settings.taskMaster.enabled.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_BUDGET_MINUTES;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  beforeEach(() => {
    // Matches the real openDraftPRForTask's actual no-op outcome in this
    // file's test DB (no GitHub token configured) — existing
    // reviewing-transition tests below rely on the draft-PR attempt being a
    // harmless no-op, same as before this was mocked.
    mockOpenDraftPRForTask.mockReset().mockResolvedValue({ ok: false, reason: "no-token" });
    // A "reviewing" task with no PR is exactly what retryStrandedDraftPRs
    // sweeps on every reconcileTasks() call, and plenty of tests in this
    // file legitimately land a task there (the default mock resolves
    // "no-token", so its own draft-PR attempt never sets prNumber) without
    // ever cleaning it up — this file shares one DB across all its tests.
    // Without this, a stray leftover row from an earlier test gets swept
    // (and calls mockOpenDraftPRForTask) on a LATER, unrelated test's very
    // first reconcileTasks() call, corrupting that test's own call-count
    // assertions. Scoped to exactly the rows the sweep itself selects.
    // Wrapped: the very first beforeEach of the whole file runs before any
    // buildApp() call has migrated the (freshly created) tmpDb, so the
    // table doesn't exist yet — nothing to clean up in that case.
    try {
      getDb()
        .delete(tasks)
        .where(and(eq(tasks.status, "reviewing"), isNull(tasks.prNumber)))
        .run();
    } catch {
      // no such table yet — fine, see above.
    }
    // #722 — every existing test's tasks have no baseSha, so
    // checkReviewingGate never actually calls this; reset only so a leaked
    // .mockResolvedValueOnce from one #722 test can't bleed into the next.
    mockResolveHostGitStatus.mockReset();
    mockCommitWipChanges.mockReset().mockResolvedValue({ committed: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createSessionAndTask(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    claimedAt: Date = new Date(),
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "t",
        status,
        sessionId,
        claimedAt,
        startedAt: status === "in_progress" ? claimedAt : null,
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  async function getTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  async function createSessionAndTaskWithReviewAgent(
    app: Awaited<ReturnType<typeof buildApp>>,
    status: "claimed" | "in_progress",
    reviewAgent: string,
  ) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p-review", cwd: "/tmp" },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.json().id}`,
      payload: { defaultReviewAgent: reviewAgent },
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = session.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId: project.json().id,
        title: "reviewed task",
        body: "some spec",
        status,
        sessionId,
        claimedAt: new Date(),
        startedAt: status === "in_progress" ? new Date() : null,
        // maybeSpawnReviewAgent early-returns without a worktreePath — a
        // real claim always sets one; faked here since this test inserts
        // the task row directly rather than going through POST .../claim.
        worktreePath: "/tmp",
      })
      .returning()
      .all();
    return { taskId: row.id, sessionId };
  }

  it("is a no-op when there are no claimed/in_progress tasks", async () => {
    const app = await buildApp();
    const getSpy = vi.spyOn(app.pty, "get");
    await expect(reconcileTasks(app)).resolves.toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("flips claimed -> in_progress once the session shows any non-idle signal", async () => {
    const app = await buildApp();
    const { taskId, sessionId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working" }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    expect(row.startedAt).not.toBeNull();
    void sessionId;
    await app.close();
  });

  it("leaves claimed alone while the session is still idle (no signal yet)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo(),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    expect(row.startedAt).toBeNull();
    await app.close();
  });

  it("flips claimed straight to reviewing when the first observed signal is already finished (task-state.ts's claimed -> reviewing edge)", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    expect(row.startedAt).not.toBeNull();
    expect(row.reviewingAt).not.toBeNull();
    await app.close();
  });

  it("flips in_progress -> reviewing once the session's turn is finished", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("reviewing");
    await app.close();
  });

  it("leaves in_progress alone while the session is still actively working", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ activity: "working" }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("does not finish a task whose Stop hook fired but a background task is still outstanding", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "in_progress");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now(), outstandingBackgroundTasks: ["bg-1"] }),
    } as never);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("in_progress");
    await app.close();
  });

  it("skips a task whose session already exited — that's #282's job, not this pass's", async () => {
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue({
      toInfo: () => fakeInfo({ endedReason: "crashed" }),
    } as never);
    // Flip the underlying session row itself to "exited" (independent of
    // liveness info) so dbStatus feeds "exited" into deriveSessionStatus —
    // the exact case reconcileTasks must not race #282 on.
    const { sessions } = await import("../../src/db/schema.js");
    const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    app.db.update(sessions).set({ status: "exited" }).where(eq(sessions.id, task.sessionId!)).run();

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  it("fails a task once its budget is exceeded and terminates its session", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(row.completedAt).not.toBeNull();
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  // Independent review, PR #480 — proves the settings override actually
  // reaches task-reconciler.ts's deadline computation (task-config.ts's
  // resolver), not just that the pure resolver function returns the right
  // number. The env var stays generous (120) so only the settings override
  // could be responsible for the force-fail here.
  it("fails a task once its budget is exceeded per settings.taskMaster.budgetMinutes, overriding a generous env default", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    const app = await buildApp();
    try {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: 1 } },
      });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId, sessionId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("budget exceeded");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { taskMaster: { budgetMinutes: -1 } },
      });
      await app.close();
    }
  });

  it("cleans up the worktree once budget-failed (6.8/#283), but only when one was recorded", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "1";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      app.db
        .update(tasks)
        .set({ worktreePath: "/tmp/.mullion-worktrees/mullion-task-1" })
        .where(eq(tasks.id, taskId))
        .run();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ activity: "working" }),
      } as never);

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

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(removeWorktreeIfCleanMock).toHaveBeenCalledWith(
        "/tmp/.mullion-worktrees/mullion-task-1",
        "/tmp",
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("never fails a task on budget when MULLION_TASK_BUDGET_MINUTES is 0 (unlimited)", async () => {
    process.env.MULLION_TASK_BUDGET_MINUTES = "0";
    try {
      const app = await buildApp();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { taskId } = await createSessionAndTask(app, "claimed", twoHoursAgo);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo(),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("claimed");

      await app.close();
    } finally {
      process.env.MULLION_TASK_BUDGET_MINUTES = "120";
    }
  });

  it("does not advance an untracked session (app.pty has no live handle for it) past idle defaults", async () => {
    // LocalBackend.liveStatus always sets a key for every requested id —
    // `app.pty.get(id)?.toInfo(...) ?? null` — so an untracked session
    // reads as `null`, not an omitted key; `defaultDeriveStatusInfo(null)`
    // then supplies its own idle defaults, which is what this test
    // actually exercises. (A genuinely *omitted* key is a remote-host-only
    // possibility — reconcileTasks's own `info === undefined` guard exists
    // for that case, mirroring session-reconciler.ts's `alive === undefined`
    // rule, but isn't reachable through a local-only test setup like this
    // one.)
    const app = await buildApp();
    const { taskId } = await createSessionAndTask(app, "claimed");
    vi.spyOn(app.pty, "get").mockReturnValue(undefined);

    await reconcileTasks(app);

    const row = await getTask(app, taskId);
    expect(row.status).toBe("claimed");
    await app.close();
  });

  describe("review agent (this phase's binding design)", () => {
    it("spawns the configured review agent when a task enters reviewing, recording reviewSessionId", async () => {
      const app = await buildApp();
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "claimed",
        "codex",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);

      await app.close();
    });

    it("spawns the review agent even when its adapter can't receive a seed (#487), recording reviewSeedDelivered: false and logging a warning", async () => {
      const app = await buildApp();
      // gemini, not opencode — opencode gained `initialPromptArgs`
      // (`--prompt`) and is seed-capable now, see hook-adapters/opencode.ts.
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "claimed",
        "gemini",
      );
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();
      expect(row.reviewSessionId).not.toBe(workerSessionId);
      // Spawned anyway (advisory, unlike the worker claim's outright
      // refusal) — but the row now records the seed miss instead of it
      // being visible only in server logs.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId }),
        expect.stringContaining("can't receive an initial prompt"),
      );
      // gemini has no adapter at all, so no initial-prompt argv form — the
      // spawned command is untouched, not carrying the review prompt
      // anywhere.
      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("gemini");

      await app.close();
    });

    it("records reviewSeedDelivered: true for a seed-capable review agent, delivering the review prompt as argv (not stashSeed — additionalContext never starts a turn)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const stashSeedSpy = vi.spyOn(app.pty, "stashSeed");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.reviewSeedDelivered).toBe(true);
      expect(stashSeedSpy).not.toHaveBeenCalled();

      const call = vi
        .mocked(childProcessSpawn)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      // shellQuote escapes the apostrophe in "task's" as close-escape-reopen.
      // Asserted in pieces rather than as one contiguous string: the review
      // prompt is now built by task-prompt.ts's buildReviewPrompt, which
      // interposes the worker's-worktree hazard between the advisory
      // framing and the task spec. The exact wording lives in
      // test/services/task-prompt.test.ts; what matters here is that the
      // whole thing reaches the spawned command line as argv.
      const spawnedArg = args[args.length - 1];
      expect(spawnedArg).toContain(
        "'Review this task'\\''s diff. You are not expected to make changes.",
      );
      expect(spawnedArg).toContain("Task: reviewed task\n\nsome spec'");

      await app.close();
    });

    // Independent post-Hermes review, PR #538 — the review agent's spawn
    // shares the exact version-skew risk claimTask/retryTask already cover
    // (test/services/task-claim.test.ts): a remote agent build too old to
    // know about `initialPrompt` silently strips it, so `reviewSeedDelivered`
    // must not be trusted as `true` just because the resolved agent's
    // adapter supports it locally.
    it("does not trust reviewSeedDelivered:true for a remote host that never confirms the review prompt was applied (version skew)", async () => {
      const app = await buildApp();
      const warnSpy = vi.spyOn(app.log, "warn");

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-review-skew", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultReviewAgent: "codex" },
      });
      // Real (FK-valid) rows, inserted directly rather than through
      // POST /api/sessions/claim — no spawn happens during this setup, so
      // resolveBackend can be mocked afterward with no ordering hazard.
      const { sessions } = await import("../../src/db/schema.js");
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "reviewed task",
          body: "some spec",
          status: "claimed",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          worktreePath: "/remote/project",
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        // Keyed by the real worker session id — task-reconciler.ts treats
        // an omitted key as "unknown, skip" (defaultDeriveStatusInfo never
        // runs), same posture as an untracked local session; `fakeInfo`'s
        // shape matches what app.pty.get(id).toInfo() returns elsewhere in
        // this file, and this is liveStatus's own remote-host equivalent.
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      // codex is seed-capable — a naive reviewSeedDelivered:seedCapable
      // would have reported true here despite the remote host never
      // confirming it applied the prompt.
      expect(row.reviewSeedDelivered).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId, seedCapable: true }),
        expect.stringContaining("possible version skew"),
      );

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("does not spawn a review agent when none is configured", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("logs and swallows a review agent spawn failure without affecting the reviewing transition", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      const sessionsModule = await import("../../src/services/session-lifecycle.js");
      vi.spyOn(sessionsModule, "createSessionRecord").mockResolvedValueOnce({
        ok: false,
        reason: "spawn-failed",
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).toBeNull();

      await app.close();
    });

    it("does not transition a finished task into reviewing (or spawn a review agent) while Task Master is disabled — avoids stranding it past approve/reject's own gate (Hermes review, PR #480, second pass)", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);
        const sessionsModule = await import("../../src/services/session-lifecycle.js");
        const createSessionSpy = vi.spyOn(sessionsModule, "createSessionRecord");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        // Left in "claimed" rather than advanced to "reviewing" — approve
        // and reject are both gated on "enabled" too, so a reviewing task
        // would otherwise be unresolvable until Task Master is turned back
        // on. Still reachable by the (ungated) budget force-fail below.
        expect(row.status).toBe("claimed");
        expect(row.reviewSessionId).toBeNull();
        expect(createSessionSpy).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("transitions the held-back task into reviewing (and spawns its review agent) once Task Master is re-enabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        const { taskId } = await createSessionAndTaskWithReviewAgent(app, "claimed", "codex");
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
        } as never);

        await reconcileTasks(app);
        expect((await getTask(app, taskId)).status).toBe("claimed");

        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "on" } },
        });
        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewSessionId).not.toBeNull();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("spawns the review agent on the in_progress -> reviewing path too", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithReviewAgent(app, "in_progress", "agy");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewSessionId).not.toBeNull();

      await app.close();
    });
  });

  // Hermes review, PR #574 (finding #2) — maybeOpenDraftPR's wiring was
  // previously exercised only via the real openDraftPRForTask silently
  // no-op'ing on "no-token" in this test DB, which never proved the
  // reconciler actually calls it (with the right task/project) or persists
  // its result. task-promote.ts is mocked above specifically for these.
  describe("draft PR on entering reviewing (Hermes review, PR #574, finding #2)", () => {
    it("calls openDraftPRForTask on the claimed -> reviewing edge and persists prUrl/prNumber on success", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/9",
        prNumber: 9,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/9");
      expect(row.prNumber).toBe(9);

      await app.close();
    });

    it("calls openDraftPRForTask on the in_progress -> reviewing edge too, and persists its result", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/11",
        prNumber: 11,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/11");
      expect(row.prNumber).toBe(11);

      await app.close();
    });

    it("never blocks the reviewing transition, and leaves prUrl/prNumber unset, when openDraftPRForTask fails (best-effort posture)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTask(app, "claimed");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });
  });

  // RC2/#722's investigation (task 213765) — a "reviewing" task whose ONE
  // draft-PR attempt (above) failed (dirty tree right after the worker's
  // last turn, a transient host/push failure) previously had no way back
  // into promotion: the claimed/in_progress SELECT excludes it, and
  // processReviewingTasks is joined on the review session, not the worker,
  // so a task with no review agent is invisible to it too. This sweep
  // (retryStrandedDraftPRs) is the fix.
  describe("stranded draft-PR retry sweep", () => {
    async function createReviewingTaskWithNoPR(
      app: Awaited<ReturnType<typeof buildApp>>,
      prNumber: number | null = null,
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-stranded-${Math.random()}`, cwd: "/tmp" },
      });
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "stranded",
          status: "reviewing",
          claimedAt: new Date(),
          reviewingAt: new Date(),
          prNumber,
        })
        .returning()
        .all();
      return { taskId: row.id };
    }

    it("retries a reviewing task with no PR and persists the result once it succeeds", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({
        ok: true,
        prUrl: "https://github.com/test-owner/test-repo/pull/42",
        prNumber: 42,
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      expect(mockOpenDraftPRForTask.mock.calls[0][1]).toMatchObject({ id: taskId });
      expect(row.status).toBe("reviewing");
      expect(row.prUrl).toBe("https://github.com/test-owner/test-repo/pull/42");
      expect(row.prNumber).toBe(42);

      await app.close();
    });

    it("does not record a draft PR that opened after the task already left 'reviewing' (independent review, PR #725)", async () => {
      const app = await buildApp();
      const { taskId } = await createReviewingTaskWithNoPR(app);
      // Simulates a concurrent give-up landing while openDraftPRForTask's
      // own network call is still in flight — by the time it resolves, the
      // task is no longer "reviewing".
      mockOpenDraftPRForTask.mockImplementation(async () => {
        app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
        return {
          ok: true,
          prUrl: "https://github.com/test-owner/test-repo/pull/99",
          prNumber: 99,
        };
      });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.prUrl).toBeNull();
      expect(row.prNumber).toBeNull();

      await app.close();
    });

    it("does not touch a reviewing task that already has a PR", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app, 7);

      await reconcileTasks(app);

      expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      await app.close();
    });

    it("backs off after an attempt instead of retrying on every tick", async () => {
      const app = await buildApp();
      await createReviewingTaskWithNoPR(app);
      mockOpenDraftPRForTask.mockResolvedValue({ ok: false, reason: "dirty-tree" });

      await reconcileTasks(app);
      await reconcileTasks(app);

      // Second tick lands well inside the 5-minute TTL — no second attempt.
      expect(mockOpenDraftPRForTask).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("does not retry while Task Master is disabled", async () => {
      const app = await buildApp();
      try {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        await createReviewingTaskWithNoPR(app);

        await reconcileTasks(app);

        expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });
  });

  // #722's investigation (task 213765) — a `stop_failure` (rate-limit,
  // quota) produces the exact same "phase: done" -> derived.status:
  // "finished" signal as a real completion. These prove the "-> reviewing"
  // transition now verifies the branch actually has commits before firing,
  // and that a stale finish latch (the reject snap-back, RC5) can't fire it
  // either.
  describe("reviewing gate — commits ahead of base and finish-since-claim (#722)", () => {
    // Low-entropy on purpose (not a real commit hash) — a realistic-looking
    // 40-char hex string trips detect-secrets' hex-high-entropy heuristic.
    const BASE_SHA = "0000000111122223333444455556666777788889";

    async function createSessionAndTaskWithBase(
      app: Awaited<ReturnType<typeof buildApp>>,
      status: "claimed" | "in_progress",
      claimedAt: Date = new Date(),
    ) {
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: `p-gate-${Math.random()}`, cwd: "/tmp" },
      });
      const session = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const sessionId = session.json().id as number;
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "t",
          status,
          sessionId,
          claimedAt,
          startedAt: status === "in_progress" ? claimedAt : null,
          worktreePath: "/tmp/mullion-task-worktree",
          branchName: "mullion/task-999",
          baseSha: BASE_SHA,
        })
        .returning()
        .all();
      return { taskId: row.id, sessionId };
    }

    function gitStatus(hash: string | null, isClean: boolean, files: unknown[] = []) {
      return {
        ok: true,
        value: {
          isRepo: true,
          status: { branch: "mullion/task-999", hash, ahead: 0, behind: 0, files, isClean },
        },
      };
    }

    it("fails the task, salvages a WIP commit, and terminates the session when HEAD is still at baseSha", async () => {
      const app = await buildApp();
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId, sessionId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // "0000000" is a prefix of BASE_SHA — HEAD hasn't moved since claim.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitWipChanges.mockResolvedValue({ committed: true });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");
      expect(row.failureReason).toContain("mullion/task-999");
      expect(mockCommitWipChanges).toHaveBeenCalledWith("/tmp/mullion-task-worktree");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));

      await app.close();
    });

    it("still fails the task (best-effort posture) when the WIP salvage commit itself fails", async () => {
      const app = await buildApp();
      vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitWipChanges.mockResolvedValue({ committed: false, error: "git add -u failed" });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");

      await app.close();
    });

    it("still advances to reviewing when the tree is dirty but the branch has commits ahead of base (blast-radius regression)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // Different hash from BASE_SHA — real commits exist, tree just has a
      // stray scratch file (files.length > 0 -> isClean: false).
      mockResolveHostGitStatus.mockResolvedValue(
        gitStatus("abcdef1", false, [{ path: "scratch.txt" }]),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(mockCommitWipChanges).not.toHaveBeenCalled();

      await app.close();
    });

    it("advances to reviewing when clean and ahead of base (unchanged happy path)", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });

    it("fails open (advances to reviewing) when the git-status check itself is unresolvable", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue({ ok: false, reason: "unsupported" });

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });

    // Independent review, PR #726 — checkReviewingGate itself IS proxied for
    // a #484-capable remote host (resolveHostGitStatus works there), but
    // failReviewingGate's salvage commit is local-only. Firing the gate
    // without the salvage would fail the task, terminate its session, and
    // leave the tree dirty — worse than pre-#722 behavior for a
    // remote-hosted task. The whole gate stays fail-open for remote hosts
    // until a remote salvage-commit proxy exists.
    it("fails open (advances to reviewing) for a remote-hosted task, without even checking git status", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-gate", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      // Inserted directly, not via POST /api/sessions (same reasoning as
      // the "does not trust reviewSeedDelivered:true..." test above — this
      // fake host isn't actually reachable, so a real spawn attempt 502s).
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [row] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "t",
          status: "in_progress",
          sessionId: workerSession.id,
          claimedAt: new Date(),
          startedAt: new Date(),
          worktreePath: "/remote/project",
          branchName: "mullion/task-999",
          baseSha: BASE_SHA,
        })
        .returning()
        .all();

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = {
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSession.id)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        isMasterAlive: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);
      // Would trigger the no-commits failure if the gate actually ran.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));

      await reconcileTasks(app);

      const updated = await getTask(app, row.id);
      expect(updated.status).toBe("reviewing");
      expect(mockResolveHostGitStatus).not.toHaveBeenCalled();

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("applies the same no-commits gate on the claimed -> reviewing edge", async () => {
      const app = await buildApp();
      const { taskId } = await createSessionAndTaskWithBase(app, "claimed");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");
      await app.close();
    });

    // RC5 — the reject snap-back: derived.status === "finished" is a LATCH
    // on lastTurnEndedAt, not an edge. A task rejected back to "in_progress"
    // whose worker session is still alive keeps its OLD, pre-reject latch —
    // without this guard, the very next tick would re-derive "finished" and
    // snap it straight back to "reviewing" before a human ever gets a
    // chance to type feedback into the terminal.
    it("does not snap an in_progress task back to reviewing when the finish latch predates this claim spell (reject snap-back)", async () => {
      const app = await buildApp();
      const claimedAt = new Date();
      const { taskId } = await createSessionAndTask(app, "in_progress", claimedAt);
      const staleLastTurnEndedAt = claimedAt.getTime() - 60_000;
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: staleLastTurnEndedAt }),
      } as never);

      await reconcileTasks(app);
      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(mockOpenDraftPRForTask).not.toHaveBeenCalled();

      await app.close();
    });

    it("advances normally once the finish signal postdates the claim spell", async () => {
      const app = await buildApp();
      const claimedAt = new Date();
      const { taskId } = await createSessionAndTask(app, "in_progress", claimedAt);
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);

      await reconcileTasks(app);

      expect((await getTask(app, taskId)).status).toBe("reviewing");
      await app.close();
    });
  });

  describe("review-findings loop (processReviewingTasks)", () => {
    // Only the given session ids report "finished" — every other id (in
    // particular a worker session freshly re-spawned by THIS SAME
    // reconcileTasks() call's own processReviewingTasks pass, before the
    // claimed/in_progress loop's own SELECT runs) reports plain idle
    // silence. A blanket "everyone is finished" mock would make that
    // brand-new session look already-finished too, and the claimed/
    // in_progress loop — which reads its rows AFTER processReviewingTasks
    // runs, in the same call — would immediately flip it straight back to
    // "reviewing" a second time, a false cascade this mock exists to avoid
    // (a real freshly-spawned session has no Stop hook fired yet).
    function mockFinishedSessionIds(app: Awaited<ReturnType<typeof buildApp>>, ...ids: number[]) {
      const finished = new Set(ids.map(String));
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              finished.has(String(id)) ? fakeInfo({ lastTurnEndedAt: Date.now() }) : fakeInfo(),
          }) as never,
      );
    }

    async function claimIntoReviewing(
      app: Awaited<ReturnType<typeof buildApp>>,
      reviewAgent: string,
    ) {
      const { taskId, sessionId: workerSessionId } = await createSessionAndTaskWithReviewAgent(
        app,
        "claimed",
        reviewAgent,
      );
      // createSessionAndTaskWithReviewAgent (shared with the review-agent
      // describe block above) never sets agentCommand — a real claim always
      // does (task-claim.ts). reseedTaskIfSessionExited's own guard
      // silently no-ops without it, so it must be set here for the
      // auto-return path this describe block actually exercises. Must be a
      // seed-capable command (not e.g. "bash", which matches no hook
      // adapter) — Hermes review, PR #576's shouldAutoReturn gate now
      // requires commandSupportsSeed(task.agentCommand) too.
      app.db.update(tasks).set({ agentCommand: "codex" }).where(eq(tasks.id, taskId)).run();
      mockFinishedSessionIds(app, workerSessionId);
      await reconcileTasks(app);
      const row = await getTask(app, taskId);
      const reviewSessionId = row.reviewSessionId as number;
      // From here on, only the REVIEW session (not any later re-spawned
      // worker session) reports finished — see this function's own doc
      // comment above.
      mockFinishedSessionIds(app, reviewSessionId);
      return { taskId, workerSessionId, reviewSessionId };
    }

    function writeFindings(
      app: Awaited<ReturnType<typeof buildApp>>,
      taskId: number,
      round: number,
      content: string,
    ) {
      const findingsPath = taskReviewFindingsPath(
        path.dirname(app.pty.hookSocketPath),
        taskId,
        round,
      );
      fs.writeFileSync(findingsPath, content);
    }

    it("ingests non-empty findings, appends them, and auto-returns to in_progress exactly once", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Fix the null check on line 42.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.reviewRounds).toBe(1);
      expect(row.reviewFindings).toContain("Fix the null check on line 42.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // The worker session was force-terminated and replaced — nobody was
      // watching the idle survivor to type the findings in themselves.
      expect(row.sessionId).not.toBe(workerSessionId);
      expect(row.sessionId).not.toBeNull();

      await app.close();
    });

    it("records an inconclusive entry and stays in reviewing when the review agent wrote no findings file", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Deliberately no writeFindings call — the prompt now tells the agent
      // to ALWAYS write the file, so a missing one can no longer be read as
      // a confident "clean" review; it's reported as inconclusive instead.

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRounds).toBe(0);
      expect(row.reviewFindings).toContain("inconclusive");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // The regression guard Change 1 exists for. Under the old "a findings
    // file means act on it" rule, always writing a file (this prompt's own
    // change) would have made a clean review indistinguishable from one
    // requesting changes — auto-returning and burning the task's one round
    // on a worker that has nothing to fix.
    it("does NOT auto-return, and stays in reviewing, when the review agent's JSON verdict is clean", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "clean",
          summary: "Reviewed the diff and ran the test suite; no issues found.",
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRounds).toBe(0);
      expect(row.reviewFindings).toContain("no issues found");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    it("auto-returns exactly once, and renders anchored findings, when the review agent's JSON verdict is changes-requested", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({
          verdict: "changes-requested",
          summary: "One errcheck failure.",
          findings: [
            {
              path: "cmd/branchdam/main_test.go",
              line: 669,
              body: "occupied.Close()'s error return is unchecked.",
            },
          ],
        }),
      );

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.reviewRounds).toBe(1);
      expect(row.reviewFindings).toContain("cmd/branchdam/main_test.go:669");
      expect(row.reviewFindings).toContain("error return is unchecked");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).not.toBe(workerSessionId);

      await app.close();
    });

    it("does not re-ingest (or re-comment) an already-processed review session's output on a later tick", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");

      await reconcileTasks(app);
      const afterFirst = await getTask(app, taskId);

      await reconcileTasks(app);
      const afterSecond = await getTask(app, taskId);

      expect(afterSecond.reviewFindings).toBe(afterFirst.reviewFindings);
      expect(afterSecond.status).toBe(afterFirst.status);

      await app.close();
    });

    it("does not auto-return once reviewRounds already used its one round — findings are still captured", async () => {
      const app = await buildApp();
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "p-bounded", cwd: "/tmp" },
      });
      const workerSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const reviewSession = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.json().id, command: "bash" },
      });
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.json().id,
          title: "already used its round",
          status: "reviewing",
          sessionId: workerSession.json().id,
          reviewSessionId: reviewSession.json().id,
          reviewRounds: 1,
          worktreePath: "/tmp",
          agentCommand: "claude",
          claimedAt: new Date(),
        })
        .returning()
        .all();
      mockFinishedSessionIds(app, reviewSession.json().id);
      writeFindings(app, task.id, 1, "A second-round finding, arriving too late to auto-return.");

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRounds).toBe(1);
      expect(row.reviewFindings).toContain("arriving too late to auto-return");
      expect(row.sessionId).toBe(workerSession.json().id);

      await app.close();
    });

    it("does not auto-return while Task Master is disabled, even with non-empty findings", async () => {
      const app = await buildApp();
      try {
        const { taskId, workerSessionId } = await claimIntoReviewing(app, "codex");
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "off" } },
        });
        writeFindings(app, taskId, 0, "Findings nobody will act on automatically.");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.status).toBe("reviewing");
        expect(row.reviewFindings).toContain("Findings nobody will act on automatically");
        expect(row.sessionId).toBe(workerSessionId);
      } finally {
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: { taskMaster: { enabled: "inherit" } },
        });
        await app.close();
      }
    });

    it("runs even on a tick with zero claimed/in_progress tasks", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Should still be picked up.");
      // No other claimed/in_progress task exists at this point — the
      // claimed/in_progress loop's own `rows.length === 0` early return
      // must not skip this task's processing.

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.reviewFindings).toContain("Should still be picked up");

      await app.close();
    });

    it("removes the round's findings file from disk once its content is durably ingested", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), taskId, 0);
      writeFindings(app, taskId, 0, "This file should be gone after ingestion.");
      expect(fs.existsSync(findingsPath)).toBe(true);

      await reconcileTasks(app);

      expect(fs.existsSync(findingsPath)).toBe(false);

      await app.close();
    });

    // Hermes review, PR #576, finding #1 — the findings file lives in THIS
    // process's own local sessionsDir; a remote-hosted review agent writes
    // to the remote host's filesystem instead, which this loop cannot read.
    it("never ingests a remote-hosted task's review findings, rather than falsely concluding 'no findings' from a locally-missing file", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "Remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "p-remote-review", cwd: "/remote/project", hostId },
      });
      const projectId = project.json().id;
      const [workerSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "active" })
        .returning()
        .all();
      const [reviewSession] = app.db
        .insert(sessions)
        .values({ projectId, command: "codex", status: "active" })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId,
          title: "remote review",
          status: "reviewing",
          sessionId: workerSession.id,
          reviewSessionId: reviewSession.id,
          worktreePath: "/remote/project",
          agentCommand: "codex",
          claimedAt: new Date(),
        })
        .returning()
        .all();
      const infoSpy = vi.spyOn(app.log, "info");

      await reconcileTasks(app);

      const row = await getTask(app, task.id);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: task.id, hostId }),
        expect.stringContaining("remote-hosted task"),
      );

      await app.close();
    });

    // Hermes review, PR #576, finding #2 — a review agent that ends its
    // process right after its turn (instead of staying running) derives
    // "exited", not "finished". Accepting "exited" unconditionally would
    // also ingest a session a human killed, or one that crashed, as a false
    // "no findings" — only accept it when a findings file actually exists.
    describe("a review session that derives 'exited' instead of 'finished'", () => {
      it("still ingests its findings when the findings file exists", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        writeFindings(app, taskId, 0, "Found via an agent that exited right after its turn.");
        vi.spyOn(app.pty, "get").mockImplementation(
          (id: string) =>
            ({
              toInfo: () =>
                String(id) === String(reviewSessionId)
                  ? fakeInfo({ endedReason: "process-exit", exitCode: 0 })
                  : fakeInfo(),
            }) as never,
        );
        const [reviewSessionRow] = app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(eq(sessions.id, reviewSessionId))
          .returning()
          .all();
        expect(reviewSessionRow.status).toBe("exited");

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewFindings).toContain("exited right after its turn");
        expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

        await app.close();
      });

      it("is NOT ingested (and stays available for a later tick) when no findings file exists — avoids a false 'no findings' for a killed/crashed session", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        // Deliberately no writeFindings call.
        vi.spyOn(app.pty, "get").mockImplementation(
          (id: string) =>
            ({
              toInfo: () =>
                String(id) === String(reviewSessionId)
                  ? fakeInfo({ endedReason: "signal", exitCode: null })
                  : fakeInfo(),
            }) as never,
        );
        app.db
          .update(sessions)
          .set({ status: "killed" })
          .where(eq(sessions.id, reviewSessionId))
          .run();

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.reviewFindings).toBeNull();
        expect(row.reviewFindingsIngestedSessionId).toBeNull();

        await app.close();
      });
    });

    // Hermes review, PR #576, finding #5 — reseedTaskIfSessionExited delivers
    // the findings as an argv initial prompt only; a non-seed-capable worker
    // adapter (e.g. gemini, which has no adapter at all) would auto-return
    // to a fresh session with NO instructions, burning the task's one round
    // for nothing and leaving it to ride its budget out. Findings must
    // still be recorded/commented; only the auto-return itself is skipped.
    // (OpenCode used to be this test's example too, but it gained
    // `initialPromptArgs` — see hook-adapters/opencode.ts.)
    it("records and comments findings but does not auto-return when the worker's agent can't receive a seeded prompt", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // gemini matches no adapter at all, so no initialPromptArgs — see
      // task-agent-resolve.ts's commandSupportsSeed.
      app.db.update(tasks).set({ agentCommand: "gemini" }).where(eq(tasks.id, taskId)).run();
      writeFindings(app, taskId, 0, "This should reach the drawer and the PR, not the worker.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRounds).toBe(0);
      expect(row.reviewFindings).toContain("should reach the drawer and the PR");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #580 — accepting "exited" for ingestion (finding #2
    // of the PR #576 round) opened a narrower gap: a review agent that
    // crashes AFTER writing a partial findings file also derives "exited"
    // with a non-null file. Auto-returning on that signal would spend the
    // task's one round on a half-written review. Only a genuine "finished"
    // may drive auto-return; "exited" is ingest-and-comment only.
    it("ingests and comments an 'exited' review session's findings but does NOT spend the auto-return round on them", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Possibly a partial review — the agent crashed right after.");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ endedReason: "process-exit", exitCode: 1 })
                : fakeInfo(),
          }) as never,
      );
      app.db
        .update(sessions)
        .set({ status: "exited" })
        .where(eq(sessions.id, reviewSessionId))
        .run();

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewRounds).toBe(0);
      expect(row.reviewFindings).toContain("Possibly a partial review");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #580 — reviewRounds is spent in the same CAS that
    // flips status to in_progress, before the re-seed's own outcome is
    // known. A re-seed failure (terminate/spawn error, or a lost race —
    // see reseedTaskIfSessionExited's own doc comment) previously left the
    // task's one auto-return round permanently spent with nobody having
    // received the findings.
    it("rolls back the spent auto-return round when the re-seed itself fails", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "This should not cost the task its one round.");
      mockReseedTaskIfSessionExited.mockResolvedValueOnce(false);
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.reviewRounds).toBe(0);
      expect(row.reviewFindings).toContain("should not cost the task its one round");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, rolledBack: true }),
        expect.stringContaining("rolled back the spent auto-return round"),
      );

      await app.close();
    });
  });
});
