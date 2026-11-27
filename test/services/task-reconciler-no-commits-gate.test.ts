import { describe, it, expect, vi } from "vitest";
import { seedHostResponse } from "../helpers/hosts.js";
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
  inertBackendMembers,
  fakeInfo,
  createSessionAndTask,
  getTask,
  createSessionAndTaskWithBase,
  gitStatus,
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

const { buildApp } = await import("../../src/app.js");
const { reconcileTasks } = await import("../../src/services/task-reconciler.js");
const { tasks, sessions } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");

const { mockOpenDraftPRForTask, mockResolveHostGitStatus, mockCommitHostWipChanges } =
  reconcilerMocks;

describe("reconcileTasks — reviewing gate (#722)", () => {
  setupReconcilerTestLifecycle("task-reconciler-no-commits-gate");
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

    it("fails the task, salvages a WIP commit, and terminates the session when HEAD is still at baseSha", async () => {
      const app = await buildApp();
      const terminateSpy = vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
      const { taskId, sessionId } = await createSessionAndTaskWithBase(app, "in_progress");
      vi.spyOn(app.pty, "get").mockReturnValue({
        toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
      } as never);
      // "0000000" is a prefix of BASE_SHA — HEAD hasn't moved since claim.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", false, [{ path: "x" }]));
      mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toContain("no commits");
      expect(row.failureReason).toContain("mullion/task-999");
      // Not asserting the `app` arg's deep equality via toHaveBeenCalledWith
      // — Fastify's real instance has a `listeningOrigin` getter that
      // throws when the server was never actually .listen()ed (this suite
      // only ever .inject()s) vitest's call-matcher does a structural
      // comparison that would trip it (same pitfall documented in
      // task-github-sync.test.ts and task-watcher-dependencies.test.ts).
      // `toBe` (reference identity) on the individual call args sidesteps
      // that safely.
      expect(mockCommitHostWipChanges).toHaveBeenCalledTimes(1);
      expect(mockCommitHostWipChanges.mock.calls[0][0]).toBe(app);
      expect(mockCommitHostWipChanges.mock.calls[0][1]).toBe("local");
      expect(mockCommitHostWipChanges.mock.calls[0][2]).toBe("/tmp/mullion-task-worktree");
      expect(terminateSpy).toHaveBeenCalledWith(String(sessionId));
      // #772 — killSession, not a bare backend.terminate: the session row
      // itself must flip to "killed", not linger "active" until the 30s
      // exited-session reconciler eventually marks it "exited".
      const { sessions } = await import("../../src/db/schema.js");
      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      expect(sessionRow.status).toBe("killed");

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
      mockCommitHostWipChanges.mockResolvedValue({
        ok: true,
        value: { committed: false, error: "git add -u failed" },
      });

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
      expect(mockCommitHostWipChanges).not.toHaveBeenCalled();

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

    // Task 441117 / issue #1380 — a worker's final turn ended, but a
    // background shell job it started (a wait loop that can never exit) was
    // still reported "running", pinning the session at `background` so the
    // handoff never fired and the claim-anchored budget failed finished work.
    describe("background shell tail after a finished turn", () => {
      const MIN = 60_000;
      const shellTask = { id: "b1", type: "shell", status: "running", description: "wait loop" };

      function tailInfo(turnEndedAgoMs: number, tasksOutstanding: unknown[]) {
        return fakeInfo({
          lastTurnEndedAt: Date.now() - turnEndedAgoMs,
          outstandingBackgroundTasks: tasksOutstanding,
        });
      }

      it("hands off to reviewing once only shell tasks remain past the grace window", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 30 * MIN),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => tailInfo(10 * MIN, [shellTask]),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("reviewing");
        await app.close();
      });

      it("keeps waiting while the shell tail is still inside the grace window", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 30 * MIN),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => tailInfo(1 * MIN, [shellTask]),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("in_progress");
        await app.close();
      });

      it("still blocks on outstanding non-shell background work (issue #428)", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 30 * MIN),
        );
        const agentTask = { id: "a1", type: "agent", status: "running", description: "sub" };
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => tailInfo(10 * MIN, [shellTask, agentTask]),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("in_progress");
        await app.close();
      });

      it("still hands off when a failed last gate run masks the shell tail as tool_failure", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 30 * MIN),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => ({
            ...tailInfo(10 * MIN, [shellTask]),
            errorState: "tool_failure",
            errorDetail: "make format-check failed",
          }),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("reviewing");
        await app.close();
      });

      it("does not hand off while the session is blocked on a human decision", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 30 * MIN),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => ({ ...tailInfo(10 * MIN, [shellTask]), permissionState: "pending" }),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("in_progress");
        await app.close();
      });

      it("ignores a shell tail whose turn ended BEFORE this claim (stale latch)", async () => {
        const app = await buildApp();
        const { taskId } = await createSessionAndTaskWithBase(
          app,
          "in_progress",
          new Date(Date.now() - 5 * MIN),
        );
        vi.spyOn(app.pty, "get").mockReturnValue({
          toInfo: () => tailInfo(20 * MIN, [shellTask]),
        } as never);
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

        await reconcileTasks(app);

        expect((await getTask(app, taskId)).status).toBe("in_progress");
        await app.close();
      });
    });

    describe("budget salvage for a worker that already finished", () => {
      const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60_000);
      const shellTask = { id: "b1", type: "shell", status: "running", description: "wait loop" };

      async function withBudget(run: () => Promise<void>) {
        process.env.MULLION_TASK_BUDGET_MINUTES = "1";
        try {
          await run();
        } finally {
          process.env.MULLION_TASK_BUDGET_MINUTES = "120";
        }
      }

      it("hands a finished worker with commits to reviewing instead of failing it on budget", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          const { taskId } = await createSessionAndTaskWithBase(
            app,
            "in_progress",
            TWO_HOURS_AGO(),
          );
          vi.spyOn(app.pty, "get").mockReturnValue({
            toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
          } as never);
          mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.status).toBe("reviewing");
          expect(row.failureReason).toBeNull();
          await app.close();
        });
      });

      it("salvages a finished worker stuck behind a background shell job", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          const { taskId } = await createSessionAndTaskWithBase(
            app,
            "in_progress",
            TWO_HOURS_AGO(),
          );
          vi.spyOn(app.pty, "get").mockReturnValue({
            toInfo: () =>
              fakeInfo({
                lastTurnEndedAt: Date.now() - 90 * 60_000,
                outstandingBackgroundTasks: [shellTask],
              }),
          } as never);
          mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

          await reconcileTasks(app);

          expect((await getTask(app, taskId)).status).toBe("reviewing");
          await app.close();
        });
      });

      it("still fails on budget when Task Master is disabled (no handoff would follow a salvage)", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          try {
            vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
            await app.inject({
              method: "PATCH",
              url: "/api/settings",
              payload: { taskMaster: { enabled: "off" } },
            });
            const { taskId } = await createSessionAndTaskWithBase(
              app,
              "in_progress",
              TWO_HOURS_AGO(),
            );
            vi.spyOn(app.pty, "get").mockReturnValue({
              toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
            } as never);
            mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

            await reconcileTasks(app);

            const row = await getTask(app, taskId);
            expect(row.status).toBe("failed");
            expect(row.failureReason).toContain("budget exceeded");
          } finally {
            // Settings persist across tests in this file — restore the default.
            await app.inject({
              method: "PATCH",
              url: "/api/settings",
              payload: { taskMaster: { enabled: "inherit" } },
            });
            await app.close();
          }
        });
      });

      it("still fails on budget when the finished worker made no commits", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
          const { taskId } = await createSessionAndTaskWithBase(
            app,
            "in_progress",
            TWO_HOURS_AGO(),
          );
          vi.spyOn(app.pty, "get").mockReturnValue({
            toInfo: () => fakeInfo({ lastTurnEndedAt: Date.now() }),
          } as never);
          // "0000000" is a prefix of BASE_SHA — HEAD never moved.
          mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));

          await reconcileTasks(app);

          const row = await getTask(app, taskId);
          expect(row.status).toBe("failed");
          expect(row.failureReason).toContain("budget exceeded");
          await app.close();
        });
      });

      it("still fails on budget when non-shell background work is outstanding", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
          const { taskId } = await createSessionAndTaskWithBase(
            app,
            "in_progress",
            TWO_HOURS_AGO(),
          );
          const agentTask = { id: "a1", type: "agent", status: "running", description: "sub" };
          vi.spyOn(app.pty, "get").mockReturnValue({
            toInfo: () =>
              fakeInfo({
                lastTurnEndedAt: Date.now() - 90 * 60_000,
                outstandingBackgroundTasks: [shellTask, agentTask],
              }),
          } as never);
          mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

          await reconcileTasks(app);

          expect((await getTask(app, taskId)).status).toBe("failed");
          await app.close();
        });
      });

      it("still fails on budget when the turn hasn't ended since this claim", async () => {
        await withBudget(async () => {
          const app = await buildApp();
          vi.spyOn(app.pty, "terminate").mockResolvedValue(undefined);
          const { taskId } = await createSessionAndTaskWithBase(
            app,
            "in_progress",
            TWO_HOURS_AGO(),
          );
          vi.spyOn(app.pty, "get").mockReturnValue({
            toInfo: () => fakeInfo({ activity: "working" }),
          } as never);
          mockResolveHostGitStatus.mockResolvedValue(gitStatus("abcdef1", true));

          await reconcileTasks(app);

          expect((await getTask(app, taskId)).status).toBe("failed");
          await app.close();
        });
      });
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

    // Issue #1100 inverts the old PR #726 posture: checkReviewingGate is no
    // longer scoped to LOCAL_HOST_ID (resolveHostGitStatus is already fully
    // proxied for a remote host) failReviewingGate now probes
    // commitHostWipChanges itself as the capability check — a remote host
    // that CAN service the salvage goes through the exact same
    // fail/salvage/terminate flow as a local one; only a genuine
    // "unsupported"/"unreachable" probe result still falls open. Both
    // sub-cases get their own test below.
    function buildFakeRemoteBackend(workerSessionId: number) {
      // Mirrors the fake SessionBackend used elsewhere in this file for a
      // remote host (e.g. the CI-gated review spawn tests) — a fake
      // unreachable host would 502 on a real spawn, so the task/session
      // rows are inserted directly via app.db rather than through the HTTP
      // API resolveBackend is stubbed rather than actually dialing out.
      return {
        ...inertBackendMembers(),
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({
          [String(workerSessionId)]: fakeInfo({ lastTurnEndedAt: Date.now() }),
        }),
        liveness: vi.fn().mockResolvedValue({}),
        compareWorktreePaths: vi.fn().mockResolvedValue([]),
        terminate: vi.fn().mockResolvedValue(undefined),
        getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        getRenderedScrollback: vi.fn().mockResolvedValue(""),
        getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
        uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
        resolveReviewGate: vi.fn().mockResolvedValue(false),
        acknowledgeAttention: vi.fn().mockResolvedValue(true),
        prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
        waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
        createWorktree: vi.fn().mockResolvedValue(null),
        checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
        resumeTaskWorktree: vi.fn().mockResolvedValue(null),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        resolvePendingPromote: vi.fn().mockResolvedValue(false),
        removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
        pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
        clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
      };
    }

    async function seedRemoteInProgressTask(
      app: Awaited<ReturnType<typeof buildApp>>,
      name: string,
    ) {
      const host = await seedHostResponse(app, {
        name: `Remote-${name}`,
        baseUrl: "http://127.0.0.1:1",
        token: "t",
      });
      const hostId = host.json().id as string;
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: `p-remote-gate-${name}`,
          cwd: `/remote/project-${name}`,
          hostId,
        },
      });
      const projectId = project.json().id;
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
          worktreePath: `/remote/project-${name}`,
          branchName: "mullion/task-999",
          baseSha: BASE_SHA,
        })
        .returning()
        .all();
      return { hostId, workerSession, taskRow: row, worktreePath: `/remote/project-${name}` };
    }

    it("fails, salvages the WIP commit, and terminates the session for a remote-hosted task whose commit-wip capability works", async () => {
      const app = await buildApp();
      const { hostId, workerSession, taskRow, worktreePath } = await seedRemoteInProgressTask(
        app,
        "works",
      );

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = buildFakeRemoteBackend(workerSession.id);
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);
      // HEAD still at baseSha — would trigger the no-commits failure, same
      // as the local-host test above, now that the gate isn't skipped.
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));
      mockCommitHostWipChanges.mockResolvedValue({ ok: true, value: { committed: true } });

      await reconcileTasks(app);

      const updated = await getTask(app, taskRow.id);
      expect(updated.status).toBe("failed");
      expect(updated.failureReason).toContain("no commits");
      expect(mockResolveHostGitStatus).toHaveBeenCalled();
      // toBe, not toHaveBeenCalledWith(app, ...) — see the matching comment
      // on the local-host test above (the real `app`'s `listeningOrigin`
      // getter throws under a structural equality check on an app that was
      // never actually .listen()ed).
      expect(mockCommitHostWipChanges).toHaveBeenCalledTimes(1);
      expect(mockCommitHostWipChanges.mock.calls[0][0]).toBe(app);
      expect(mockCommitHostWipChanges.mock.calls[0][1]).toBe(hostId);
      expect(mockCommitHostWipChanges.mock.calls[0][2]).toBe(worktreePath);
      const [sessionRow] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, workerSession.id))
        .all();
      expect(sessionRow.status).toBe("killed");

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    it("still fails the task (best-effort posture) for a remote-hosted task whose WIP salvage commit itself fails", async () => {
      // Mirrors the local-host "still fails...when the WIP salvage commit
      // itself fails" test above: commitHostWipChanges resolves ok: true
      // (the capability probe succeeded — this host DOES support the
      // route), but value.error is set (a real salvage failure on that
      // host, e.g. a lock file or an isSafeAbsolutePath rejection). This is
      // NOT the fail-open case — ok: true means the CAS still proceeds,
      // same as it always has for a local host with a failed salvage.
      const app = await buildApp();
      const { hostId, workerSession, taskRow, worktreePath } = await seedRemoteInProgressTask(
        app,
        "salvage-error",
      );

      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const fakeBackend = buildFakeRemoteBackend(workerSession.id);
      const resolveBackendSpy = vi
        .spyOn(sessionBackendModule, "resolveBackend")
        .mockReturnValue(fakeBackend);
      mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));
      mockCommitHostWipChanges.mockResolvedValue({
        ok: true,
        value: { committed: false, error: "git add -u failed" },
      });

      await reconcileTasks(app);

      const updated = await getTask(app, taskRow.id);
      expect(updated.status).toBe("failed");
      expect(updated.failureReason).toContain("no commits");
      expect(mockCommitHostWipChanges).toHaveBeenCalledTimes(1);
      expect(mockCommitHostWipChanges.mock.calls[0][0]).toBe(app);
      expect(mockCommitHostWipChanges.mock.calls[0][1]).toBe(hostId);
      expect(mockCommitHostWipChanges.mock.calls[0][2]).toBe(worktreePath);
      const [sessionRow] = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, workerSession.id))
        .all();
      expect(sessionRow.status).toBe("killed");

      resolveBackendSpy.mockRestore();
      await app.close();
    });

    // Fails open here means failReviewingGate returns WITHOUT touching the
    // task's status at all (no CAS to "failed") — not the old pre-#1100
    // posture of blindly promoting straight to "reviewing" without ever
    // checking git status. checkReviewingGate now genuinely determines
    // there are no commits past base (resolveHostGitStatus succeeds), so
    // silently promoting to "reviewing" here would reintroduce the exact
    // #722 zero-diff-PR bug for a remote host; leaving the task
    // "in_progress" is what lets it get re-evaluated (and either recover or
    // still be retried by a human) once the host issue clears, without ever
    // being permanently stuck in "failed" behind a dirty, un-salvageable
    // worktree.
    it.each(["unsupported", "unreachable"] as const)(
      'leaves the task in_progress (fails open, no CAS) for a remote-hosted task whose commit-wip capability probe reports "%s"',
      async (reason) => {
        const app = await buildApp();
        const { workerSession, taskRow } = await seedRemoteInProgressTask(app, reason);

        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const fakeBackend = buildFakeRemoteBackend(workerSession.id);
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);
        // Would trigger the no-commits failure path (HEAD still at
        // baseSha) — the salvage probe result below is what decides
        // whether that path can actually run to completion.
        mockResolveHostGitStatus.mockResolvedValue(gitStatus("0000000", true));
        mockCommitHostWipChanges.mockResolvedValue(
          reason === "unsupported"
            ? { ok: false, reason: "unsupported" }
            : { ok: false, reason: "unreachable", detail: "connect ECONNREFUSED" },
        );

        await reconcileTasks(app);

        const updated = await getTask(app, taskRow.id);
        expect(updated.status).toBe("in_progress");
        expect(updated.failureReason).toBeNull();
        // The session stays alive — fail-open means failReviewingGate never
        // reached its CAS/kill/sync steps at all.
        const [sessionRow] = app.db
          .select()
          .from(sessions)
          .where(eq(sessions.id, workerSession.id))
          .all();
        expect(sessionRow.status).toBe("active");

        resolveBackendSpy.mockRestore();
        await app.close();
      },
    );

    // The former "applies the same no-commits gate on the claimed ->
    // reviewing edge" sibling of this describe block was deleted (task-claim
    // queueing, rate-limit-storm fix) — that edge no longer exists this
    // block's own in_progress-based no-commits-gate coverage above
    // ("still fails the task... when the WIP salvage commit itself fails")
    // already exercises the identical assertion via the one edge that
    // remains.

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
});
