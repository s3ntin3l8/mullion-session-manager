import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
import type { SessionInfo } from "./pty-manager.js";
// Reaches into routes/ from a service, same narrow exception task-claim.ts
// already documents — createSessionRecord is pure business logic filed
// under routes/ for historical colocation with POST /api/sessions.
import { createSessionRecord } from "../routes/sessions.js";
import { resolveBackend } from "./session-backend.js";
import { defaultDeriveStatusInfo, deriveSessionStatus } from "./session-status.js";
import { getStoredSettings } from "./settings.js";
import { resolveReviewAgentCommand, commandSupportsSeed } from "./task-agent-resolve.js";
import { syncTaskTransition } from "./task-github-sync.js";

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
 */
async function maybeSpawnReviewAgent(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<void> {
  if (!task.worktreePath) return;
  const reviewCommand = resolveReviewAgentCommand(app, {
    issueBody: task.body,
    projectDefaultReviewAgent: project.defaultReviewAgent,
  });
  if (reviewCommand === null) return;

  try {
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command: reviewCommand,
      cwd: task.worktreePath,
    });
    if (!result.ok) {
      app.log.warn(
        { taskId: task.id, reviewCommand, reason: result.reason },
        "task reconcile: review agent spawn failed",
      );
      return;
    }
    if (commandSupportsSeed(reviewCommand)) {
      const prompt = `Review this task's diff. You are not expected to make changes.\n\nTask: ${task.title}\n\n${task.body ?? ""}`;
      await resolveBackend(app, project.hostId).stashSeed(String(result.row.id), prompt);
    }
    app.db.update(tasks).set({ reviewSessionId: result.row.id }).where(eq(tasks.id, task.id)).run();
    app.log.info(
      { taskId: task.id, reviewSessionId: result.row.id, reviewCommand },
      "task reconcile: review agent spawned",
    );
  } catch (err) {
    app.log.warn({ err, taskId: task.id, reviewCommand }, "task reconcile: review agent threw");
  }
}

/**
 * Phase 6 Task Master (6.2/#215) — the automatic-transition half of the
 * state machine (task-state.ts owns the legal-transition table; this is
 * what actually walks it). Polls every task in "claimed"/"in_progress" and:
 *
 *  - flips it to "reviewing" once its worker session's derived status is
 *    "finished" (the same "turn is over" signal session-status.ts already
 *    derives — see deriveSessionStatus's own precedence rules; not a new
 *    heuristic).
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
 *  - on entering "reviewing" (either path above), spawns the configured
 *    review agent if one is set (see maybeSpawnReviewAgent above) —
 *    advisory only, in the worker's own worktree.
 *
 * Deliberately does NOT touch "reviewing" tasks — the roadmap's own
 * distinction: a reviewing task's session exiting doesn't fail it (the turn
 * is over, the work is committed on its branch, still promotable), so
 * reviewing tasks have no liveness dependency at all here. That's #282's
 * job for claimed/in_progress specifically (session-reconciler.ts), and
 * approve/reject's job for reviewing.
 *
 * Grouped one liveStatus call per host, same shape as
 * session-reconciler.ts's reconcileExitedSessions — a host that's merely
 * unreachable right now is skipped entirely for this pass, never treated as
 * "every task on it should fail."
 */
export async function reconcileTasks(app: FastifyInstance): Promise<void> {
  const rows = app.db
    .select({ task: tasks, session: sessions, project: projects })
    .from(tasks)
    .innerJoin(sessions, eq(tasks.sessionId, sessions.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, ["claimed", "in_progress"]))
    .all();
  if (rows.length === 0) return;

  const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
  const budgetMinutes = app.config.MULLION_TASK_BUDGET_MINUTES;

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
              app.log.info(
                { taskId: task.id, sessionId: session.id, budgetMinutes },
                "task reconcile: budget exceeded, flipped to failed",
              );
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
          if (derived.status === "finished") {
            const updated = app.db
              .update(tasks)
              .set({ status: "reviewing", startedAt: task.startedAt ?? now, reviewingAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              app.log.info(
                { taskId: task.id, from: "claimed", to: "reviewing" },
                "task reconcile: transitioned",
              );
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
              );
              await maybeSpawnReviewAgent(app, task, project);
            }
          } else if (derived.status !== "idle") {
            const updated = app.db
              .update(tasks)
              .set({ status: "in_progress", startedAt: now })
              .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
              .run();
            if (updated.changes > 0) {
              app.log.info(
                { taskId: task.id, from: "claimed", to: "in_progress" },
                "task reconcile: transitioned",
              );
              await syncTaskTransition(
                app,
                { ...task, status: "in_progress", startedAt: now },
                project,
                "in_progress",
              );
            }
          }
        } else if (task.status === "in_progress" && derived.status === "finished") {
          const updated = app.db
            .update(tasks)
            .set({ status: "reviewing", reviewingAt: now })
            .where(and(eq(tasks.id, task.id), eq(tasks.status, "in_progress")))
            .run();
          if (updated.changes > 0) {
            app.log.info(
              { taskId: task.id, from: "in_progress", to: "reviewing" },
              "task reconcile: transitioned",
            );
            await syncTaskTransition(
              app,
              { ...task, status: "reviewing", reviewingAt: now },
              project,
              "reviewing",
            );
            await maybeSpawnReviewAgent(app, task, project);
          }
        }
      }
    }),
  );
}
