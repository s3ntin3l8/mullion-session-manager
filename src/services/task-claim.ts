import { and, eq, inArray, isNull } from "drizzle-orm";
import { proposalBlocksRun } from "./task-proposal.js";
import type { FastifyInstance } from "fastify";
import { projects, sessions, tasks } from "../db/schema.js";
// createSessionRecord/withLiveStatus are pure business logic, filed under
// services/ (session-lifecycle.ts/session-live-info.ts) precisely so a
// service can reuse them directly rather than reaching into routes/ — see
// those files' own doc comments for the createSessionRecord/killSession and
// buildLiveInfo/withLiveInfo/withLiveStatus split.
import {
  describePreparing,
  startMaterialize,
  takeFailedMaterialize,
} from "./checkout-materialize.js";
import { createSessionRecord, killSession } from "./session-lifecycle.js";
import { CLEARED_NEEDS_HUMAN } from "./task-merge-human.js";
import { modelFamily, resolveTaskModelPatch } from "./task-model-patch.js";
import {
  resolveSessionHostId,
  resolveTaskWorkerHost,
  taskWorkerSessionName,
  withLiveStatus,
} from "./session-live-info.js";
import {
  describeTarget,
  parseHostCwds,
  projectCwdOnHost,
  resolvePlacement,
  resolveTargetHost,
  type PlacementDecision,
} from "./placement.js";
import {
  describeRequirementSource,
  parsePlacementRequirement,
  serializePlacementRequirement,
} from "./task-placement-resolve.js";
import { decideRetryHost } from "./task-retry-host.js";
import { holdRetry } from "./task-retry-hold.js";
import { failQueuedTask } from "./task-queue-fail.js";

// Re-exported: task-dispatch.ts (the give-up) and task-retry.ts (the
// no-branch refusal) call it through task-claim.ts's own surface.
export { failQueuedTask } from "./task-queue-fail.js";
import {
  resolveBackend,
  resolveSessionsDirWithFallback,
  type SessionBackend,
  unknownOutcomeMessage,
} from "./session-backend.js";
import { HostRequestError } from "./remote-host-client.js";
import { clearOrphanedCheckout, removeCheckoutIfClean } from "./checkout-removal.js";
import { ensureRemoteHostProtocols } from "./host-agents.js";
import { resolveHostBaseRef, resolveRepoRef } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { dependencyGate, parseBlockedBy, refreshTaskBlockers } from "./task-dependencies.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { deriveTaskBranchName, deriveWorktreePath } from "./git-worktree.js";
import { CONCURRENCY_CAPPED_STATUSES, recordTaskTransition } from "./task-state.js";
import {
  resolveAgentCommand,
  resolveReviewAgentCommand,
  commandSupportsSeed,
  resolveSeedDelivered,
  workerAgentPinned,
} from "./task-agent-resolve.js";
import { resolveOpenCodeModel, resolveWorkerSpawnModels } from "./task-model-resolve.js";
import { commandAgentBin, commandIsOpencode } from "./hook-adapters/index.js";
import { codexTrustHold, CODEX_TRUST_HOLD_DETAIL } from "./task-codex-trust-hold.js";
export { CODEX_TRUST_HOLD_DETAIL };
import { syncTaskTransition } from "./task-github-sync.js";
import { broadcastTaskEvent } from "./task-events.js";
import { buildWorkerPrompt, taskCommitTitlePath } from "./task-prompt.js";
import { resolveWorkerDelegation } from "./task-delegation.js";
import { resolveTaskIssueContextSafe } from "./task-issue-context.js";
import { claimTargets, quarantinedTarget } from "./runway-quarantine.js";

// Shared by dispatchClaimedTask's and dispatchQueuedRetry's identical "cap" branches (Hermes
// review, PR #765) — the limit shown here is always the RESOLVED value
// (env default, possibly overridden by Settings → Task Master; see
// task-config.ts), so this deliberately doesn't name either knob: whichever
// one the deployment actually used is what set `limit`, not necessarily
// MULLION_TASK_MAX_CONCURRENT.
function capDetail(limit: number): string {
  return `At capacity: ${limit} task(s) already running`;
}

export type EnqueueTaskOutcome =
  | { ok: true; task: typeof tasks.$inferSelect }
  | {
      ok: false;
      reason: "not-found" | "not-ready" | "archived" | "no-seed-channel" | "agent-quarantined";
      detail?: string;
    };

export type DispatchTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason:
        | "not-queued"
        | "cap"
        | "worktree-failed"
        | "spawn-failed"
        | "placement-refused"
        // Issue #2006 — the task's required host exists but is not eligible
        // right now; the task stays `claimed` and is looked at again.
        | "placement-held"
        // Issue #2364 — an open GitHub `blocked_by` dependency; the task
        // stays `claimed` until the blocker closes.
        | "blocked-held"
        // Issue #3341 — local Codex `/hooks` trust is pending; the task
        // stays `claimed` until the user approves Mullion's hooks in codex.
        | "codex-trust-held";
      detail?: string;
      /** Only set for "cap" — the concurrency limit that was hit. */
      limit?: number;
    };

/**
 * Task-claim queueing (rate-limit-storm fix) — `claimTask` used to reserve
 * (cap-check + status flip) and spawn (worktree + session) as one atomic
 * unit, which meant a claim past capacity had to be REJECTED with a 429:
 * there was no state that meant "accepted, but not started yet." Splitting
 * that into `enqueueTask` (this function) and `dispatchClaimedTask` (below)
 * makes "claimed" that state — every manual claim now succeeds
 * unconditionally and waits for `dispatchClaimedTask` to actually spawn it,
 * called either by task-dispatch.ts's opportunistic hook (fires off
 * task-state.ts's recordTaskTransition, see there) or its periodic sweep
 * off the task-watcher tick.
 *
 * `auto` still distinguishes a human clicking Claim from the watcher's
 * autonomous sweep for exactly one thing: a manual claim still queues even
 * when the resolved agent has no seed-delivery channel (the human is
 * present and can paste the prompt in themselves once it starts), but an
 * autonomous claim refuses to even queue rather than eventually spawning an
 * agent with silently no instructions at all.
 *
 * `agent`/`reviewAgent` overrides are persisted onto the row HERE, at
 * enqueue time — not held in a closure until dispatch, which may run in an
 * entirely separate call (a different tick, possibly after a process
 * restart). `dispatchClaimedTask` reads them back off the row exactly the
 * way this function used to read `opts.agent ?? task.agent` at call time.
 *
 * `worktreePath`/`branchName` are stamped here too, before anything is
 * created on disk (independent review, PR #476, predating the queue split)
 * — `plugins/task-watcher.ts`'s boot-time orphan sweep computes "orphan" as
 * "on disk, but not referenced by any non-terminal task's `worktreePath`,"
 * so a task must be DB-visibly claimed with its future path already
 * recorded before that path exists, not after. The queue makes this
 * predicted-but-not-yet-real window last far longer than before (a task can
 * now sit "claimed" for the queue's entire depth, not just the time it
 * takes to spawn) — safe only because `ACTIVE_WORKTREE_STATUSES`
 * (plugins/task-watcher.ts) already includes "claimed".
 */
export async function enqueueTask(
  app: FastifyInstance,
  taskId: number,
  opts: { auto: boolean; agent?: string | null; reviewAgent?: string | null },
): Promise<EnqueueTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  // A task from Mullion's own bot that no human has approved (or that was
  // edited after approval) must not start, whoever asks.
  if (proposalBlocksRun(task)) {
    return {
      ok: false,
      reason: "not-ready",
      detail: "Task was filed by Mullion and needs a human Approve before it can run",
    };
  }

  // An archived task is off the board for good (a merged-away project's
  // superseded copy, say) — claiming it would start a duplicate worker.
  if (task.archivedAt) {
    return { ok: false, reason: "archived", detail: "Task is archived and cannot be claimed" };
  }

  const effectiveAgent = opts.agent !== undefined ? opts.agent : task.agent;
  // Issue #2491 — an agent change made through this path bypasses the PATCH
  // route, so drop a task-level model the new agent family cannot take here.
  const agentChangeModelPatch = agentChangeModelClears(app, task, project, opts);

  const command = resolveAgentCommand(app, {
    taskAgent: effectiveAgent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);
  if (!seedCapable && opts.auto) {
    return {
      ok: false,
      reason: "no-seed-channel",
      detail: `The resolved agent (${command}) can't receive an initial prompt — refusing to auto-claim with no instructions. Claim manually instead.`,
    };
  }

  // Issue #29 — the Runway quota check, BEFORE anything is reserved.
  //
  // This is the point the whole feature exists for: a task whose agent's
  // provider is out of quota must not be claimed, because claiming it takes
  // a concurrency slot it cannot use and then fails later for a reason the
  // operator cannot see.
  //
  // The agent is known here — `command` is the resolved CLI — and nothing
  // has been persisted yet, so refusing here costs nothing.
  //
  // A MANUAL claim is not refused: a human is present, they may know the
  // quota recovered, and refusing a deliberate act would be worse than
  // letting it fail. It is logged instead.
  //
  // Issue #2054 — opencode spends several providers' quota, so for it the
  // model this claim would run is resolved first and its provider
  // (`opencode/<provider>`) is checked alongside the bare agent.
  const heldBy = quarantinedTarget(
    app,
    claimTargets(
      app,
      command,
      commandIsOpencode(command)
        ? resolveOpenCodeModel(app, {
            taskModel: task.modelOverride ?? null,
            issueBody: task.body,
            role: "implementer",
          })
        : null,
    ),
  );
  if (heldBy !== null) {
    if (opts.auto) {
      return {
        ok: false,
        reason: "agent-quarantined",
        detail: `The resolved agent (${heldBy.target}) is out of quota (${heldBy.reason ?? "quota exhausted"}) — refusing to auto-claim.`,
      };
    }
    app.log.warn(
      { agent: heldBy.target, reason: heldBy.reason },
      "[task-claim] claiming a quarantined agent manually — the provider is out of quota",
    );
  }

  // Derive the branch name through deriveTaskBranchName (git-worktree.ts)
  // so the shape is owned in one place. The id is in the name for
  // uniqueness (issueNumber is nullable — every local task shares NULL),
  // and the title-slug makes the branch self-describing in `git branch`
  // and on the GitHub PR header. Frozen at claim time — title edits after
  // claim do NOT rename the branch.
  const branchName = deriveTaskBranchName(task);
  const predictedWorktreePath = deriveWorktreePath(project.cwd, branchName);

  const reserved = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (current?.archivedAt) return { reserved: false as const, archived: true as const };
    if (!current || current.status !== "ready") {
      return { reserved: false as const, currentStatus: current?.status };
    }
    const keptBranch = current.resumeQueued === true ? current.branchName : null;
    const patch: Partial<typeof tasks.$inferInsert> = {
      status: "claimed",
      queuedAt: new Date(),
      resumeQueued: keptBranch !== null,
      worktreePath: keptBranch !== null ? current.worktreePath : predictedWorktreePath,
      branchName: keptBranch ?? branchName,
      rateLimitUntil: null,
      rateLimitMessage: null,
      failureReason: null,
      dispatchFailingSince: null,
      dispatchHeld: false,
      // Issue #3194 — a fresh claim is not waiting for any host: the markers
      // that exempt a waiting retry from the 6-hour give-up (and that offer
      // "Start fresh") are dropped here, so a row that somehow carried them
      // into a new claim cannot ride them into a second wait.
      retryHostId: null,
      retryStrandedOnHost: false,
    };
    if (opts.agent !== undefined) patch.agent = opts.agent;
    if (opts.reviewAgent !== undefined) patch.reviewAgent = opts.reviewAgent;
    Object.assign(patch, agentChangeModelPatch);
    tx.update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "ready"), isNull(tasks.archivedAt)))
      .run();
    return { reserved: true as const };
  });

  if (!reserved.reserved) {
    // Archived between the pre-check above and this transaction.
    if ("archived" in reserved) {
      return { ok: false, reason: "archived", detail: "Task is archived and cannot be claimed" };
    }
    return {
      ok: false,
      reason: "not-ready",
      detail: `Task is not ready (status: ${reserved.currentStatus ?? "unknown"})`,
    };
  }

  const [queuedRow] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "ready",
    to: "claimed",
    via: opts.auto ? "auto-claim-queue" : "claim-queue",
    context: { auto: opts.auto },
  });

  // Fire-and-forget, same reasoning as the old claimTask's own sync call
  // (still below, on dispatchClaimedTask's success — this is the "claimed"
  // half only). No sessionId/worktreePath/agentCommand yet — those don't
  // exist until dispatch.
  void syncTaskTransition(app, { ...task, status: "claimed" }, project, "claimed");

  return { ok: true, task: queuedRow };
}

// Issue #2364 — a hold's reason starts with this, so the card and the clear
// below can tell it from a failed attempt's reason.
const BLOCKED_HOLD_PREFIX = "Waiting for ";

// A blocked hold re-reads GitHub at most this often; the webhook refresh and
// the watcher's display pass keep the stored blockers current in between.
const BLOCKED_HOLD_RECHECK_MS = 5 * 60 * 1000;

// Issue #2569 — what every Task Master worker launch needs of its host: a
// worktree and an initial prompt tied to the task. Placement skips a host
// whose agent is known to lack them; the launch gate refuses the rest.
const TASK_LAUNCH_NEEDS = {
  requiredOperations: ["sessions", "git-worktrees"],
  requiredLaunchOptions: ["initialPrompt", "taskId"],
} as const;

function blockedHoldDetail(blockedBy: string | null): string {
  const blockers = parseBlockedBy(blockedBy) ?? [];
  const names = blockers.map((b) => (b.number > 0 ? `#${b.number}` : b.title));
  return `${BLOCKED_HOLD_PREFIX}${names.join(", ")} to close`;
}

/**
 * Issue #2364 — the dependency gate for a task that is already `claimed`.
 * Returns a "blocked-held" outcome while the issue has an open blocker, else
 * null (dispatch proceeds). Never-observed blockers are refreshed once; if
 * that cannot be done the task is dispatched anyway (fail-open, logged) so a
 * GitHub outage cannot strand a claimed task.
 */
async function blockedHold(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
): Promise<DispatchTaskOutcome | null> {
  let current = task;
  let gate = dependencyGate(current);
  const stale =
    current.blockedByCheckedAt === null ||
    Date.now() - current.blockedByCheckedAt.getTime() >= BLOCKED_HOLD_RECHECK_MS;
  if (gate !== "clear" && (gate === "unresolved" || stale) && current.issueNumber !== null) {
    try {
      const repoRef = await resolveRepoRef(app, project);
      const token = repoRef ? await resolveGitHubToken(app, repoRef) : null;
      if (repoRef && token) {
        await refreshTaskBlockers(app, {
          taskId: current.id,
          projectId: project.id,
          owner: repoRef.owner,
          repo: repoRef.repo,
          issueNumber: current.issueNumber,
          dependencyCount: current.dependencyCount,
          token,
        });
        const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
        if (row) current = row;
        gate = dependencyGate(current);
      }
    } catch (err) {
      app.log.warn({ err, taskId: task.id }, "task dispatch: blocker refresh failed");
    }
    if (gate === "unresolved") {
      app.log.warn(
        { taskId: task.id },
        "task dispatch: blockers could not be resolved — dispatching anyway",
      );
      return null;
    }
  }
  if (gate === "blocked") {
    const detail = blockedHoldDetail(current.blockedBy);
    if (task.failureReason !== detail) {
      const written = app.db
        .update(tasks)
        .set({ failureReason: detail })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
        .run();
      if (written.changes > 0) {
        app.log.info({ taskId: task.id }, `task dispatch: ${detail} — holding the task`);
        broadcastTaskEvent({
          taskId: task.id,
          projectId: project.id,
          kind: "dispatch",
          ts: Date.now(),
        });
      }
    }
    return { ok: false, reason: "blocked-held", detail };
  }
  // Gate is clear: drop a hold text left by an earlier sweep.
  if (task.failureReason?.startsWith(BLOCKED_HOLD_PREFIX)) {
    app.db
      .update(tasks)
      .set({ failureReason: null })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "claimed")))
      .run();
    broadcastTaskEvent({
      taskId: task.id,
      projectId: project.id,
      kind: "dispatch",
      ts: Date.now(),
    });
  }
  return null;
}

/**
 * Task-claim queueing (rate-limit-storm fix) — the half of the old
 * `claimTask` that actually spawns a worker: reservation (now JUST the
 * concurrency-cap check + the "claimed" -> "in_progress" flip, since
 * `enqueueTask` above already did everything else) followed by the same
 * orphan-clear/base-ref/createSessionRecord sequence that function always
 * had.
 *
 * Reservation is atomic with the concurrency-cap check (Hermes/independent
 * review posture carried into 6.2, unchanged by the split): one
 * `app.db.transaction(...)` (synchronous, better-sqlite3) counts tasks
 * `in_progress` against `MULLION_TASK_MAX_CONCURRENT`, then conditionally
 * flips this task's status — both checks succeed or fail together, so two
 * concurrent dispatch attempts (the opportunistic hook AND the periodic
 * sweep can both fire for the same free slot) can't both win it.
 *
 * On success, status goes straight "claimed" -> "in_progress" — never
 * lands on an intermediate "in_progress, no session yet" the way the old
 * single-phase claimTask could transiently. `claimedAt`/`startedAt` are
 * BOTH stamped here (not `enqueueTask`'s `queuedAt`) — this is genuinely
 * "when did the CURRENT spell start," the same meaning
 * task-reconciler.ts's budget deadline and `turnFinishedSinceClaim` already
 * give `claimedAt` today; a task that queued for hours must not have that
 * time counted against its budget.
 *
 * On failure, `release()` returns the task to "claimed" (its queue
 * position), NOT "ready" — an enqueue was a real, unconditional commitment;
 * a transient dispatch failure (a dirty leftover worktree, a briefly
 * unreachable host) shouldn't cost the task its place in line. The caller
 * (task-dispatch.ts) is responsible for backing off a task that keeps
 * failing dispatch, so this doesn't retry the identical failure in a tight
 * loop — see that module's own doc comment.
 */
export async function dispatchClaimedTask(
  app: FastifyInstance,
  taskId: number,
): Promise<DispatchTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  // A queued retry (resumeQueued) belongs to dispatchQueuedRetry.
  if (!task || task.status !== "claimed" || task.sessionId !== null || task.resumeQueued) {
    return { ok: false, reason: "not-queued" };
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-queued" };

  // Issue #2364 — before any worktree, placement or session work.
  const held = await blockedHold(app, task, project);
  if (held) return held;

  // Re-resolved here, not carried from enqueue time: task.agent/reviewAgent
  // were already persisted onto the row by enqueueTask (or predate it, for
  // an unedited task), so re-reading them now picks up any edit made while
  // the task sat queued, the same way a fresh claimTask call always did.
  const command = resolveAgentCommand(app, {
    taskAgent: task.agent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);

  const branchName = task.branchName ?? deriveTaskBranchName(task);
  // The start of the current run of failed attempts (issue #1997). A local, so
  // a stale hold can be dropped below without `release()` reusing its clock.
  let failingSince = task.dispatchFailingSince;

  // The placement is decided HERE, once, because the worktree is cut on
  // the chosen host (#1724) — so the orphan check below has to ask THAT
  // host whether a previous attempt left something behind, and the
  // predicted path has to be the one under THAT host's project root.
  // Deciding it here and passing the host down also means the decision is
  // made once, not twice (the fleet's readings could change between two
  // calls, and the worktree and the session must agree on the host).
  //
  // Issue #1954 — a task can REQUIRE a platform or host (`Platform:` / `Host:`
  // in the issue body). That is the one case where "placement never blocks a
  // spawn" does not hold: a task that needs Xcode, started on the Linux
  // fallback, would just fail later. So a requirement goes through
  // `resolveTargetHost` (online, not parked, has capacity, has this project's
  // path in `hostCwds` — the same eligibility as automatic placement, then the
  // usual load scoring among the matches), works for a `pinned` project too,
  // and is REFUSED, with a recorded reason, when nothing matches. A task with
  // no requirement is decided exactly as before.
  const requirement = parsePlacementRequirement(task.body);
  const requirementJson = serializePlacementRequirement(requirement);
  const placementProject = {
    hostId: project.hostId,
    placement: project.placement,
    cwd: project.cwd,
    hostCwds: project.hostCwds,
    placementConstraints: project.placementConstraints,
  };

  // Refuses the claim: fails the still-`claimed` task with the reason on the
  // row (see `failQueuedTask`). Refusing without RECORDING anything would
  // leave the task exactly where it was, so the sweep would pick it up again
  // on the next tick and the only trace would be a log line.
  function refuseClaim(
    detail: string,
    hostId: string | null,
    extra: Partial<typeof tasks.$inferInsert> = {},
  ): DispatchTaskOutcome {
    app.log.warn({ taskId, hostId, requirement }, `task dispatch: ${detail} — refusing to claim`);
    failQueuedTask(app, taskId, {
      detail,
      via: "placement-refusal",
      hostId,
      context: { requirement },
      // The requirement of THIS attempt goes on the row whichever way it
      // fails, so a stale one from an earlier attempt cannot outlive it.
      extra: { placementRequirement: requirementJson, ...extra },
    });
    // Its own reason, not "worktree-failed": the task is already `failed`, so
    // the dispatch sweep must not back it off as if a retry were pending — an
    // author who fixes `hostCwds` and moves it back to `ready` would otherwise
    // wait out a window that protects against nothing.
    return { ok: false, reason: "placement-refused", detail };
  }

  // Issue #2006 — the requirement cannot be met RIGHT NOW, but a host that
  // could meet it exists (it is offline, parked, or has no capacity reading
  // yet): keep the task `claimed` with the reason on it instead of failing it.
  // The dispatch sweep looks again every tick, so it starts once the host is
  // back; task-dispatch.ts bounds the wait. The text is stable (no times in
  // it) so an unchanged hold writes and broadcasts nothing on later ticks.
  function holdClaim(detail: string): DispatchTaskOutcome {
    if (task.failureReason !== detail || failingSince === null || !task.dispatchHeld) {
      const written = app.db
        .update(tasks)
        .set({
          failureReason: detail,
          placementRequirement: requirementJson,
          dispatchFailingSince: failingSince ?? new Date(),
          dispatchHeld: true,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
        .run();
      // Nothing matched when something else moved the row first (the write is
      // conditional on `claimed`): then there is nothing to tell the board.
      if (written.changes > 0) {
        app.log.info({ taskId, requirement }, `task dispatch: ${detail} — holding the task`);
        broadcastTaskEvent({
          taskId,
          projectId: project.id,
          kind: "dispatch",
          ts: Date.now(),
        });
      }
    }
    return { ok: false, reason: "placement-held", detail };
  }

  // Issue #2240 — the worker's CLI AND the reviewer's must both be on the host
  // the task lands on (the reviewer reads the worker's worktree).
  const reviewCommand = resolveReviewAgentCommand(app, {
    taskReviewAgent: task.reviewAgent,
    issueBody: task.body,
    projectDefaultReviewAgent: project.defaultReviewAgent,
  });
  const requiredAgent = [command, reviewCommand]
    .map((c) => (c === null ? null : commandAgentBin(c)))
    .filter((bin, i, all): bin is string => bin !== null && all.indexOf(bin) === i);

  // Issue #2596 — read any unread host protocol (bounded) before placement.
  await ensureRemoteHostProtocols(app, { target: requirement });
  let placement: PlacementDecision;
  if (requirement !== null) {
    const targeted = resolveTargetHost(app, {
      project: placementProject,
      target: requirement,
      unattended: true,
      requestedBy: "the task's requirement",
      requiredAgent,
      ...TASK_LAUNCH_NEEDS,
    });
    if (!targeted.ok && targeted.transient) {
      const requires = `this task requires ${describeTarget(requirement)} (from ${describeRequirementSource(requirement)})`;
      return holdClaim(
        targeted.unreadable
          ? `${requires}, but the hosts could not be checked just now. It will be tried again shortly.`
          : `${requires}, and a matching host is registered but not eligible right now (offline, parked, ` +
              "or no capacity reading yet). It will start once one is.",
      );
    }
    if (!targeted.ok) {
      return refuseClaim(
        `this task requires ${describeTarget(requirement)} (from ${describeRequirementSource(requirement)}), ` +
          "but no eligible host matches: a host " +
          "has to be online, not parked, report its capacity, and have a path for this project " +
          `(Edit project → Also lives on), and have the agent CLIs the task needs. Placement said: ${targeted.detail}. ` +
          "Fix that, then move the task back to ready.",
        null,
        // The failure came before any worktree was cut, so the branch and
        // path stamped at claim time name nothing that exists; clearing them
        // makes Retry refuse cleanly rather than try to resume them.
        { placementRequirement: requirementJson, worktreePath: null, branchName: null },
      );
    }
    placement = targeted.decision;
  } else {
    const auto = resolvePlacement(app, {
      project: placementProject,
      unattended: true,
      requiredAgent,
      ...TASK_LAUNCH_NEEDS,
    });
    // Issue #2241 — the project's platform flag leaves no host. Same rule as a
    // directive: hold while a host that satisfies it could come online, fail
    // otherwise. (A task WITH a directive never gets here: it overrides the flags.)
    if (auto.refusal !== undefined) {
      if (auto.refusal.transient) {
        return holdClaim(
          auto.refusal.unreadable
            ? `this project's placement flags restrict where tasks may run, but the hosts could not be checked just now. It will be tried again shortly.`
            : `this project's placement flags restrict where tasks may run, and a host that satisfies them is registered but not eligible right now (offline, parked, or no capacity reading yet). It will start once one is.`,
        );
      }
      return refuseClaim(
        `${auto.refusal.detail}. Change the flags (Edit project → Placement), or add a matching host with a path for this project, then move the task back to ready.`,
        null,
        { placementRequirement: requirementJson, worktreePath: null, branchName: null },
      );
    }
    placement = auto;
  }
  // Lazy checkout materialization: the chosen host has no checkout of the
  // project yet. The clone is a background job (never held inside this tick):
  // hold the claim while it runs; the next sweep tick re-places and continues
  // once the path exists. A failed job is reported once, as a failed attempt.
  if (placement.needsCheckout) {
    const failedJob = takeFailedMaterialize(project.id, placement.hostId);
    if (failedJob !== null) {
      const detail = `could not prepare a checkout on ${placement.hostId}: ${failedJob.detail ?? "the clone failed"}`;
      app.db
        .update(tasks)
        .set({
          failureReason: detail,
          dispatchFailingSince: failingSince ?? new Date(),
          dispatchHeld: false,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
        .run();
      app.log.warn({ taskId, hostId: placement.hostId }, `task dispatch: ${detail}`);
      return { ok: false, reason: "worktree-failed", detail };
    }
    startMaterialize(app, project.id, placement.hostId);
    return holdClaim(describePreparing(placement.hostId));
  }
  const trustHeld = codexTrustHold(app, task, project, command, placement.hostId);
  if (trustHeld) return trustHeld;
  // Placement succeeded, so a hold recorded earlier (the host was not eligible)
  // no longer describes the task — it may now wait for a worker slot instead,
  // and the card must not keep saying the host is unavailable, nor count that
  // wait toward the 6h give-up. Only a HOLD is dropped: the reason of a failed
  // attempt (an unreachable base ref, a worktree git cannot cut) is still the
  // last known truth until a dispatch succeeds.
  if (task.failureReason === CODEX_TRUST_HOLD_DETAIL) {
    // codexTrustHold already cleared the hold columns and broadcast the event.
    failingSince = null;
  } else if (task.dispatchHeld) {
    const cleared = app.db
      .update(tasks)
      .set({ failureReason: null, dispatchFailingSince: null, dispatchHeld: false })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    failingSince = null;
    if (cleared.changes > 0) {
      broadcastTaskEvent({ taskId, projectId: project.id, kind: "dispatch", ts: Date.now() });
    }
  }
  // The project root ON THE PLACEMENT HOST. Null would mean the placement
  // chose a host this project is not on — unreachable in practice (the
  // policy only ever chooses a host the project is mapped on), but the
  // session would have no directory to run in, so refuse rather than
  // guess: the project's own root is a path that host does not have.
  const placementCwd = projectCwdOnHost(project, placement.hostId, parseHostCwds(project.hostCwds));
  if (placementCwd === null) {
    return refuseClaim(
      `the placement host ${placement.hostId} has no path for this project`,
      placement.hostId,
    );
  }
  // The predicted path is derived from the PLACEMENT root — the path the
  // worktree is about to be created at. NOT the task row's stamped
  // `worktreePath`: that one was stamped at CLAIM time from the project's
  // root, on the project's host, and for an "auto" project that is a
  // different directory on a different machine — so asking the placement
  // host about it would look at a path it does not have, and every placed
  // task's first dispatch would be released as "a previous attempt left an
  // unclean worktree". (The row's own worktreePath is corrected to the
  // real path further down, once the worktree exists.)
  const predictedWorktreePath = deriveWorktreePath(placementCwd, branchName);

  const taskMasterConfig = resolveTaskMasterConfig(app);
  const maxConcurrent = taskMasterConfig.maxConcurrent;
  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "claimed" || current.sessionId !== null) {
      return { reserved: false as const };
    }
    const inFlight = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, CONCURRENCY_CAPPED_STATUSES))
      .all();
    if (inFlight.length >= maxConcurrent) {
      return { reserved: false as const, capped: true as const };
    }
    tx.update(tasks)
      .set({ status: "in_progress", claimedAt: new Date(), startedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    return { reserved: true as const };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      return { ok: false, reason: "cap", limit: maxConcurrent, detail: capDetail(maxConcurrent) };
    }
    // Lost a race with another dispatch attempt for this same task (or it
    // was deleted/edited out from under us) — not an error, just nothing
    // to do; the caller (task-dispatch.ts) moves on to the next candidate.
    return { ok: false, reason: "not-queued" };
  }

  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "claimed",
    to: "in_progress",
    via: "dispatch",
  });

  // Mirrors enqueueTask's release() — puts the reservation back rather than
  // leaving an "in_progress" row with no session behind it. Releases to
  // "claimed" (see this function's own doc comment), not "ready" —
  // worktreePath/branchName are deliberately LEFT AS-IS (they're the
  // queue's still-correct predicted path, needed for the next dispatch
  // attempt's own orphan-clearing). baseSha/seedDelivered ARE nulled, same
  // belt-and-suspenders reasoning as enqueueTask's release() below: no path
  // in this codebase today lands a genuinely-committed prior spell's values
  // back on a "claimed" row, but a "claimed" row must never carry them
  // forward regardless — only this function's own commit block ever WRITES
  // them.
  async function release(reason: string): Promise<void> {
    const updated = app.db
      .update(tasks)
      .set({
        status: "claimed",
        claimedAt: null,
        startedAt: null,
        failureReason: reason,
        failureDiagnostics: null,
        // Issue #1997 — keeps the START of this run of failures (the give-up
        // clock); `task` is the row read at the top, and nothing else writes
        // the column between that read and here.
        dispatchFailingSince: failingSince ?? new Date(),
        // A failed attempt is not a hold (see schema.ts's dispatchHeld).
        dispatchHeld: false,
        placementRequirement: requirementJson,
        baseSha: null,
        seedDelivered: null,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_progress"), isNull(tasks.sessionId)))
      .run();
    if (updated.changes > 0) {
      recordTaskTransition(app, {
        taskId,
        projectId: project.id,
        from: "in_progress",
        to: "claimed",
        via: "dispatch-release",
        context: { reason },
      });
    }
  }

  // Same throw/rollback posture as the old claimTask — see its own doc
  // comment (still on enqueueTask above) for why this try/catch exists and
  // what `committed` guards.
  let committed = false;
  // Issue #1722 / roadmap 8.8 — the host below is the PROJECT's, and that
  // is deliberate at every one of its uses in this function:
  //
  //   - the SPAWN host is the placement DECISION for this task's session.
  //     Today that decision is "the task's project's host"; #1724 replaces
  //     it with the placement policy's choice, and the session's row
  //     records whatever it becomes (src/services/session-lifecycle.ts's
  //     insertRow).
  //   - the worktree and git operations are PROJECT-scoped (the task's
  //     worktree lives on the project's host, whatever the session's own
  //     host ends up being).
  //
  // The one place that is NOT project-scoped is the live-status read after
  // the spawn — the row exists by then, so it uses the SESSION's host.
  try {
    // The PLACEMENT host — the worktree is cut there, so that is where a
    // previous attempt would have left one.
    const backend = resolveBackend(app, placement.hostId);
    // Orphan-clearing (6.8/#283) — unchanged from the old claimTask.
    let clearResult: Awaited<ReturnType<typeof clearOrphanedCheckout>>;
    try {
      clearResult = await clearOrphanedCheckout(
        app,
        {
          projectId: project.id,
          hostId: placement.hostId,
          cwd: placementCwd,
          worktreePath: predictedWorktreePath,
        },
        branchName,
      );
    } catch (err) {
      const unknown = unknownOutcomeMessage(err);
      if (!unknown) throw err;
      // The clear may have landed (or half-landed): not a plain failure, and
      // the next dispatch must look at the host before cutting a new worktree.
      await release(`clearing the previous attempt's worktree: ${unknown}`);
      return {
        ok: false,
        reason: "worktree-failed",
        detail: `Clearing a previous attempt's worktree at ${predictedWorktreePath}: ${unknown}`,
      };
    }
    if (!clearResult.cleared) {
      await release(
        `a previous attempt left an unclean worktree at ${predictedWorktreePath} (${clearResult.reason})`,
      );
      return {
        ok: false,
        reason: "worktree-failed",
        detail: `A previous attempt left an unclean worktree at this task's branch path (${clearResult.reason}) — resolve it manually before retrying`,
      };
    }

    // #484/#491 — unchanged from the old claimTask; see git blame on this
    // function's prior revision (before the queue split) for the full
    // base-ref-pinning rationale.
    //
    // Issue #1959 — resolved on the PLACEMENT host, the one that cuts the
    // worktree, not the project's. The project host's clone may know a SHA
    // the placement host never fetched, and `git worktree add` from it
    // fails (or, with a bare ref, cuts from a stale one). Resolving there
    // also fetches THAT clone first (`resolveDefaultBaseRef`), so the SHA
    // is one the cutting clone has.
    //
    // A host that cannot ANSWER (unreachable, or an agent too old to have the
    // route) no longer falls back to a bare `HEAD` on a clone nobody asked:
    // the task is released with the reason recorded and the dispatch backoff
    // retries it, so it recovers by itself once the host is back or upgraded.
    // (A clone that answers but has no resolvable origin default still
    // resolves to its own `HEAD` — `resolveDefaultBaseRef`'s documented
    // worst case, the same for a local project.)
    const baseRefResult = await resolveHostBaseRef(app, placement.hostId, placementCwd);
    if (!baseRefResult.ok) {
      const detail =
        baseRefResult.reason === "unsupported"
          ? `host ${placement.hostId} is too old to resolve a base ref — upgrade it`
          : `could not resolve the base ref on host ${placement.hostId}: ${baseRefResult.detail}`;
      await release(detail);
      return { ok: false, reason: "worktree-failed", detail };
    }
    // `fetched` is absent from an agent too old to report it: unknown, so keep
    // the old behaviour. An explicit `false` means the fetch of origin failed
    // and the SHA below may be arbitrarily stale — release and let the
    // dispatch backoff retry rather than cut the worktree from it.
    if (baseRefResult.value.fetched === false) {
      const detail = `could not fetch origin on host ${placement.hostId}: the base ref may be stale`;
      await release(detail);
      return { ok: false, reason: "worktree-failed", detail };
    }
    const { baseRef, baseSha } = {
      baseRef: baseRefResult.value.baseRef,
      baseSha: baseRefResult.value.sha,
    };
    // #939/#1016 — resolved once per spawn, fail-open (a GitHub hiccup here
    // degrades to today's plain title+body prompt, never blocks the claim).
    const issueContext = await resolveTaskIssueContextSafe(app, task, project);
    const prompt = buildWorkerPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName,
      worktreePath: predictedWorktreePath,
      budgetMinutes: taskMasterConfig.budgetMinutes,
      mode: "claim",
      agentCommand: command,
      delegation: resolveWorkerDelegation(app, command, task),
      // #778 — resolved against the OWNING host's own sessionsDir; see
      // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(
            await resolveSessionsDirWithFallback(app, backend, {
              taskId: task.id,
              // Issue #1724 — the session's OWN sessions dir, on the host
              // the session RUNS (the placement host), not the project's.
              hostId: placement.hostId,
            }),
            task.id,
          )
        : undefined,
    });
    const { model, smallModel } = resolveWorkerSpawnModels(app, command, task);
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      worktree: { baseRef: baseSha ?? baseRef, branchName },
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions: taskMasterConfig.skipPermissions,
      // #9 — named and locked so this session reads as "task #N's worker"
      // anywhere it's shown, instead of the bare launch command (currently
      // indistinguishable from a manually-launched session of the same
      // agent). `nameLocked: true` is a deliberate deviation from this
      // column's own documented default intent (schema.ts) — a launch-time
      // name pattern deliberately leaves it false so a live OSC title
      // update can still override it, but a task session's whole point is
      // a name that reliably identifies which task it belongs to, which an
      // OSC update would defeat.
      name: taskWorkerSessionName(task.id),
      nameLocked: true,
      model,
      smallModel,
      // Issue #1724 — the host and the reason decided above, so the
      // worktree, the session and the row all agree on one host and one
      // explanation.
      hostId: placement.hostId,
      placementReason: placement.reason,
      // Mark this session as an unattended Task Master worker so the
      // opencode and codex adapters deny superpowers skills that gate on
      // a human in the loop (brainstorming / writing-plans /
      // finishing-a-development-branch — verified failing in branchdam-
      // mobile tasks #66 / #67).
      taskId: task.id,
      // Issue #1724 / roadmap 8.10 — the placement policy scores an
      // unattended session differently: no local bonus, because the goal
      // is to drain the primary onto the least-loaded eligible host. This
      // is the spawn that CREATES the worktree, so the placement also
      // decides where the worktree is cut from.
      unattended: true,
    });
    if (!result.ok) {
      if (result.reason === "worktree-failed") {
        // Issue #1959 — keep git's own reason (the base ref the placement
        // host lacks, a branch that already exists, ...) instead of an
        // opaque "worktree creation failed".
        const reason = result.detail
          ? `worktree creation failed on host ${placement.hostId}: ${result.detail}`
          : "worktree creation failed";
        await release(reason);
        return { ok: false, reason: "worktree-failed", detail: reason };
      }
      if (result.reason === "host-unsupported" || result.reason === "host-awaiting-approval") {
        // Issue #2569 / #3441 — nothing was created; report why the host refused.
        await release(result.detail);
        return { ok: false, reason: "spawn-failed", detail: result.detail };
      }
      if (result.reason === "outcome-unknown") {
        const reason = result.detail
          ? `session spawn outcome unknown on host ${placement.hostId}: ${result.detail}`
          : "session spawn outcome unknown";
        // #2621 — the spawn may have landed, so releasing would let the next
        // dispatch's orphan-clear delete the kept worktree and force-delete
        // the branch under a live agent, then spawn a second worker. Adopt
        // the kept session row instead: if the agent started it is the
        // worker; if not, the ordinary dead-session handling takes over.
        const kept =
          result.sessionId === undefined
            ? undefined
            : app.db.select().from(sessions).where(eq(sessions.id, result.sessionId)).get();
        if (kept !== undefined) {
          const adopted = app.db
            .update(tasks)
            .set({
              sessionId: kept.id,
              worktreePath: kept.cwd,
              branchName,
              agentCommand: command,
              model,
              smallModel,
              placementRequirement: requirementJson,
              baseSha,
              seedDelivered: false,
              failureReason: reason,
              dispatchHeld: false,
              dispatchFailingSince: null,
            })
            .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_progress")))
            .run();
          if (adopted.changes === 0) {
            // The task left "in_progress" while the spawn was in flight:
            // nothing points at the kept row, so reap it rather than leave an
            // untracked, possibly live unattended agent.
            app.log.warn(
              { taskId, sessionId: kept.id },
              "task dispatch: task changed while its worker was spawning — killing the orphaned session",
            );
            await killSession(app, kept.id);
          } else {
            app.log.warn(
              { taskId, sessionId: kept.id, hostId: placement.hostId },
              "task dispatch: spawn outcome unknown, adopted the kept session",
            );
          }
          return { ok: false, reason: "spawn-failed", detail: reason };
        }
        await release(reason);
        return { ok: false, reason: "spawn-failed", detail: reason };
      }
      await release("session spawn failed");
      return { ok: false, reason: "spawn-failed" };
    }

    // Issue #1724 — the host that RAN the spawn is the placement host, so
    // that is the host whose version skew matters here.
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      placement.hostId,
      result.initialPromptApplied,
    );
    if (seedCapable && !seedDelivered) {
      app.log.warn(
        { taskId, hostId: placement.hostId, command },
        "task dispatch: sent an initial prompt to a remote host but it wasn't confirmed applied — possible version skew (the remote agent build may not support initialPrompt yet)",
      );
    }

    app.db
      .update(tasks)
      .set({
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        model,
        smallModel,
        placementRequirement: requirementJson,
        baseSha,
        seedDelivered,
        // Issue #1997 — it dispatched: whatever the queue said was wrong no
        // longer is, so the card stops showing it.
        failureReason: null,
        dispatchFailingSince: null,
        dispatchHeld: false,
      })
      .where(eq(tasks.id, taskId))
      .run();
    committed = true;

    // Fire-and-forget, matching the reconciler's own now-removed
    // "claimed -> in_progress" branch (task-reconciler.ts), which synced
    // this exact event before dispatch existed.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "in_progress",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        branchName,
        agentCommand: command,
        baseSha,
        startedAt: new Date(),
      },
      project,
      "in_progress",
    );

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    // Issue #1722 / roadmap 8.8 — the SESSION's host: the row exists now,
    // and the live status has to come from the host this session actually
    // runs on (a placement policy may have put it somewhere other than the
    // task's project).
    const session = await withLiveStatus(
      app,
      result.row,
      idleThresholdMs,
      resolveSessionHostId(app, result.row),
    );
    return { ok: true, session, seedDelivered };
  } catch (err) {
    if (committed) throw err;
    await release(err instanceof Error ? err.message : "unexpected error during dispatch");
    app.log.error({ err, taskId }, "task dispatch: unexpected error, reservation released");
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * #2292 — the refusal a Retry returns for a task copy that a project merge
 * superseded. It is a 409 from `POST /api/tasks/:id/retry` (routes/tasks.ts
 * maps the outcome reason).
 *
 * It has to explain WHY, because the row on the board looks like any other
 * `failed` task: without this, "Retry did nothing" reads like a bug.
 *
 * It lives HERE, not beside the merge's own wording (task-supersede.ts):
 * `enqueueRetry` (task-retry.ts), which returns it, already fans out to a
 * long list of modules, and an import added only for one string would widen
 * that coupling for no reason.
 */
export const SUPERSEDED_RETRY_DETAIL =
  "This task's copy was superseded by a project merge — another task now owns the issue, so retrying it would start a duplicate worker.";

export type RetryTaskOutcome =
  | { ok: true; session: Awaited<ReturnType<typeof withLiveStatus>>; seedDelivered: boolean }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-queued"
        | "cap"
        | "no-worktree"
        | "remote-not-supported"
        | "worktree-failed"
        | "spawn-failed"
        // Issue #3194 — the retry is waiting for its original host (the
        // preserved branch lives there and is not on origin). The task stays
        // `claimed` and is looked at again on the next sweep; it is NOT
        // failed after 6h (the give-up does not apply to this wait).
        | "retry-waiting"
        // Issue #3194 — a RE-PLACED retry whose checkout could not be prepared
        // on the replacement host (the clone failed). This is the ONE
        // failure here that does NOT fail the row: the retry stays `claimed`
        // and the next sweep tries the clone again — so the 6-hour give-up is
        // what ends it (the branch is on origin, so failing the task frees
        // something). It is its own reason, not "worktree-failed", because
        // that one comes from the RESUME and always fails the row.
        | "checkout-failed"
        // Issue #3341 — local Codex `/hooks` trust is pending; the retry
        // stays `claimed` until the user approves Mullion's hooks in codex.
        | "codex-trust-held";
      detail?: string;
      /** Only set for "cap" — mirrors claimTask's own shape. */
      limit?: number;
    };

/**
 * #483 — retries a `failed` task by resuming on its preserved
 * `mullion/task-<id>-<slug>` branch (git-worktree.ts's `resumeTaskWorktree`)
 * rather than starting over from `baseRef`. Every task that ever reaches
 * "failed" got there from "claimed"/"in_progress" (session-reconciler.ts's
 * session-died hook, or task-reconciler.ts's budget force-fail) — both
 * paths only run once a worktree/branch already exist, and neither nulls
 * `worktreePath`/`branchName` on the failing write, so `task.branchName` is
 * reliably present here. `removeWorktreeIfClean` (the `→ failed` cleanup
 * itself) removes only the worktree directory, never the branch — see that
 * function's own doc comment — which is exactly what makes resuming
 * possible. A dirty worktree is the exception: `removeWorktreeIfClean` leaves
 * it on disk with the branch checked out, so `resumeTaskWorktree` adopts that
 * checkout as it stands (`reused`) instead of colliding with it.
 *
 * Goes straight from "failed" to "claimed", not through "ready" —
 * task-state.ts's table only allows `failed → ready`/`backlog`, but this
 * function IS the resolution of "then immediately re-claim it," the same
 * way `claimTask` itself resolves `ready → claimed` as one action rather
 * than requiring two round trips. A local-only reservation helper, not a
 * new table edge, since nothing else needs `failed → claimed` directly.
 *
 * Always human-initiated (there's no autonomous retry sweep), so unlike
 * `claimTask`'s `auto`/manual split, this never refuses on an unseedable
 * agent — a person clicked Retry and can paste the prompt in themselves,
 * same posture as a manual claim.
 *
 * #484 — resuming a remote-hosted task's preserved branch now proxies
 * through `SessionBackend.resumeTaskWorktree` the same way every other
 * worktree-lifecycle op on that interface already does; `remote-not-
 * supported` in `RetryTaskOutcome`'s union survives only as the
 * version-skew case (an agent build predating this proxy route).
 *
 * #2292 — a task copy that a project merge SUPERSEDED is refused outright
 * ("superseded"). Another task owns the issue now, so resuming this copy's
 * preserved branch would start a second worker for work already in flight.
 * The marker is `tasks.supersededAt` (see task-supersede.ts and db/schema.ts's
 * own doc comment); unlike `archivedAt`, it survives Unarchive, so unhiding
 * the row does not re-arm the duplicate. This is the retry-side twin of
 * #2291's claim-side refusal (an archived task is never claimed).
 */
export async function dispatchQueuedRetry(
  app: FastifyInstance,
  taskId: number,
): Promise<RetryTaskOutcome> {
  const [task] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (!task) return { ok: false, reason: "not-found" };
  // Only a queued retry (enqueueRetry in task-retry.ts) is resumed here; a
  // fresh claim goes through dispatchClaimedTask.
  if (task.status !== "claimed" || !task.resumeQueued || task.sessionId !== null) {
    return { ok: false, reason: "not-queued" };
  }

  const [project] = app.db.select().from(projects).where(eq(projects.id, task.projectId)).all();
  if (!project) return { ok: false, reason: "not-found" };

  // enqueueRetry already revalidated the agent/model choice and persisted it
  // on the row, so the queued retry runs with whatever survived.
  const modelOverride = task.modelOverride ?? null;
  const smallModelOverride = task.smallModelOverride ?? null;

  const command = resolveAgentCommand(app, {
    taskAgent: task.agent,
    issueBody: task.body,
    projectDefaultAgent: project.defaultAgent,
  });
  const seedCapable = commandSupportsSeed(command);

  // Issue #2240 — the worker's CLI AND the reviewer's must both be on the host
  // the task lands on (the reviewer reads the worker's worktree) — the same
  // requirement a fresh claim places with.
  const reviewCommand = resolveReviewAgentCommand(app, {
    taskReviewAgent: task.reviewAgent,
    issueBody: task.body,
    projectDefaultReviewAgent: project.defaultReviewAgent,
  });
  const requiredAgent = [command, reviewCommand]
    .map((c) => (c === null ? null : commandAgentBin(c)))
    .filter((bin, i, all): bin is string => bin !== null && all.indexOf(bin) === i);

  // Issue #1954 — the task's `Platform:` / `Host:` / `Capability:`
  // requirement. A requirement is a HARD one on every path (the issue's
  // review focus): a retry never lands on a host that does not satisfy it.
  const requirement = parsePlacementRequirement(task.body);
  const requirementJson = serializePlacementRequirement(requirement);

  // Issue #1724 — the host the task's worker ran on, which is where its
  // preserved branch lives.
  const originalHostId = resolveTaskWorkerHost(app, task, { hostId: project.hostId });

  // Issue #2596 — read any unread host protocol (bounded) before placement,
  // exactly as the fresh-claim path does.
  await ensureRemoteHostProtocols(app, { target: requirement });

  // Issue #3194 — WHERE this retry runs: the original host when it can take
  // it, otherwise another eligible host (only when the branch is confirmed to
  // be on origin), otherwise the task waits for its original host.
  const decision = await decideRetryHost(app, {
    task,
    project,
    requirement,
    requiredAgent,
    originalHostId,
    launchNeeds: TASK_LAUNCH_NEEDS,
  });

  if (decision.kind === "wait") {
    // The preserved branch lives on the original host, and it is not on
    // origin, so the retry cannot start anywhere else — and failing the task
    // would free nothing (the branch is still there, with its commits). The
    // task stays `claimed` with the reason on it, and the next sweep looks
    // again. The 6h give-up does NOT apply here (task-dispatch.ts's
    // giveUpIfOverdue skips a waiting retry) — see the issue's scope.
    //
    // TWO facts, TWO columns (issue #3194, review round 2):
    //
    //   - `retryHostId` names the host the retry WAITS FOR. It is set for
    //     EVERY original-host wait, whatever the origin state — that is what
    //     offers "Start fresh", the operator's only escape from a wait that
    //     never ends. A wait whose origin state could not be confirmed (a
    //     local-only repository, a project with no GitHub token) is exactly
    //     the one that needs it: without it the task waited forever with no
    //     way out.
    //   - `retryStrandedOnHost` says the branch is CONFIRMED to be only on
    //     that host (GitHub's 404). THAT is what exempts the wait from the
    //     6-hour give-up — failing the task would free nothing, because the
    //     commits stay there. A wait whose branch is safely on origin (or
    //     whose origin state could not be confirmed) is an ordinary
    //     placement wait and keeps the give-up.
    holdRetry(app, task, project, {
      detail: decision.detail,
      waitHostId: decision.hostId,
      strandedOnHost: decision.strandedOnHost,
      requirementJson,
    });
    return { ok: false, reason: "retry-waiting", detail: decision.detail };
  }

  // The host the retry runs on: the original one, or the replacement host it
  // was re-placed onto (the branch is on origin there, so it is checked out
  // from origin).
  const workerHostId = decision.hostId;
  // The project root ON THE WORKER'S HOST. Null when the project is not
  // mapped there — and then there is no directory to resume the worktree in,
  // which is a failure rather than something to paper over with the
  // project's own path (that path does not exist on this host).
  const workerCwd = projectCwdOnHost(project, workerHostId, parseHostCwds(project.hostCwds));
  if (workerCwd === null) {
    app.log.warn(
      { taskId: task.id, hostId: workerHostId },
      "task retry: the worker's host has no path for this project — the worktree cannot be resumed there",
    );
  }

  // Lazy checkout materialization (issue #3194): a replacement host that has
  // no checkout of the project yet gets one cloned in the background; the
  // claim is held while that runs and the next sweep continues. Same shape
  // as the fresh-claim path above.
  if (decision.kind === "replace" && decision.placement.needsCheckout === true) {
    const failedJob = takeFailedMaterialize(project.id, workerHostId);
    if (failedJob !== null) {
      const detail = `could not prepare a checkout on ${workerHostId}: ${failedJob.detail ?? "the clone failed"}`;
      const written = app.db
        .update(tasks)
        .set({
          failureReason: detail,
          // Issue #3194 — the failure clock SURVIVES the attempt, exactly like
          // the fresh-claim path's own `failingSince ?? new Date()` above: a
          // fresh `new Date()` here would restart the 6-hour bound on every
          // sweep, and a host that cannot clone would be asked to clone again
          // for six hours without the retry ever being given up on.
          dispatchFailingSince: task.dispatchFailingSince ?? new Date(),
          dispatchHeld: false,
          // The retry is being RE-PLACED, not waiting for its original host:
          // the branch is on origin (that is the only reason it may leave the
          // original host at all), so nothing is stranded there. The markers
          // of an original-host wait are cleared with it — a stale one would
          // keep offering "Start fresh" on a task that is not waiting for a
          // host, and would keep the give-up exemption this wait must not
          // have (failing it frees something: the branch is on origin).
          retryHostId: null,
          retryStrandedOnHost: false,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
        .run();
      app.log.warn({ taskId, hostId: workerHostId }, `task retry: ${detail}`);
      if (written.changes === 0) {
        // The row left the queue while the clone was failing (cancelled,
        // deleted, or dispatched by someone else): there is nothing left to
        // wait for, and the sweep must not keep a backoff for it.
        return { ok: false, reason: "not-queued" };
      }
      // The row stays `claimed` and the next sweep tries the clone again, so
      // this is a WAIT, not a failure — the sweep gives up on it after 6h
      // (task-dispatch.ts), like every other placement wait.
      return { ok: false, reason: "checkout-failed", detail };
    }
    startMaterialize(app, project.id, workerHostId);
    // This wait is NOT about the original host — the branch is on origin, so
    // nothing is stranded there and failing the task would free something.
    // No wait host is recorded, which keeps "Start fresh" off a task that is
    // not waiting for its original host, and keeps the 6-hour give-up in
    // force for this wait (the issue's scope: the exemption covers the
    // original-host wait only).
    holdRetry(app, task, project, {
      detail: describePreparing(workerHostId),
      waitHostId: null,
      strandedOnHost: false,
      requirementJson,
    });
    return { ok: false, reason: "retry-waiting", detail: describePreparing(workerHostId) };
  }

  const trustHeld = codexTrustHold(app, task, project, command, workerHostId);
  if (trustHeld) return trustHeld;

  // Same atomic reservation shape as dispatchClaimedTask: the cap check and
  // the claimed -> in_progress flip succeed or fail together. The budget clock
  // (claimedAt) starts HERE, at dispatch, so time spent queued behind a full
  // cap is not charged against the retry's budget.
  const taskMasterConfig = resolveTaskMasterConfig(app);
  const maxConcurrent = taskMasterConfig.maxConcurrent;
  const reservation = app.db.transaction((tx) => {
    const [current] = tx.select().from(tasks).where(eq(tasks.id, taskId)).all();
    if (!current || current.status !== "claimed" || !current.resumeQueued) {
      return { reserved: false as const };
    }
    // Defensive: enqueueRetry resets a branchless task to ready instead of
    // queuing it, so a queued branchless row was written by something else.
    if (!current.branchName) return { reserved: false as const, noBranch: true as const };
    const inFlight = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, CONCURRENCY_CAPPED_STATUSES))
      .all();
    if (inFlight.length >= maxConcurrent) {
      return { reserved: false as const, capped: true as const };
    }
    tx.update(tasks)
      .set({
        status: "in_progress",
        claimedAt: new Date(),
        startedAt: new Date(),
        resumeQueued: false,
        // Issue #3194 — the retry owns a host from here on; the waiting
        // markers are dropped with the reservation.
        retryHostId: null,
        retryStrandedOnHost: false,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "claimed")))
      .run();
    return { reserved: true as const, branchName: current.branchName };
  });

  if (!reservation.reserved) {
    if ("capped" in reservation && reservation.capped) {
      return { ok: false, reason: "cap", limit: maxConcurrent, detail: capDetail(maxConcurrent) };
    }
    if ("noBranch" in reservation && reservation.noBranch) {
      failQueuedTask(app, taskId, {
        detail: "Task has no recorded branch to resume — nothing to retry",
        via: "dispatch-give-up",
        hostId: null,
      });
      return {
        ok: false,
        reason: "no-worktree",
        detail: "Task has no recorded branch to resume — nothing to retry",
      };
    }
    // Lost a race with another dispatch of this same task.
    return { ok: false, reason: "not-queued" };
  }
  const branchName = reservation.branchName;
  recordTaskTransition(app, {
    taskId,
    projectId: project.id,
    from: "claimed",
    to: "in_progress",
    via: "retry-dispatch",
    // Issue #3194 — a re-placed retry records the move, so the activity feed
    // says which host owns the task now (and which one it came from).
    context: {
      hostId: workerHostId,
      ...(decision.kind === "replace" ? { movedFrom: originalHostId, movedTo: workerHostId } : {}),
    },
  });

  // Mirrors claimTask's own release() — puts the reservation back rather
  // than leaving a "claimed" row with nothing spawned behind it. Releases
  // to "failed", not "ready": a retry that couldn't even resume the
  // worktree is still the same failed task, safely retryable again.
  //
  // Deliberately does NOT null seedDelivered, unlike claimTask's release()
  // — this retry attempt's own commit block is the only place that would
  // ever overwrite it, so a rolled-back attempt leaves the field exactly as
  // it was: the LAST REAL spawn's actual delivery status (from the original
  // claim, or an earlier successful retry), which is still accurate — this
  // attempt never got far enough to produce a new one.
  //
  // #483/Hermes review: also removes a just-resumed worktree, when one
  // exists — unlike claimTask (which only ever creates a NEW worktree that
  // clearOrphanedTaskWorktree can find and clear on a later attempt),
  // retry's resumeTaskWorktree checks out the task's PRESERVED branch. A
  // release that left that checkout in place would permanently occupy the
  // deterministic path: the next retry's resumeTaskWorktree/`git worktree
  // add <path> <branch>` fails because the path already exists and the
  // branch is already checked out there, worktree-failed forever until a
  // human intervenes — recreating exactly the dead end this feature
  // removes. Best-effort and clean-check-gated (removeWorktreeIfClean,
  // never `--force`): the checkout is fresh with no agent having run yet,
  // so it's expected to be clean; if it somehow isn't, this leaves it in
  // place rather than destroying anything, same posture as every other
  // caller of removeWorktreeIfClean.
  // Issue #1722 / roadmap 8.8 — as in the worker path above: the
  // worktree cleanup below is PROJECT-scoped (the task's worktree), and
  // the spawn host is the placement decision #1724 owns.
  async function release(reason: string, worktreeToClean?: { path: string }): Promise<void> {
    if (worktreeToClean && workerCwd !== null) {
      await removeCheckoutIfClean(app, {
        projectId: task.projectId,
        hostId: workerHostId,
        worktreePath: worktreeToClean.path,
        parentCwd: workerCwd,
      }).catch((err: unknown) => {
        app.log.warn(
          { err, taskId, worktreePath: worktreeToClean.path },
          "task retry: failed to clean up the resumed worktree after a later failure",
        );
      });
    }
    const updated = app.db
      .update(tasks)
      .set({
        status: "failed",
        failureReason: reason,
        failureDiagnostics: null,
        // Issue #3194 — the retry is not waiting for a host any more.
        retryHostId: null,
        retryStrandedOnHost: false,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "in_progress"), isNull(tasks.sessionId)))
      .run();
    // #488 — previously unlogged: retry's own rollback back to "failed" had
    // no signal of any kind before.
    if (updated.changes > 0) {
      recordTaskTransition(app, {
        taskId,
        projectId: project.id,
        from: "in_progress",
        to: "failed",
        via: "retry-release",
        context: { reason },
      });
    }
  }

  // Issue #1724 — the task's worktree was cut on the host its WORKER was
  // placed on, which is not necessarily the project's own host. So the
  // retry resumes it THERE, from the project root as it is there — the
  // repo-level git operations stay on the project's host (that is where the
  // repository lives), but the checkout this session works in has to be on
  // the machine the session runs on.
  //
  // Issue #3194 — `workerHostId`/`workerCwd` are decided ABOVE (the retry's
  // host decision), not re-derived here: a re-placed retry resumes on the
  // host it was moved to, and the branch is checked out FROM ORIGIN there
  // (it was confirmed to be on origin — that is the only reason a retry may
  // leave its original host).

  let committed = false;
  // Hoisted out of the try block (rather than a `const` declared inside
  // it) so the catch block below can also clean it up if anything between a
  // successful resume and the DB commit throws.
  let worktree: Awaited<ReturnType<SessionBackend["resumeTaskWorktree"]>> = null;
  try {
    // #484 — an old agent build (predating this proxy route) surfaces as a
    // 404 HostRequestError, distinguished here from every other resume
    // failure (branch missing/checked out elsewhere, or the host being
    // unreachable) so a version-skew gap reads as "not supported yet, ok
    // to retry once upgraded," not a generic worktree-failed. Independent
    // review, PR #590 — HostRequestError covers ANY 4xx (a genuine
    // resolveWithinRoots 400, not just a missing route), so this checks
    // `statusCode === 404` specifically rather than the class alone; any
    // other HostRequestError falls through to the generic catch below.
    if (workerCwd === null) {
      // The worker's host has no path for this project, so there is no
      // directory to resume the worktree in. Retrying against a path that
      // does not exist there would fail as a missing branch, which says
      // nothing about the real cause; say the real cause instead.
      await release("the worker's host has no path for this project");
      return { ok: false, reason: "worktree-failed" };
    }
    const backend = resolveBackend(app, workerHostId);
    try {
      // Issue #3194 — a re-placed retry checks the branch out FROM ORIGIN:
      // the branch lives on the ORIGINAL host, so this host has never seen it.
      // The original host's own resume never fetches (its branch is local),
      // so that path keeps the plain two-argument call.
      worktree =
        decision.kind === "replace"
          ? await backend.resumeTaskWorktree(workerCwd, branchName, { fromOrigin: true })
          : await backend.resumeTaskWorktree(workerCwd, branchName);
    } catch (err) {
      if (err instanceof HostRequestError && err.statusCode === 404) {
        await release("this host's agent build doesn't support retrying a remote-hosted task yet");
        return {
          ok: false,
          reason: "remote-not-supported",
          detail:
            "This host's agent build doesn't support retrying a remote-hosted task yet — update it and retry",
        };
      }
      throw err;
    }
    if (!worktree) {
      // Issue #3194 — a re-placed retry resumes from ORIGIN, and the host
      // refuses when it cannot. There are THREE ways it refuses, and the
      // operator needs all three: the branch is no longer on origin, this
      // host's own ref has commits origin does not (git refuses the
      // non-fast-forward), or this host already has a checkout of the branch
      // (git refuses to move a checked-out branch). The last one is the
      // only thing here a human can clear, but the first two are what a
      // host that ran this task earlier looks like — so all three are named.
      const fromOrigin = decision.kind === "replace";
      await release(
        fromOrigin
          ? "could not resume the branch from origin — it may no longer be there, this host may hold commits origin does not, or it already has a checkout of it"
          : "could not resume the preserved branch — it may no longer exist or is checked out elsewhere",
      );
      return {
        ok: false,
        reason: "worktree-failed",
        detail: fromOrigin
          ? `Could not check out ${branchName} from origin — it may no longer be there, this host may hold commits origin does not, or it already has a checkout of it`
          : `Could not check out ${branchName} into a fresh worktree — it may no longer exist, or is already checked out elsewhere`,
      };
    }

    // No `worktree:` intent here (unlike claimTask's createSessionRecord
    // call) — the worktree above already exists on disk; `cwd` is used
    // directly rather than asking createSessionRecord to create a new one.
    // `initialPrompt`, not stashSeed — same reasoning as claimTask's own
    // doc comment: additionalContext never submits a turn, and a retry
    // spawning an unattended agent is exactly the unattended case that bit.
    // Same preamble as a fresh claim, plus a retry note — the branch
    // already carries the earlier attempt's commits, and without saying so
    // a retry looks like a fresh start on a mysteriously non-empty tree.
    // #939/#1016 — same resolve-once, fail-open context as claimTask's own
    // spawn above.
    const issueContext = await resolveTaskIssueContextSafe(app, task, project);
    const prompt = buildWorkerPrompt({
      task: {
        ...task,
        comments: issueContext?.comments,
        parent: issueContext?.parent,
        siblings: issueContext?.siblings,
      },
      branchName,
      worktreePath: worktree.path,
      budgetMinutes: taskMasterConfig.budgetMinutes,
      mode: "retry",
      reusedWorktree: worktree.reused === true,
      agentCommand: command,
      delegation: resolveWorkerDelegation(app, command, task),
      // #778 — resolved against the OWNING host's own sessionsDir; see
      // task-reconciler.ts's spawnReviewAgentNow for the full rationale.
      commitTitlePath: project.conventionalCommitTitles
        ? taskCommitTitlePath(
            await resolveSessionsDirWithFallback(app, backend, {
              taskId: task.id,
              // Issue #1724 — the retry runs on the host that holds the
              // task's worktree, so that is the host whose sessions dir
              // the commit title path belongs to.
              hostId: workerHostId,
            }),
            task.id,
          )
        : undefined,
    });
    // Issue #2491 — the same resolution as the claim spawn, so a model picked
    // after the failure reaches the retried worker (and `tasks.model` records
    // what this attempt ran with).
    const { model, smallModel } = resolveWorkerSpawnModels(app, command, {
      modelOverride,
      smallModelOverride,
      body: task.body,
    });
    const result = await createSessionRecord(app, {
      projectId: project.id,
      command,
      cwd: worktree.path,
      model,
      smallModel,
      initialPrompt: seedCapable ? prompt : undefined,
      skipPermissions: taskMasterConfig.skipPermissions,
      // #9 — see the claim spawn's own comment (above, in this same file).
      name: taskWorkerSessionName(task.id),
      nameLocked: true,
      // Same "this is an unattended Task Master worker" marker as
      // dispatchClaimedTask's claim spawn above — see that block's own
      // comment for why a retry worker needs the brainstorming / writing-
      // plans / finishing-a-development-branch denials too (an opencode
      // worker respawned mid-task can hit the same failure mode).
      taskId: task.id,
      // Issue #1724 — the retry reuses the task's EXISTING worktree
      // (`cwd: worktree.path`), which lives on the host the worker was
      // placed on. So the retry JOINS that host rather than being placed
      // again: a session cannot run in a directory that is not on its
      // machine.
      unattended: true,
      hostId: workerHostId,
      placementReason:
        decision.kind === "replace"
          ? `task #${task.id} retry re-placed onto ${workerHostId} (its original host ${originalHostId} is offline; the branch is on origin)`
          : `task #${task.id} retry joins its worker's host ${workerHostId} (the worktree lives there)`,
    });
    if (!result.ok) {
      const reason =
        result.reason === "outcome-unknown"
          ? (result.detail ?? "session spawn outcome unknown")
          : "session spawn failed";
      // #2621 — same adoption as dispatchClaimedTask: the retry's spawn may
      // have landed in the task's worktree, so point the task at the kept
      // row instead of releasing it into a second respawn.
      const kept =
        result.reason === "outcome-unknown" && result.sessionId !== undefined
          ? app.db.select().from(sessions).where(eq(sessions.id, result.sessionId)).get()
          : undefined;
      if (kept !== undefined) {
        const keptPatch: Partial<typeof tasks.$inferInsert> = {
          status: "in_progress",
          startedAt: new Date(),
          sessionId: kept.id,
          worktreePath: kept.cwd,
          agentCommand: command,
          model: model ?? null,
          smallModel: smallModel ?? null,
          seedDelivered: false,
          failureReason: reason,
          dispatchFailingSince: null,
          completedAt: null,
          // Issue #1038 — same stale-announcement clears as the success patch.
          autoReturnCapAnnouncedAt: null,
          ...CLEARED_NEEDS_HUMAN,
          approvalCarriedAt: null,
        };
        const adopted = app.db
          .update(tasks)
          .set(keptPatch)
          .where(
            and(eq(tasks.id, taskId), eq(tasks.status, "in_progress"), isNull(tasks.sessionId)),
          )
          .run();
        committed = true;
        if (adopted.changes === 0) {
          // The task moved on while the retry's spawn was in flight: nothing
          // points at the kept row, so reap it.
          app.log.warn(
            { taskId, sessionId: kept.id },
            "task retry: task changed while its worker was spawning — killing the orphaned session",
          );
          await killSession(app, kept.id);
          return { ok: false, reason: "spawn-failed", detail: reason };
        }
        return { ok: false, reason: "spawn-failed", detail: reason };
      }
      await release(reason, worktree);
      return { ok: false, reason: "spawn-failed", detail: reason };
    }

    // Issue #1724 — the retry runs on the worker host (it resumes the
    // task's worktree, which lives there), so that is the host whose
    // version skew matters here.
    const seedDelivered = resolveSeedDelivered(
      seedCapable,
      workerHostId,
      result.initialPromptApplied,
    );

    // The row is already `in_progress` (reserved above, which is what holds the
    // concurrency slot); this commits the session it now has.
    const patch: Partial<typeof tasks.$inferInsert> = {
      status: "in_progress",
      startedAt: new Date(),
      sessionId: result.row.id,
      worktreePath: result.row.cwd,
      agentCommand: command,
      model: model ?? null,
      smallModel: smallModel ?? null,
      seedDelivered,
      // Issue #1038 — a give-up on a capped, announced "reviewing" task
      // lands on "failed" without clearing this (give-up's own write only
      // touches status/failureReason/completedAt), so a retry from there is
      // the one path that can otherwise carry a stale announcement into a
      // fresh in_progress run.
      autoReturnCapAnnouncedAt: null,
      ...CLEARED_NEEDS_HUMAN,
      approvalCarriedAt: null,
    };
    app.db.update(tasks).set(patch).where(eq(tasks.id, taskId)).run();
    committed = true;

    // Fire-and-forget, same reasoning as claimTask's own sync call.
    void syncTaskTransition(
      app,
      {
        ...task,
        status: "in_progress",
        sessionId: result.row.id,
        worktreePath: result.row.cwd,
        agentCommand: command,
        failureReason: null,
        failureDiagnostics: null,
        completedAt: null,
      },
      project,
      "in_progress",
    );

    const idleThresholdMs = getStoredSettings(app.db).notifications.idleThresholdSeconds * 1000;
    // Issue #1722 / roadmap 8.8 — the SESSION's host: the row exists now,
    // and the live status has to come from the host this session actually
    // runs on (a placement policy may have put it somewhere other than the
    // task's project).
    const session = await withLiveStatus(
      app,
      result.row,
      idleThresholdMs,
      resolveSessionHostId(app, result.row),
    );
    return { ok: true, session, seedDelivered };
  } catch (err) {
    if (committed) throw err;
    await release(
      err instanceof Error ? err.message : "unexpected error during retry",
      worktree ?? undefined,
    );
    app.log.error({ err, taskId }, "task retry: unexpected error, reservation released");
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// Issue #2491 — the task-level model columns a claim/retry-time agent change
// must clear (an opencode `provider/model` does not fit a codex worker).
// Two triggers: an explicit agent/reviewAgent in `opts` (the PATCH route's
// family rule), and a worker family that no longer matches the one the task
// last ran under (`task.agentCommand`) — e.g. the project default agent
// changed between a failure and a bare retry. An unknown project fails open.
// Only agent fields are passed to the resolver, so its `{ error }` arm is
// unreachable here and is treated as "nothing to clear".
export function agentChangeModelClears(
  app: FastifyInstance,
  task: typeof tasks.$inferSelect,
  project: typeof projects.$inferSelect,
  opts: { agent?: string | null; reviewAgent?: string | null },
): Partial<typeof tasks.$inferInsert> {
  const patch: Partial<typeof tasks.$inferInsert> = {};
  if (opts.agent !== undefined || opts.reviewAgent !== undefined) {
    const resolved = resolveTaskModelPatch(app, task, project, {
      agent: opts.agent,
      reviewAgent: opts.reviewAgent,
    });
    if ("patch" in resolved) Object.assign(patch, resolved.patch);
  }
  // Drift only happens when no explicit agent pins the worker: a pinned agent
  // means the stored override was validated against it (the PATCH route), so
  // `agentCommand` (the LAST run's worker) being stale must not wipe it.
  const effectiveAgent = opts.agent !== undefined ? opts.agent : task.agent;
  if (
    task.agentCommand !== null &&
    (task.modelOverride || task.smallModelOverride) &&
    !workerAgentPinned(effectiveAgent)
  ) {
    const next = resolveAgentCommand(app, {
      taskAgent: effectiveAgent,
      issueBody: task.body,
      projectDefaultAgent: project.defaultAgent,
    });
    if (modelFamily(next) !== modelFamily(task.agentCommand)) {
      if (task.modelOverride) patch.modelOverride = null;
      if (task.smallModelOverride) patch.smallModelOverride = null;
    }
  }
  return patch;
}
