import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  restorePassThroughMocks,
  fakeInfo,
  getTask,
  claimIntoReviewing,
  writeFindings,
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

const {
  mockReseedTaskIfSessionExited,
  mockResolveRepoRef,
  mockResolveGitHubToken,
  mockResolveMullionReviewLogins,
  mockFetchPullRequestReviewThreads,
  mockResolveReviewThread,
} = reconcilerMocks;

describe("reconcileTasks — review-findings loop", () => {
  setupReconcilerTestLifecycle("task-reconciler-review-findings");
  describe("review-findings loop (processReviewingTasks)", () => {
    // Only the given session ids report "finished" — every other id (in
    // particular a worker session freshly re-spawned by THIS SAME
    // reconcileTasks() call's own processReviewingTasks pass, before the
    // claimed/in_progress loop's own SELECT runs) reports plain idle
    // silence. A blanket "everyone is finished" mock would make that
    // brand-new session look already-finished too the claimed/
    // in_progress loop — which reads its rows AFTER processReviewingTasks
    // runs, in the same call — would immediately flip it straight back to
    // "reviewing" a second time, a false cascade this mock exists to avoid
    // (a real freshly-spawned session has no Stop hook fired yet).

    // Doubles as the freeform/legacy-text regression test: this findings
    // file is plain text, not JSON, so it only reaches this behavior via
    // parseReviewFindings's tolerant fallback to `changes-requested` (see
    // that function's own doc comment in task-prompt.ts). If a future
    // change ever narrowed the fallback verdict, this is the test that
    // would catch it — tied here explicitly so a failure points at the
    // right place.
    it("ingests non-empty freeform findings (parsed as changes-requested via the tolerant fallback), appends them auto-returns to in_progress exactly once", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Fix the null check on line 42.");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("in_progress");
      expect(row.autoReturnRounds).toBe(1);
      expect(row.reviewFindings).toContain("Fix the null check on line 42.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // The worker session was force-terminated and replaced — nobody was
      // watching the idle survivor to type the findings in themselves.
      expect(row.sessionId).not.toBe(workerSessionId);
      expect(row.sessionId).not.toBeNull();

      await app.close();
    });

    // Task Master trial 220921 / PR #743's incident — a "finished" review
    // session with no findings file yet must NOT be ingested as
    // inconclusive the instant that's observed: the review prompt now asks
    // the agent to run the repo's whole verification gate before writing
    // anything, so a few minutes of silence is normal. Only once the
    // review SESSION (not the current turn) has been alive past
    // REVIEW_FINDINGS_GRACE_MS is a still-missing file treated as
    // genuinely absent — see that constant's own doc comment.
    it("does NOT ingest a 'finished' review with no findings file yet — still within the grace window", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId } = await claimIntoReviewing(app, "codex");
      // Deliberately no writeFindings call the review session was just
      // created by claimIntoReviewing above — well within the grace window.

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // The regression guard this whole PR exists for: task 220921 / PR
    // #743's real incident — a review agent's genuine `verdict: "clean"`
    // file landed 21 seconds after a tick had already observed "finished"
    // with no file yet. Before this PR, that first tick would have latched
    // `reviewFindingsIngestedSessionId` immediately and permanently,
    // making the real file (written on tick 2 here) unreadable forever.
    it("ingests the REAL findings file on a later tick, after an earlier tick observed 'finished' with no file yet", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");

      // Tick 1 — "finished", no file yet, still within the grace window:
      // must NOT latch anything (pinned by the test just above too).
      await reconcileTasks(app);
      const afterTick1 = await getTask(app, taskId);
      expect(afterTick1.reviewFindings).toBeNull();
      expect(afterTick1.reviewFindingsIngestedSessionId).toBeNull();

      // The real review finishes its work and writes its verdict — this is
      // the "21 seconds later" moment from the actual incident.
      writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));

      // Tick 2 — the SAME review session, now with a real file on disk.
      await reconcileTasks(app);
      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("All good.");
      expect(row.reviewFindings).not.toContain("inconclusive");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // D1 — a live dry run (2026-08-27) confirmed this exact deadlock: a
    // "clean" verdict ingests fine, but Mullion's own anchored finding from
    // an earlier round left a GitHub review thread unresolved nothing
    // in the codebase ever resolved it — `attemptMerge` then read
    // `mergeable_state: "blocked"` forever, even with green CI. This is the
    // fix's corroboration bound: a "clean" verdict resolves Mullion's own
    // remaining unresolved threads, but never a human's.
    describe("resolves Mullion's own review threads on a clean verdict (D1)", () => {
      beforeEach(() => {
        mockResolveRepoRef.mockResolvedValue({ owner: "o", repo: "r" });
        mockResolveGitHubToken.mockResolvedValue("tok");
      });

      afterEach(() => {
        restorePassThroughMocks();
      });

      it("resolves a thread authored by Mullion's own reviewer identity, never a human's", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-own",
              isResolved: false,
              comments: [
                {
                  author: "mullion-reviewer[bot]",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Fix this.",
                },
              ],
            },
            {
              id: "thread-human",
              isResolved: false,
              comments: [
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 2,
                  body: "Also fix this.",
                },
              ],
            },
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).toHaveBeenCalledExactlyOnceWith("tok", "thread-own");
        expect(mockResolveReviewThread).not.toHaveBeenCalledWith("tok", "thread-human");
        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("approved");

        await app.close();
      });

      it("does not attempt to resolve anything on a changes-requested verdict", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db
          .update(tasks)
          .set({ prNumber: 9, agentCommand: "codex" })
          .where(eq(tasks.id, taskId))
          .run();
        writeFindings(
          app,
          taskId,
          0,
          JSON.stringify({
            verdict: "changes-requested",
            summary: "Needs work.",
            findings: [{ path: "src/foo.ts", line: 1, severity: "blocker", body: "Fix this." }],
          }),
        );

        await reconcileTasks(app);

        expect(mockFetchPullRequestReviewThreads).not.toHaveBeenCalled();
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      it("does not attempt to resolve anything on an inconclusive verdict (a crashed reviewer confirms nothing)", async () => {
        const app = await buildApp();
        const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        // No writeFindings call at all — the grace window elapsing with no
        // file is what produces "inconclusive" (see the dedicated test
        // above this describe block).
        const { sessions } = await import("../../src/db/schema.js");
        await app.db
          .update(sessions)
          .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
          .where(eq(sessions.id, reviewSessionId));

        await reconcileTasks(app);

        const row = await getTask(app, taskId);
        expect(row.lastReviewVerdict).toBe("inconclusive");
        expect(mockFetchPullRequestReviewThreads).not.toHaveBeenCalled();
        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });

      // Independent review, round 3 — ownership must be judged across
      // EVERY comment in a thread, not just the first. A thread that
      // started as Mullion's own finding but later got a human reply
      // pushing back inside it must stay unresolved: auto-resolving on
      // comments[0] alone would dismiss that human objection right along
      // with the original finding.
      it("does not resolve a thread Mullion started if a human later replied inside it", async () => {
        const app = await buildApp();
        const { taskId } = await claimIntoReviewing(app, "codex");
        app.db.update(tasks).set({ prNumber: 9 }).where(eq(tasks.id, taskId)).run();
        writeFindings(app, taskId, 0, JSON.stringify({ verdict: "clean", summary: "All good." }));
        mockFetchPullRequestReviewThreads.mockResolvedValue({
          viewerLogin: "mullion-bot[bot]",
          threads: [
            {
              id: "thread-contested",
              isResolved: false,
              comments: [
                {
                  author: "mullion-reviewer[bot]",
                  createdAt: "2026-08-20T10:00:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Fix this.",
                },
                {
                  author: "octocat",
                  createdAt: "2026-08-20T10:05:00Z",
                  path: "src/foo.ts",
                  line: 1,
                  body: "Disagree, this is intentional.",
                },
              ],
            },
          ],
          truncated: false,
        });
        mockResolveMullionReviewLogins.mockResolvedValue(
          new Set(["mullion-bot[bot]", "mullion-reviewer[bot]"]),
        );

        await reconcileTasks(app);

        expect(mockResolveReviewThread).not.toHaveBeenCalled();

        await app.close();
      });
    });

    it("records an inconclusive entry once the grace window elapses with still no findings file", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      // Deliberately no writeFindings call — the prompt now tells the agent
      // to ALWAYS write the file, so a missing one can no longer be read as
      // a confident "clean" review; it's reported as inconclusive instead,
      // once the review session has been alive long enough that the file
      // genuinely isn't coming.
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("inconclusive");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #754 — grace-elapsed alone must not be enough for a
    // session that's demonstrably still doing something. A genuinely slow
    // verification-gate run (severity "busy": working/compacting/subagent/
    // background) past 30 minutes is not a hung session; ingesting it as
    // inconclusive would permanently latch reviewFindingsIngestedSessionId
    // out from under a real verdict that's still coming — new-vs-main
    // behavior main never had (main never ingested a still-active session
    // at all) the exact dead end this PR exists to fix, just
    // relocated to the 30-minute mark.
    it("does NOT ingest past the grace window while the session is still actively working", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ activity: "working" })
                : fakeInfo(),
          }) as never,
      );
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toBeNull();
      expect(row.reviewFindingsIngestedSessionId).toBeNull();
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // The genuinely-stuck counterpart to the "still working" test above —
    // a session that's gone quiet (never latched "finished," not
    // "working"/"busy" either) past the grace window IS treated as
    // "nothing more is coming," but with wording that doesn't falsely
    // claim it "finished" (Hermes review, PR #754's other finding).
    it("ingests past the grace window with a third, non-'finished' wording when the session has gone quiet without ever finishing", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () => (String(id) === String(reviewSessionId) ? fakeInfo() : fakeInfo()),
          }) as never,
      );
      const { sessions } = await import("../../src/db/schema.js");
      await app.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(sessions.id, reviewSessionId));

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.reviewFindings).toContain("produced no findings file within the expected time");
      expect(row.reviewFindings).not.toContain("finished but wrote no findings file");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

      await app.close();
    });

    // The regression guard Change 1 exists for. Under the old "a findings
    // file means act on it" rule, always writing a file (this prompt's own
    // change) would have made a clean review indistinguishable from one
    // requesting changes — auto-returning and burning the task's one round
    // on a worker that has nothing to fix.
    it("does NOT auto-return stays in reviewing, when the review agent's JSON verdict is clean", async () => {
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
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("no issues found");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    it("auto-returns exactly once renders anchored findings, when the review agent's JSON verdict is changes-requested", async () => {
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
      expect(row.autoReturnRounds).toBe(1);
      expect(row.reviewFindings).toContain("cmd/branchdam/main_test.go:669");
      expect(row.reviewFindings).toContain("error return is unchecked");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).not.toBe(workerSessionId);

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

      // Task Master trial 220921 / PR #743's fix, PR 4 of 4 — "exited" is
      // now an unconditional usable signal (see `isUsableSignal`'s own doc
      // comment in task-reconciler.ts): a session that has genuinely exited
      // can't write anything more no matter how long is waited, so there's
      // nothing to gain by NOT ingesting it. This closes a pre-existing gap
      // this test used to pin the OPPOSITE of: a killed/crashed session
      // with no findings file used to leave the task stalled in "reviewing"
      // silently forever, with no comment ever posted at all.
      it("IS ingested as inconclusive when no findings file exists for a killed/crashed session — no more silent-forever stall", async () => {
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
        expect(row.reviewFindings).toContain("inconclusive");
        expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);

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
      expect(row.autoReturnRounds).toBe(0);
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
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("Possibly a partial review");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Coverage gap flagged in this PR's own review: every other "exited"
    // test above uses freeform text, which the tolerant fallback always
    // parses as changes-requested — none of them actually exercise a
    // genuine JSON `verdict: "clean"` on a non-"finished" session. Auto-
    // return is already gated on `derived.status === "finished"`
    // independent of the verdict, so this can't currently misfire — this
    // test pins that guarantee explicitly rather than leaving it implicit.
    it("ingests and comments a JSON 'clean' verdict from an exited review session does not auto-return", async () => {
      const app = await buildApp();
      const { taskId, workerSessionId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      writeFindings(
        app,
        taskId,
        0,
        JSON.stringify({ verdict: "clean", summary: "Looked clean right before the crash." }),
      );
      vi.spyOn(app.pty, "get").mockImplementation(
        (id: string) =>
          ({
            toInfo: () =>
              String(id) === String(reviewSessionId)
                ? fakeInfo({ endedReason: "process-exit", exitCode: 0 })
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
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("Looked clean right before the crash.");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      expect(row.sessionId).toBe(workerSessionId);

      await app.close();
    });

    // Hermes review, PR #580 — autoReturnRounds is spent in the same CAS that
    // flips status to in_progress, before the re-seed's own outcome is
    // known. A re-seed failure (terminate/spawn error, or a lost race —
    // see reseedTaskIfSessionExited's own doc comment) previously left the
    // task's one auto-return round permanently spent with nobody having
    // received the findings.
    //
    // Issue #973 — `status` now rolls back to "reviewing" alongside the
    // round, not just the round: task 258971 (PR #136) shows why leaving it
    // at "in_progress" (pointing at a `sessionId` this same call just failed
    // to replace) is dangerous, not just cosmetically wrong — a later,
    // unrelated session-death detection for that stale session flipped the
    // task straight to "failed" with a misleading reason.
    it("rolls back the spent auto-return round AND status when the re-seed itself fails", async () => {
      const app = await buildApp();
      const { taskId, reviewSessionId } = await claimIntoReviewing(app, "codex");
      const originalClaimedAt = (await getTask(app, taskId)).claimedAt;
      writeFindings(app, taskId, 0, "This should not cost the task its one round.");
      mockReseedTaskIfSessionExited.mockResolvedValueOnce(false);
      const warnSpy = vi.spyOn(app.log, "warn");
      const infoSpy = vi.spyOn(app.log, "info");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("reviewing");
      expect(row.autoReturnRounds).toBe(0);
      expect(row.reviewFindings).toContain("should not cost the task its one round");
      expect(row.reviewFindingsIngestedSessionId).toBe(reviewSessionId);
      // Fresh subagent review, PR #774 — a rolled-back attempt means no
      // auto-return round actually completed, so lastAutoReturnReason must
      // roll back to whatever it was before too (null, here), not linger
      // at "review" for a round that never happened.
      expect(row.lastAutoReturnReason).toBeNull();
      // Issue #1357 — a rolled-back attempt didn't actually start a new
      // worker spell either, so claimedAt must roll back too, not stay at
      // whatever autoReturnTask's own forward CAS bumped it to.
      expect(row.claimedAt?.getTime()).toBe(originalClaimedAt?.getTime());
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, rolledBack: true }),
        expect.stringContaining("rolled back the spent auto-return round"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, from: "in_progress", to: "reviewing", via: "reconcile" }),
        "task transition",
      );

      await app.close();
    });

    // Issue #973 — the CAS above (`status = "in_progress"`) is a real
    // semantic change, not just a tighter guard: this is the scenario it
    // exists for. task 258971's actual incident was a session-death
    // detection racing this exact rollback and flipping status to "failed"
    // out from under it. Simulates that race by mutating the row's status
    // out from under the rollback, inside the re-seed mock — mirroring
    // session-reconciler.ts's session-death handler landing between the
    // forward CAS and this rollback. The rollback CAS must lose (status
    // stays "failed", not resurrected to "reviewing") and must NOT spend
    // the round back onto a task nobody is tracking as "reviewing" anymore.
    it("does not resurrect a task a concurrent transition already moved off in_progress", async () => {
      const app = await buildApp();
      const { taskId } = await claimIntoReviewing(app, "codex");
      writeFindings(app, taskId, 0, "Findings that already got recorded.");
      mockReseedTaskIfSessionExited.mockImplementationOnce(async () => {
        app.db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, taskId)).run();
        return false;
      });
      const warnSpy = vi.spyOn(app.log, "warn");

      await reconcileTasks(app);

      const row = await getTask(app, taskId);
      expect(row.status).toBe("failed");
      expect(row.autoReturnRounds).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, rolledBack: false }),
        expect.stringContaining("rolled back the spent auto-return round"),
      );

      await app.close();
    });
  });
});
