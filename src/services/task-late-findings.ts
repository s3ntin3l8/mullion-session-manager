import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, tasks, type sessions } from "../db/schema.js";
import { stopHermesRunQuietly } from "./hermes-task-review.js";
import { killSession } from "./session-lifecycle.js";
import { CLEARED_REVIEW_RUN, hasReviewHandle } from "./task-review-handle.js";
import { resolveMaxAutoReturnRounds } from "./task-auto-return-rounds.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import type { SessionInfo } from "./pty-manager.js";
import type { SessionBackend } from "./session-backend.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { parseReviewFindings, type ParsedReviewFindings } from "./task-prompt.js";

// Log-once memory for a late findings file that is not a structured verdict,
// keyed by task id -> content hash, so a repeat tick neither re-logs nor
// re-parses it. In-memory only: after a restart the file is evaluated (and
// ignored) once more, which posts nothing.
const ignoredLateFindings = new Map<number, string>();

/**
 * A review session whose findings were ingested as `inconclusive` (it died or
 * stalled before writing anything) can still write a valid file later — a
 * human re-prompts it once its quota recovers. The ingest latch means nothing
 * would ever read it, so while the task is `reviewing` with that inconclusive
 * verdict still latched against the CURRENT review session, look for the file
 * again and, when it holds a structured verdict, hand it to `ingest` (the
 * reconciler's normal `ingestReviewOutcome` path), replacing the verdict.
 *
 * Why the file's existence stands in for "newer than the inconclusive
 * verdict": every ingest unlinks the round's findings file, and a file that
 * was present but unstructured is not ingested here. So any structured file
 * now present was written after that ingest. The backend exposes no mtime;
 * the same `readTaskReviewFindings` is used, so a remote host works too.
 * Freeform text is deliberately ignored, unlike the normal path: a
 * half-written or stray file must not overturn the verdict. A re-arm clears
 * the review handle so this stops matching, and `ingest` is a CAS on the
 * verdict still being `inconclusive` for that session.
 */
export async function ingestLateFindings(
  app: FastifyInstance,
  input: {
    task: typeof tasks.$inferSelect;
    session: typeof sessions.$inferSelect;
    info: SessionInfo | null;
    backend: SessionBackend;
    ingest: (parsed: ParsedReviewFindings, finished: boolean) => Promise<void>;
  },
): Promise<void> {
  const { task, session, info, backend } = input;
  if (task.lastReviewVerdict !== "inconclusive") return;
  if (task.lastReviewVerdictAt === null) return;
  if (typeof task.reviewRunId === "string") return; // a Hermes run, not a session
  if (task.reviewSessionId !== session.id) return;
  if (task.reviewFindingsIngestedSessionId !== task.reviewSessionId) return;

  let findings: string | null;
  try {
    findings = await backend.readTaskReviewFindings(task.id, task.autoReturnRounds);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id },
      "task reconcile: failed to re-read late review findings — retrying next tick",
    );
    return;
  }
  if (findings === null) {
    ignoredLateFindings.delete(task.id);
    return;
  }
  const hash = createHash("sha256").update(findings).digest("hex");
  if (ignoredLateFindings.get(task.id) === hash) return;
  const parsed = parseReviewFindings(findings);
  if (!parsed.structured) {
    ignoredLateFindings.set(task.id, hash);
    app.log.warn(
      { taskId: task.id },
      "task reconcile: late review findings file is not a structured verdict — ignoring",
    );
    return;
  }
  // Same readiness rule as the normal path for a real file: the reviewer has
  // finished its turn (or exited), so the file is complete.
  const derived = deriveSessionStatus({
    dbStatus: session.status,
    info: defaultDeriveStatusInfo(info),
  });
  if (derived.status !== "finished" && derived.status !== "exited") return;

  ignoredLateFindings.delete(task.id);
  await input.ingest(parsed, derived.status === "finished");
}

// Task 409707 — a review agent can stall silently: no reported
// `errorState`/`errorDetail` at all (the adapter gap this issue tracks — a
// REPORTED `rate_limit` is already covered by `isRateLimitGraceActive`/
// `isTaskInRateLimitGrace` above), just `idle` with no turn-end payload.
// `processReviewingTasks` above correctly ingests that as
// `lastReviewVerdict = "inconclusive"` once `REVIEW_FINDINGS_GRACE_MS`
// elapses, but `reviewFindingsIngestedSessionId` then latches permanently
// against that same stalled session (see that column's own doc comment in
// schema.ts) — re-prompting it after quota/whatever recovers has no effect,
// since nothing ever reads its output again. Unlike a capped task
// (`reannounceCappedTasksAfterHumanPush` above), an inconclusive verdict
// never calls `autoReturnTask` (`wantsAutoReturn` requires
// `verdict === "changes-requested"`), so `autoReturnRounds` never reaches
// the project's cap on its own — a task stuck on repeated silent review
// stalls would otherwise never become "capped and announced" either, and so
// never picked up by that sweep. This is the sole automatic recovery path
// for exactly that case.
const INCONCLUSIVE_REVIEW_REARM_GRACE_MS = 60 * 60_000;

// See `tasks.inconclusiveReviewRearmCount`'s own doc comment (schema.ts) for
// why this can't reuse `autoReturnRounds`/`resolveMaxAutoReturnRounds` as its
// bound. Deliberately small and fixed, not project-configurable like the
// round cap — this sweep exists to survive one bad adapter tick, not to
// negotiate indefinitely with a genuinely broken reviewer.
const MAX_AUTOMATIC_INCONCLUSIVE_REARMS = 1;

export async function reannounceInconclusiveReviewsAfterGrace(app: FastifyInstance): Promise<void> {
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  if (!resolvedTaskMaster.enabled) return;

  const now = Date.now();
  const rows = app.db
    .select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.status, "reviewing"),
        eq(tasks.lastReviewVerdict, "inconclusive"),
        // Nothing stalled left to re-arm otherwise — also keeps this bound
        // an "attempts," not "ticks": right after a successful re-arm the
        // review handle is null again until the next spawn or dispatch, so a
        // second tick landing before that can't double-fire even at a higher
        // MAX than 1. The review is either a session or an external run (#2369);
        // either pair must be complete — a handle AND its ingested marker.
        or(
          and(isNotNull(tasks.reviewFindingsIngestedSessionId), isNotNull(tasks.reviewSessionId)),
          and(isNotNull(tasks.reviewRunIngestedId), isNotNull(tasks.reviewRunId)),
        ),
        // A capped, announced task is reannounceCappedTasksAfterHumanPush's
        // own territory — it requires an actual human push, not a timer;
        // excluded here so the two sweeps never both touch the same row.
        isNull(tasks.autoReturnCapAnnouncedAt),
        lt(tasks.inconclusiveReviewRearmCount, MAX_AUTOMATIC_INCONCLUSIVE_REARMS),
      ),
    )
    .all();
  if (rows.length === 0) return;

  for (const { task, project } of rows) {
    if (!hasReviewHandle(task)) continue; // guaranteed by the query above
    if (task.lastReviewVerdictAt === null) continue;
    if (now - task.lastReviewVerdictAt.getTime() < INCONCLUSIVE_REVIEW_REARM_GRACE_MS) continue;
    // Defensive, independent of the query's own isNull(autoReturnCapAnnouncedAt)
    // filter above — the round budget is the scope's own second signal for
    // "still has life left," worth checking directly rather than trusting a
    // single derived flag.
    if (
      task.autoReturnRounds >=
      resolveMaxAutoReturnRounds(project, resolvedTaskMaster.maxAutoReturnRounds)
    )
      continue;

    // Whichever handle the stalled review has — one of the two is null.
    const staleReviewSessionId = task.reviewSessionId;
    const staleReviewRunId = task.reviewRunId;
    const updated = app.db
      .update(tasks)
      .set({
        reviewSessionId: null,
        reviewFindingsIngestedSessionId: null,
        reviewSeedDelivered: null,
        reviewSpawnClaimedAt: null,
        ...CLEARED_REVIEW_RUN,
        inconclusiveReviewRearmCount: task.inconclusiveReviewRearmCount + 1,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.status, "reviewing"),
          eq(tasks.lastReviewVerdict, "inconclusive"),
          staleReviewSessionId === null
            ? isNull(tasks.reviewSessionId)
            : eq(tasks.reviewSessionId, staleReviewSessionId),
          staleReviewRunId === null
            ? isNull(tasks.reviewRunId)
            : eq(tasks.reviewRunId, staleReviewRunId),
          eq(tasks.inconclusiveReviewRearmCount, task.inconclusiveReviewRearmCount),
        ),
      )
      .run();
    if (updated.changes === 0) continue;

    // Same reasoning as the in_progress -> reviewing transition's own kill
    // call (#772) — the write above just nulled reviewSessionId, orphaning
    // the stalled session with no task row pointing at it anymore. Killed
    // AFTER the CAS succeeds, not before: a lost race against a concurrent
    // approve/reject/give-up must not leave a session killed out from under
    // a row this sweep no longer actually touched.
    stopHermesRunQuietly(app, staleReviewRunId);
    if (staleReviewSessionId !== null) {
      void killSession(app, staleReviewSessionId).catch((err) => {
        app.log.warn(
          { err, taskId: task.id, reviewSessionId: staleReviewSessionId },
          "task reconcile: failed to kill the stalled review session",
        );
      });
    }
  }
}
