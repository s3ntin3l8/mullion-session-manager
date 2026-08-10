import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// Reaches into routes/ from a service, same narrow exception task-claim.ts
// already documents — createSessionRecord is pure business logic filed
// under routes/ for historical colocation with POST /api/sessions.
import { createSessionRecord } from "../routes/sessions.js";
import { resolveBackend } from "./session-backend.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import {
  resolveReviewAgentCommand,
  commandSupportsSeed,
  resolveSeedDelivered,
} from "./task-agent-resolve.js";
import {
  syncTaskTransition,
  computeTaskDiffStat,
  postReviewFindingsComment,
} from "./task-github-sync.js";
import { recordTaskTransition } from "./task-state.js";
import {
  buildReviewPrompt,
  buildReviewFeedbackPrompt,
  taskReviewFindingsPath,
} from "./task-prompt.js";
import { openDraftPRForTask } from "./task-promote.js";
import { reseedTaskIfSessionExited } from "./task-reseed.js";

/**
 * Review agent decision (this phase's binding design) — when a project or
 * the task's own issue configures one, entering "reviewing" spawns it IN
 * THE WORKER'S OWN WORKTREE (no new worktree — the worker's turn is
 * already over by the time this runs, so there's no concurrent-write
 * race), seeded with a review-focused prompt. Advisory only: its output is
 * surfaced via `tasks.reviewSessionId` for the panel to render as a
 * distinct, clearly-labeled card — it has no path to approve, reject, or
 * otherwise transition the task itself. Best-effort with respect to the
 * reviewing transition that already committed: a spawn failure here is
 * logged and swallowed, never rolled back into the (already-real) status
 * change, matching the "advisory, not required for the loop's
 * correctness" framing.
 *
 * #487 — unlike the worker claim (task-claim.ts), which refuses outright
 * when its resolved agent's adapter can't receive a seed (a correctness bug
 * for unattended work), a review agent is always spawned regardless: it's
 * advisory, and refusing to spawn it at all would remove the one artifact
 * (the empty session) a human could notice something's wrong from. Instead
 * this warns (matching the worker path's log posture) and records
 * `reviewSeedDelivered: false` on the task row, so a seedless review
 * session is visible without grepping logs — see the column's own doc
 * comment in schema.ts.
 */
async function maybeSpawnReviewAgent(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  skipPermissions: boolean,
): Promise<void> {
  if (!task.worktreePath) return;
  const reviewCommand = resolveReviewAgentCommand(app, {
    issueBody: task.body,
    projectDefaultReviewAgent: project.defaultReviewAgent,
  });
  if (reviewCommand === null) return;

  try {
    // Delivered as argv, not stashSeed — same fix as task-claim.ts's own
    // worker spawns: SessionStart's `additionalContext` (stashSeed's only
    // consumer) injects context but never submits a turn, which would leave
    // an unattended review agent idling exactly like an unattended worker
    // did before this fix.
    const seedCapable = commandSupportsSeed(reviewCommand);
    // task.reviewRounds is the round THIS review belongs to: 0 for the
    // first review, 1 for the one spawned after an auto-returned round —
    // see taskReviewFindingsPath's own doc comment for why round-suffixing
    // matters here.
    const findingsPath = taskReviewFindingsPath(
      path.dirname(app.pty.hookSocketPath),
      task.id,
      task.reviewRounds,
    );
    const prompt = buildReviewPrompt({ task, worktreePath: task.worktreePath, findingsPath });
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command: reviewCommand,
      cwd: task.worktreePath,
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions,
    });
    if (!result.ok) {
      app.log.warn(
        { taskId: task.id, reviewCommand, reason: result.reason },
        "task reconcile: review agent spawn failed",
      );
      return;
    }
    // Same version-skew guard as task-claim.ts's own — see
    // resolveSeedDelivered's doc comment.
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      project.hostId,
      result.initialPromptApplied,
    );
    if (!seedDelivered) {
      app.log.warn(
        { taskId: task.id, reviewCommand, hostId: project.hostId, seedCapable },
        seedCapable
          ? "task reconcile: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew"
          : "task reconcile: review agent's adapter can't receive an initial prompt — spawning with no instructions",
      );
    }
    app.db
      .update(tasks)
      .set({ reviewSessionId: result.row.id, reviewSeedDelivered: seedDelivered })
      .where(eq(tasks.id, task.id))
      .run();
    app.log.info(
      { taskId: task.id, reviewSessionId: result.row.id, reviewCommand, seedDelivered },
      "task reconcile: review agent spawned",
    );
  } catch (err) {
    app.log.warn({ err, taskId: task.id, reviewCommand }, "task reconcile: review agent threw");
  }
}

/**
 * Opens (or, on a second "-> reviewing", pushes new commits to) a draft PR
 * for the task — best-effort, mirroring maybeSpawnReviewAgent's own posture
 * exactly: a failure here is logged and swallowed, never rolled back into
 * the reviewing transition that already committed. task-promote.ts's
 * openDraftPRForTask already records tasks.githubSyncError for every
 * failure reason that's an actual sync problem (and deliberately doesn't
 * for the ones that aren't — remote-not-supported, dirty-tree, an
 * undeterminable base branch), so this only needs to log, not duplicate
 * that bookkeeping.
 */
async function maybeOpenDraftPR(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  const result = await openDraftPRForTask(app, task, project);
  if (!result.ok) {
    // remote-not-supported/dirty-tree/no-worktree are ordinary, expected
    // outcomes here (a task barely out of its worker's last turn very often
    // has an untracked scratch file, or lives on a remote host) — logged at
    // info, not warn, so this doesn't read as an operational alert on every
    // routine skip.
    app.log.info(
      { taskId: task.id, reason: result.reason, detail: result.detail },
      "task reconcile: draft PR not opened",
    );
    return;
  }
  app.db
    .update(tasks)
    .set({ prUrl: result.prUrl, prNumber: result.prNumber })
    .where(eq(tasks.id, task.id))
    .run();
  app.log.info({ taskId: task.id, prUrl: result.prUrl }, "task reconcile: draft PR opened");
}

/**
 * The review-findings loop — a SEPARATE poll from the claimed/in_progress
 * one below (see reconcileTasks's own doc comment for why a "reviewing"
 * task otherwise has no liveness/budget dependency here at all: this is the
 * one narrow exception, scoped to reading a finished review session's
 * output, never to session death or the time budget).
 *
 * For every "reviewing" task with a review session whose derived status is
 * "finished" AND whose output hasn't already been processed
 * (`reviewFindingsIngestedSessionId !== reviewSessionId` — see that
 * column's own doc comment in schema.ts for why this check exists: a task
 * can sit "reviewing" with zero findings for a long time, polled every
 * tick, and without this marker it would be re-ingested and re-commented
 * forever):
 *
 *  - reads the round-suffixed findings file the review prompt told the
 *    agent to write to (`taskReviewFindingsPath`, task-prompt.ts) — a
 *    missing file means no findings, not an error; the prompt tells the
 *    agent not to create one when it has none.
 *  - posts what it found (or a "no findings" note either way — this is
 *    exactly the visibility gap the review-findings loop exists to close:
 *    previously a finished review was invisible outside the session's own
 *    terminal) as one comment on the task's PR, falling back to its linked
 *    issue (`postReviewFindingsComment`, task-github-sync.ts).
 *  - appends it to `tasks.reviewFindings` under a "## Round N" header —
 *    never replaces, so an earlier round survives a later one.
 *  - if the findings are non-empty AND this task hasn't already used its
 *    one auto-return (`reviewRounds < 1`) AND Task Master is enabled: flips
 *    the task back to "in_progress", increments `reviewRounds` (a
 *    compare-and-swap write, same as every other transition in this file —
 *    a concurrent approve/reject/give-up simply wins the race and this
 *    loop no-ops), and re-seeds the worker
 *    (`reseedTaskIfSessionExited`, task-reseed.ts, shared with reject's own
 *    re-seed but called with `force: true` here — see that function's own
 *    doc comment on why: nobody is watching to type into a still-alive
 *    worker session the way a human reviewing a reject is) with the
 *    findings as its prompt.
 *
 * Gated on `resolveTaskMasterConfig(app).enabled` for the auto-return step
 * only (same reasoning as the claimed/in_progress loop's own "enabled"
 * gates below) — reading and posting the findings themselves is pure
 * visibility, ungated, so a disabled install still surfaces "review
 * finished" instead of going silent.
 */
function unlinkFindingsFileIfPresent(
  app: FastifyInstance,
  taskId: number,
  findingsPath: string,
): void {
  try {
    if (existsSync(findingsPath)) unlinkSync(findingsPath);
  } catch (err) {
    app.log.warn(
      { err, taskId, findingsPath },
      "task reconcile: failed to remove an ingested review findings file",
    );
  }
}

async function processReviewingTasks(app: FastifyInstance): Promise<void> {
  const allRows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.reviewSessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.status, "reviewing"))
    .all();
  if (allRows.length === 0) return;

  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  const sessionsDir = path.dirname(app.pty.hookSocketPath);

  const byHost = new Map<string, typeof allRows>();
  for (const row of allRows) {
    // Hermes review, PR #576 — the findings file the review prompt tells the
    // agent to write is read from THIS process's own local sessionsDir
    // below; a remote-hosted review agent's file lands on the REMOTE host's
    // filesystem instead, which SessionBackend has no generic file-read for.
    // Reading local-only wouldn't error — it would just find nothing and
    // falsely conclude "no findings", ingesting and commenting a lie. Skip
    // entirely rather than mis-ingest, same "not supported yet" posture
    // task-promote.ts's isPromotionSupported already takes for remote-hosted
    // PR promotion.
    if (row.project.hostId !== LOCAL_HOST_ID) {
      app.log.info(
        { taskId: row.task.id, hostId: row.project.hostId },
        "task reconcile: skipping review-findings ingestion for a remote-hosted task (not supported yet)",
      );
      continue;
    }
    const group = byHost.get(row.project.hostId) ?? [];
    group.push(row);
    byHost.set(row.project.hostId, group);
  }
  if (byHost.size === 0) return;

  await Promise.all(
    [...byHost.entries()].map(async ([hostId, hostRows]) => {
      const backend = resolveBackend(app, hostId);
      let liveMap: Record<string, SessionInfo | null>;
      try {
        liveMap = await backend.liveStatus(
          hostRows.map((r) => String(r.session.id)),
          idleThresholdMs,
        );
      } catch (err) {
        app.log.warn(
          { hostId, err },
          "task reconcile: host unreachable, skipping its review sessions",
        );
        return;
      }

      for (const row of hostRows) {
        const { task, session, project } = row;

        if (task.reviewFindingsIngestedSessionId === task.reviewSessionId) continue;

        const info = liveMap[String(session.id)];
        if (info === undefined) continue;
        const derived = deriveSessionStatus({
          dbStatus: session.status,
          info: defaultDeriveStatusInfo(info),
        });

        const findingsPath = taskReviewFindingsPath(sessionsDir, task.id, task.reviewRounds);
        let findings: string | null = null;
        try {
          if (existsSync(findingsPath)) {
            const content = readFileSync(findingsPath, "utf8").trim();
            if (content.length > 0) findings = content;
          }
        } catch (err) {
          app.log.warn(
            { err, taskId: task.id, findingsPath },
            "task reconcile: failed to read review findings file",
          );
        }

        // Hermes review, PR #576 — a review agent that never derives
        // "finished" (exits right after its turn instead of staying running,
        // unlike the worker preamble's own instruction — buildReviewPrompt
        // now tells it to as well, but this doesn't rely on compliance) was
        // previously skipped forever: no comment, no auto-return, silent.
        // Accept "exited" too, but ONLY when a findings file actually
        // exists — a session killed by a human, or one that crashed
        // mid-review, also derives "exited", and would otherwise get
        // ingested as a false "Review complete — no findings." permanently
        // marked processed.
        const isUsableSignal =
          derived.status === "finished" || (derived.status === "exited" && findings !== null);
        if (!isUsableSignal) continue;

        const roundLabel = `## Round ${task.reviewRounds + 1}`;
        const commentBody = findings
          ? `${roundLabel}\n\n${findings}`
          : `${roundLabel}\n\nReview complete — no findings.`;

        const appendedFindings = task.reviewFindings
          ? `${task.reviewFindings}\n\n${commentBody}`
          : commentBody;

        // Hermes review, PR #576 — a non-seed-capable worker adapter (e.g.
        // OpenCode) can't receive the findings as an initial prompt at all
        // (reseedTaskIfSessionExited delivers argv-only, same as every other
        // Task Master spawn). Auto-returning anyway would burn the task's
        // one round, flip it to in_progress, and spawn a fresh session with
        // NO instructions — one that never ends a turn, so the task just
        // rides its budget out and fails. Recording + commenting the
        // findings still happens; only the auto-return (and the round it
        // would spend) is skipped, leaving a human to act on what's now
        // visible on the task and the PR.
        const shouldAutoReturn =
          findings !== null &&
          task.reviewRounds < 1 &&
          resolvedTaskMaster.enabled &&
          task.worktreePath !== null &&
          task.agentCommand !== null &&
          commandSupportsSeed(task.agentCommand);

        // Hermes review, PR #576 — record BEFORE posting the PR comment
        // (previously the reverse), and CAS on `status = "reviewing"` even
        // for the non-transitioning write: a concurrent approve/reject/
        // give-up racing this same tick should win outright — this loop
        // then does neither the DB write nor the PR comment for a decision
        // the task no longer reflects, rather than a comment landing with
        // no matching DB write behind it.
        const updated = app.db
          .update(tasks)
          .set(
            shouldAutoReturn
              ? {
                  status: "in_progress",
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
                  reviewRounds: task.reviewRounds + 1,
                }
              : {
                  reviewFindings: appendedFindings,
                  reviewFindingsIngestedSessionId: task.reviewSessionId,
                },
          )
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "reviewing")))
          .run();
        // Lost the race — the findings file is still stale for whatever
        // reconcile this task next (a rejected task keeps the same
        // reviewRounds, so its next review reuses this exact round-suffixed
        // path), so unlink it here too, before giving up on this row.
        if (updated.changes === 0) {
          unlinkFindingsFileIfPresent(app, task.id, findingsPath);
          continue;
        }

        // The DB write above is now durable — the file has nothing left to
        // offer a later reconcile pass, and leaving it in place is exactly
        // what would cause a same-round re-review (reject keeps reviewRounds
        // unchanged) to re-ingest THIS round's content as if it were fresh.
        unlinkFindingsFileIfPresent(app, task.id, findingsPath);
        await postReviewFindingsComment(app, task, project, commentBody);

        if (!shouldAutoReturn) continue;

        recordTaskTransition(app, {
          taskId: task.id,
          projectId: project.id,
          from: "reviewing",
          to: "in_progress",
          via: "review-feedback",
        });

        const prompt = buildReviewFeedbackPrompt({
          task,
          branchName: task.branchName ?? `mullion/task-${task.id}`,
          worktreePath: task.worktreePath!,
          budgetMinutes: resolvedTaskMaster.budgetMinutes,
          // Nobody is watching an automated review-feedback round.
          auto: true,
          findings: findings!,
        });
        // force: true — unlike reject's own re-seed, nobody is watching to
        // type into a still-alive worker (the worker's own instructions
        // tell it to stay running after finishing its turn, so "still
        // alive but idle" is the COMMON case here, not an edge case). See
        // reseedTaskIfSessionExited's own doc comment.
        await reseedTaskIfSessionExited(app, task, project, prompt, "task review-feedback", {
          force: true,
        });
      }
    }),
  );
}

/**
 * Phase 6 Task Master (6.2/#215) — the automatic-transition half of the
 * state machine (task-state.ts owns the legal-transition table; this is
 * what actually walks it). Polls every task in "claimed"/"in_progress" and:
 *
 *  - flips it to "reviewing" once its worker session's derived status is
 *    "finished" (the same "turn is over" signal session-status.ts already
 *    derives — see deriveSessionStatus's own precedence rules; not a new
 *    heuristic) — but only while Task Master is enabled. Hermes review, PR
 *    #480 (second pass): approve/reject are the only routes that can
 *    resolve a "reviewing" task, and both are gated on the same "enabled"
 *    flag, so entering "reviewing" while disabled would strand the task
 *    with no way out short of re-enabling. A finished session while
 *    disabled is left in claimed/in_progress instead — still reachable by
 *    the budget force-fail below, and it transitions normally on the next
 *    tick once re-enabled.
 *  - flips "claimed" to "in_progress" once the session shows ANY signal
 *    beyond pure idle silence (derived.status !== "idle") — i.e. the agent
 *    has started doing something. A task whose very first observed signal
 *    is already "finished" skips straight there (task-state.ts's
 *    claimed -> reviewing edge) rather than forcing a synthetic
 *    intermediate write for a tick nothing was actually seen at.
 *  - flips it to "failed" (and terminates the session) once
 *    MULLION_TASK_BUDGET_MINUTES has elapsed since claimedAt, regardless of
 *    what the session is doing — the budget is a hard backstop, not a
 *    negotiation with the agent's own judgment.
 *  - on entering "reviewing" (either path above), opens a draft PR
 *    (maybeOpenDraftPR above — best-effort, never blocks the transition)
 *    and spawns the configured review agent if one is set (see
 *    maybeSpawnReviewAgent above) — advisory only, in the worker's own
 *    worktree.
 *
 * Does NOT otherwise touch "reviewing" tasks — the roadmap's own
 * distinction: a reviewing task's session exiting doesn't fail it (the turn
 * is over, the work is committed on its branch, still promotable), so
 * reviewing tasks have no liveness/budget dependency here. That's #282's
 * job for claimed/in_progress specifically (session-reconciler.ts), and
 * approve/reject/give-up's job for reviewing. `processReviewingTasks` above
 * is the one narrow exception — it reads a finished REVIEW session's
 * output, never the worker session's, and never fails or terminates
 * anything.
 *
 * Grouped one liveStatus call per host, same shape as
 * session-reconciler.ts's reconcileExitedSessions — a host that's merely
 * unreachable right now is skipped entirely for this pass, never treated as
 * "every task on it should fail."
 */
export async function reconcileTasks(app: FastifyInstance): Promise<void> {
  // Independent of the claimed/in_progress pass below — must not sit behind
  // its own `rows.length === 0` early return, or a reviewing task's
  // findings would never be processed on a tick with no claimed/in_progress
  // work at all.
  await processReviewingTasks(app);

  const rows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, ["claimed", "in_progress"]))
    .all();
  if (rows.length === 0) return;

  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  // Settings-backed override of MULLION_TASK_BUDGET_MINUTES (Task Master
  // Settings UI follow-up) — see task-config.ts's doc comment. Resolved
  // once per pass and reused below for maybeSpawnReviewAgent's own gate.
  const resolvedTaskMaster = resolveTaskMasterConfig(app);
  const budgetMinutes = resolvedTaskMaster.budgetMinutes;

  const byHost = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byHost.get(row.project.hostId) ?? [];
    group.push(row);
    byHost.set(row.project.hostId, group);
  }

  await Promise.all(
    [...byHost.entries()].map(async ([hostId, hostRows]) => {
      const backend = resolveBackend(app, hostId);
      let liveMap: Record<string, SessionInfo | null>;
      try {
        liveMap = await backend.liveStatus(
          hostRows.map((r) => String(r.session.id)),
          idleThresholdMs,
        );
      } catch (err) {
        app.log.warn({ hostId, err }, "task reconcile: host unreachable, skipping its tasks");
        return;
      }

      for (const row of hostRows) {
        const { task, session, project } = row;
        const now = new Date();

        // Budget check first — an expired task is failed regardless of
        // what its session is currently doing. 0 = unlimited (opt out).
        if (budgetMinutes > 0) {
          const deadline = new Date(task.claimedAt!.getTime() + budgetMinutes * 60_000);
          if (now > deadline) {
            const updated = app.db
              .update(tasks)
              .set({
                status: "failed",
                failureReason: `budget exceeded after ${budgetMinutes} minutes`,
                completedAt: now,
              })
              .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["claimed", "in_progress"])))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                // Narrowed by the WHERE clause above (`inArray(..., ["claimed", "in_progress"])`).
                from: task.status as "claimed" | "in_progress",
                to: "failed",
                via: "budget-exceeded",
                context: { sessionId: session.id, budgetMinutes },
              });
              await backend.terminate(String(session.id)).catch((err) => {
                app.log.warn(
                  { err, taskId: task.id, sessionId: session.id },
                  "task reconcile: failed to terminate over-budget session",
                );
              });
              await syncTaskTransition(
                app,
                {
                  ...task,
                  status: "failed",
                  failureReason: `budget exceeded after ${budgetMinutes} minutes`,
                  completedAt: now,
                },
                project,
                "failed",
              );
              // 6.8/#283 — best-effort; a dirty tree is left in place for
              // inspection rather than retried forever (see
              // removeWorktreeIfClean's own doc comment on why "dirty" is
              // the only real refusal condition it has).
              if (task.worktreePath) {
                await backend.removeWorktreeIfClean(task.worktreePath, project.cwd).catch((err) => {
                  app.log.warn(
                    { err, taskId: task.id, worktreePath: task.worktreePath },
                    "task reconcile: removeWorktreeIfClean threw after budget failure",
                  );
                });
              }
            }
            continue;
          }
        }

        // A key this reachable host's response omitted is "unknown," not
        // "idle" — same posture as session-reconciler.ts's own
        // "alive === undefined -> skip, don't guess" rule.
        const info = liveMap[String(session.id)];
        if (info === undefined) continue;

        const derived = deriveSessionStatus({
          dbStatus: session.status,
          info: defaultDeriveStatusInfo(info),
        });

        // The session already exited — #282's hook in
        // session-reconciler.ts owns flipping this task to failed (it runs
        // against the session row directly, and needs to coordinate with
        // worktree cleanup); this pass must not race it with a conflicting
        // write, so it just leaves an exited-session task alone.
        if (derived.status === "exited") continue;

        if (task.status === "claimed") {
          // Hermes review, PR #480 (second pass) — entering "reviewing" is
          // gated on "enabled" entirely, not just the review-agent spawn
          // below. approve/reject are BOTH gated on the same flag (they
          // write real GitHub state — PR creation, re-seeding a session),
          // so a task that reached "reviewing" while disabled would be
          // stuck there with no way to resolve it until re-enabled. Leaving
          // it in claimed/in_progress instead keeps it reachable by the
          // still-ungated budget force-fail below, and it picks up the
          // normal reviewing transition on the next tick once re-enabled.
          if (derived.status === "finished" && resolvedTaskMaster.enabled) {
            const updated = app.db
              .update(tasks)
              .set({ status: "reviewing", startedAt: task.startedAt ?? now, reviewingAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "claimed",
                to: "reviewing",
                via: "reconcile",
              });
              await syncTaskTransition(
                app,
                {
                  ...task,
                  status: "reviewing",
                  startedAt: task.startedAt ?? now,
                  reviewingAt: now,
                },
                project,
                "reviewing",
                { diffStat: await computeTaskDiffStat(task) },
              );
              await maybeOpenDraftPR(app, task, project);
              await maybeSpawnReviewAgent(app, task, project, resolvedTaskMaster.skipPermissions);
            }
          } else if (derived.status !== "idle" && derived.status !== "finished") {
            const updated = app.db
              .update(tasks)
              .set({ status: "in_progress", startedAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              recordTaskTransition(app, {
                taskId: task.id,
                projectId: project.id,
                from: "claimed",
                to: "in_progress",
                via: "reconcile",
              });
              await syncTaskTransition(
                app,
                { ...task, status: "in_progress", startedAt: now },
                project,
                "in_progress",
              );
            }
          }
        } else if (
          task.status === "in_progress" &&
          derived.status === "finished" &&
          resolvedTaskMaster.enabled
        ) {
          // See the matching gate/comment on the claimed -> reviewing
          // branch above — same "don't strand it in reviewing" reasoning.
          const updated = app.db
            .update(tasks)
            .set({ status: "reviewing", reviewingAt: now })
            .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
            .run();
          if (updated.changes > 0) {
            recordTaskTransition(app, {
              taskId: task.id,
              projectId: project.id,
              from: "in_progress",
              to: "reviewing",
              via: "reconcile",
            });
            await syncTaskTransition(
              app,
              { ...task, status: "reviewing", reviewingAt: now },
              project,
              "reviewing",
              { diffStat: await computeTaskDiffStat(task) },
            );
            await maybeOpenDraftPR(app, task, project);
            await maybeSpawnReviewAgent(app, task, project, resolvedTaskMaster.skipPermissions);
          }
        }
      }
    }),
  );
}
