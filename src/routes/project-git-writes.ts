// The project Git WRITE routes, moved out of src/routes/projects.ts
// (issue #2475).
//
// This file is a MOVE, not a rewrite: the routes, their schemas, their status
// codes and their error mapping are exactly what they were. It exists because
// src/routes/projects.ts was one 3,987-code-line function holding four
// unrelated surfaces, and the file-size guardrail turns over one ceiling at a
// time.
//
// projectsRoute() calls projectGitWritesRoute() at the position this block
// used to occupy, immediately after projectGitRoute(), so Fastify registration
// ORDER — and the plugin encapsulation context the routes are registered in —
// are unchanged. It is a plain call, not an app.register(): a registered plugin
// is deferred to the end of the enclosing plugin, which would reorder the
// routes.
//
// The READ side of the same surface (status, refs, log, commit reads) lives in
// project-git.ts, which projectsRoute() calls immediately before this one.
//
// The four local helpers below move with these routes: each is used ONLY by
// them, so leaving them in projects.ts would either export them across a
// module boundary for no reason or make
// projects.ts -> project-git-writes.ts -> projects.ts an import cycle.

import { removeListedCheckout } from "../services/checkout-removal.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import {
  getRemoteHostClient,
  HostRequestError,
  HostUnreachableError,
} from "../services/remote-host-client.js";
import {
  isHostBusyError,
  isOutcomeUnknown,
  unknownOutcomeDetail,
  unknownOutcomeText,
} from "../services/remote-host-errors.js";
import { isHostTransientError } from "../services/remote-host-errors.js";
import { resolveBackend } from "../services/session-backend.js";
import { resolveSessionHostId } from "../services/session-live-info.js";
import { forwardHostRequestError } from "../services/host-error-reply.js";
import { loadScopedProject, replyUnsupportedOnAgent } from "../services/session-git-scope.js";
import {
  claimReclaimSlot,
  recordReclaimed,
  releaseReclaimSlot,
} from "../services/session-worktree-reclaim.js";
import { isGitRepo } from "../services/git-status.js";
import { runGitFetch } from "../services/git-fetch.js";
import { inspectGitClone, planRepair, repairGitClone } from "../services/git-doctor.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "../services/git-clone-busy.js";
import { runGitPull } from "../services/git-pull.js";
import {
  isWithinAnyWorktree,
  listWorktrees,
  getBranchDetail,
  isPlainBranchName,
} from "../services/git-refs.js";
import type { DeleteBranchResult } from "../services/git-branch-delete.js";
import { planPrune } from "../services/branch-merge-state.js";
import type { RemoveListedWorktreeResult } from "../services/git-worktree.js";
import type { GitBranchOpResult } from "../services/git-branch-ops.js";
import { RESUMABLE_TASK_STATUSES, sessionsUsingWorktree } from "../services/worktree-usage.js";
import path from "node:path";
import { resolveProjectGitBranches } from "./project-git.js";
import type { ProjectGitBranchesResult } from "./project-git.js";

/**
 * A `mullion/task-<N>` branch referenced by a task in a resumable state
 * refuses manual deletion unless `force` — `resumeTaskWorktree` (issue
 * #483) checks that branch out for Retry, and it 502s `worktree-failed`
 * once it's gone (see docs/tasks.md's Worktree lifecycle section). Returns
 * the task id when a match is found, else `null`.
 */
function branchClaimedByResumableTask(
  app: FastifyInstance,
  projectId: number,
  branchName: string,
): number | null {
  const [row] = app.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.branchName, branchName),
        inArray(tasks.status, RESUMABLE_TASK_STATUSES),
      ),
    )
    .all();
  return row?.id ?? null;
}

/** Resumable tasks retain a durable reference even after their worker ends. */
function taskSessionsUnderWorktree(
  app: FastifyInstance,
  project: { id: number },
  worktreePath: string,
): number[] {
  const matched = new Set<number>();
  const resolvedTarget = path.resolve(worktreePath);
  const taskRows = app.db
    .select({ sessionId: tasks.sessionId, worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), inArray(tasks.status, RESUMABLE_TASK_STATUSES)))
    .all();
  for (const t of taskRows) {
    if (
      t.sessionId !== null &&
      t.worktreePath !== null &&
      path.resolve(t.worktreePath) === resolvedTarget
    ) {
      matched.add(t.sessionId);
    }
  }

  return [...matched];
}

/**
 * Issue #1672 — the active sessions working IN the project's own checkout,
 * which a checkout/rebase would yank out from under them: an effective cwd
 * at or below `project.cwd`, but not inside one of its linked worktrees
 * (`.mullion-worktrees/…`, `.wt/…` live below the checkout yet have their
 * own HEAD and index, which these operations never touch). A session with
 * no cwd of its own runs in its project's cwd, so it counts.
 *
 * Matched by directory and host, not by `projectId`: two project rows may
 * point at one clone (see git-clone-busy.ts), and a session of the other
 * one is just as much in the way.
 *
 * Same remote-host gap as `sessionsUnderWorktree` above: only the DB cwd is
 * known for a remote session, not the live one.
 */
function sessionsInProjectCheckout(
  app: FastifyInstance,
  project: { id: number; hostId: string; cwd: string },
  linkedWorktreePaths: string[],
  exceptSessionId?: number,
): number[] {
  const rows = app.db
    .select({
      id: sessions.id,
      cwd: sessions.cwd,
      hostId: sessions.hostId,
      projectCwd: projects.cwd,
      projectHostId: projects.hostId,
    })
    .from(sessions)
    .leftJoin(projects, eq(sessions.projectId, projects.id))
    .where(eq(sessions.status, "active"))
    .all();
  const matched: number[] = [];
  for (const row of rows) {
    if (row.id === exceptSessionId) continue;
    // NULL inherits the project's host — resolveSessionHostId (session-live-info.ts).
    const hostId = row.hostId ?? row.projectHostId;
    if (hostId !== project.hostId) continue;
    let effectiveCwd = row.cwd ?? row.projectCwd;
    if (hostId === LOCAL_HOST_ID) {
      const liveCwd = app.pty.get(String(row.id))?.liveCwd;
      if (liveCwd && isGitRepo(liveCwd)) effectiveCwd = liveCwd;
    }
    if (
      effectiveCwd &&
      isWithinAnyWorktree(effectiveCwd, [project.cwd]) &&
      !isWithinAnyWorktree(effectiveCwd, linkedWorktreePaths)
    ) {
      matched.push(row.id);
    }
  }
  return matched;
}

/**
 * The message for a remote host that could not answer a git request.
 *
 * An agent that REJECTED the request is alive and answering: a 400 for a cwd
 * outside its PROJECTS_ROOTS, or a 404 from an agent that predates the route
 * (the mixed-version fleet case, #244 and #527). "Unreachable" is a different
 * fact, and the wrong one here — the 503 stays, but the message says which
 * it was.
 */
function hostFailMsg(app: FastifyInstance, hostId: string, err: unknown, what: string): string {
  const message =
    err instanceof HostRequestError
      ? `Host ${hostId} rejected ${what}: ${err.message}`
      : isOutcomeUnknown(err)
        ? unknownOutcomeText(what, unknownOutcomeDetail(err))
        : `Host ${hostId} is unreachable`;
  app.log.warn({ hostId, err }, message);
  return message;
}

export async function projectGitWritesRoute(app: FastifyInstance): Promise<void> {
  // Manual fetch trigger — POST /api/projects/:id/git-fetch runs
  // `git fetch origin` for this project now, regardless of auto-fetch
  // settings. Returns { success: boolean, error?: string }.
  const gitFetchParamsSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
    },
  };
  // Issue #1851 — a read-only health check on this project's clone: is it
  // whole, or has a background `git gc` damaged it? It never mutates
  // anything; the repair stays a deliberate, operator-run action.
  //
  // The doctor lives in src/services/git-doctor.ts so the CLI
  // (scripts/git-doctor.mjs) and this route share one implementation.
  app.post<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/projects/:id/git-health",
    { schema: gitFetchParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      if (project.hostId === LOCAL_HOST_ID) {
        return await inspectGitClone(project.cwd);
      }

      try {
        return await getRemoteHostClient(app, project.hostId).resolveGitHealth(project.cwd);
      } catch (err) {
        return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "the health check"));
      }
    },
  );

  // Issue #1896 — the REPAIR, for a clone the health check found damage in.
  //
  // Two phases in one endpoint, because the plan and the repair must be the
  // same decision: without `confirm` this returns the PLAN (computed from
  // reads only — nothing is touched), and with `confirm: true` it runs the
  // repair and returns what it actually did.
  //
  // The repair moves files inside `.git/objects` and rewrites the index of
  // every worktree of the clone, so it is behind an explicit confirmation in
  // the UI, and two repairs for one project cannot run at once: they would
  // mean two quarantine directories and two index rebuilds over the same tree.
  const gitRepairParamsSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
    },
    body: {
      // `["object", "null"]`, not `object`: a request with NO body is the
      // PLAN (nothing confirmed, nothing touched), and Fastify rejects a
      // missing body outright when the schema says `object`.
      type: ["object", "null"],
      properties: { confirm: { type: "boolean" } },
      additionalProperties: false,
    },
  };
  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { confirm?: boolean };
  }>(
    "/api/projects/:id/git-repair",
    { schema: gitRepairParamsSchema, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      // The plan is a READ. Only the confirmed repair mutates anything, and
      // only that one takes the in-flight slot.
      if (request.body?.confirm !== true) {
        if (project.hostId === LOCAL_HOST_ID) {
          return await planRepair(project.cwd);
        }
        try {
          return await getRemoteHostClient(app, project.hostId).resolveGitRepair(project.cwd, {
            confirm: false,
          });
        } catch (err) {
          return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "the repair"));
        }
      }

      // The CLONE is the resource, not the project: two project rows can
      // point at the same directory, and the background auto-fetch sweep
      // runs `git fetch` on the same clone on a timer — a fetch landing
      // inside the repair's own fetch window would fail the ref update and
      // make a healthy clone look broken. The registry is the same one the
      // sweep uses, so the two exclude each other.
      if (isCloneBusy(project.hostId, project.cwd)) {
        return reply.conflict("A git operation is already running for this repository.");
      }
      markCloneBusy(project.hostId, project.cwd);
      try {
        if (project.hostId === LOCAL_HOST_ID) {
          const lines: string[] = [];
          const outcome = await repairGitClone(project.cwd, { log: (line) => lines.push(line) });
          app.log.info({ projectId, lines }, "git repair finished");
          return outcome;
        }
        try {
          return await getRemoteHostClient(app, project.hostId).resolveGitRepair(project.cwd, {
            confirm: true,
          });
        } catch (err) {
          if (replyUnsupportedOnAgent(err, request.query.sessionId, project.hostId, reply))
            return reply;
          return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "the repair"));
        }
      } finally {
        releaseClone(project.hostId, project.cwd);
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/projects/:id/git-fetch",
    { schema: gitFetchParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      // The clone is claimed for the fetch, so a manual Fetch cannot land
      // inside a repair's own fetch window (issue #1896) — the same registry
      // the background sweep and the repair use.
      if (isCloneBusy(project.hostId, project.cwd)) {
        return reply.conflict("A git operation is already running for this repository.");
      }
      markCloneBusy(project.hostId, project.cwd);
      try {
        if (project.hostId === LOCAL_HOST_ID) {
          return await runGitFetch(project.cwd);
        }

        try {
          return await getRemoteHostClient(app, project.hostId).resolveGitFetch(project.cwd);
        } catch (err) {
          if (replyUnsupportedOnAgent(err, request.query.sessionId, project.hostId, reply))
            return reply;
          return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "the git fetch"));
        }
      } finally {
        releaseClone(project.hostId, project.cwd);
      }
    },
  );

  // Manual fast-forward pull trigger (issue #745) — POST /api/projects/:id/git-pull
  // runs `git merge --ff-only @{u}` after fetching for this project.
  // Returns GitPullResult ({ pulled: boolean, reason?, detail? }).
  const gitPullParamsSchema = {
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
    },
  };
  app.post<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/projects/:id/git-pull",
    { schema: gitPullParamsSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      // The clone is claimed for the pull: it fetches and merges, and the
      // merge writes the index the repair rewrites (issue #1896).
      if (isCloneBusy(project.hostId, project.cwd)) {
        return reply.conflict("A git operation is already running for this repository.");
      }
      markCloneBusy(project.hostId, project.cwd);
      try {
        if (project.hostId === LOCAL_HOST_ID) {
          return await runGitPull(project.cwd);
        }

        try {
          return await getRemoteHostClient(app, project.hostId).resolveGitPull(project.cwd);
        } catch (err) {
          if (replyUnsupportedOnAgent(err, request.query.sessionId, project.hostId, reply))
            return reply;
          return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "git pull"));
        }
      } finally {
        releaseClone(project.hostId, project.cwd);
      }
    },
  );

  // Issue #442 — Source Control manual branch deletion. POST, not DELETE (a
  // branch name can contain "/"). Same write-tier rate limit as git-fetch
  // above, rather than git-status's 30/min.
  const gitBranchDeleteBodySchema = {
    body: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        // maxLength (Hermes review on PR #505) — cheap defense-in-depth
        // against an oversized payload reaching the git spawn arg; harmless
        // either way (deleteBranch's own precheck just reports no-such-
        // branch for anything that doesn't resolve), but no real branch
        // name is remotely this long.
        name: { type: "string", minLength: 1, maxLength: 255 },
        force: { type: "boolean" },
      },
    },
  };
  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { name: string; force?: boolean };
  }>(
    "/api/projects/:id/git-branch-delete",
    {
      schema: gitBranchDeleteBodySchema,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      const { name, force } = request.body;

      // Task-branch guard (binding decision #5). Force always overrides —
      // this is a UX safety net for Source Control's two-step confirm, not a
      // security boundary: anyone with host access to this project can
      // already run `git branch -D` directly in a terminal session with no
      // confirmation at all, so a caller sending `force: true` on the very
      // first request isn't bypassing anything the underlying host doesn't
      // already permit. What this fixes (Hermes review on PR #505): the
      // lookup used to be skipped ENTIRELY under `force`, so a force-delete
      // of a still-resumable task's branch left no trace anywhere. It now
      // always runs, and a force bypass is logged, so it's diagnosable
      // after the fact even though it remains permitted.
      const taskId = branchClaimedByResumableTask(app, project.id, name);
      if (taskId !== null) {
        if (!force) {
          const result:
            DeleteBranchResult | { deleted: false; reason: "task-branch"; detail: string } = {
            deleted: false,
            reason: "task-branch",
            detail: `#${taskId}`,
          };
          return result;
        }
        app.log.warn(
          { projectId: project.id, branchName: name, taskId },
          "force-deleting a branch referenced by a resumable task — its Retry will break",
        );
      }

      const backend = resolveBackend(app, project.hostId);
      try {
        return await backend.deleteBranch(project.cwd, name, { force });
      } catch (err) {
        if (replyUnsupportedOnAgent(err, request.query.sessionId, project.hostId, reply))
          return reply;
        return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, "git branch delete"));
      }
    },
  );

  // Issue #1672 — guarded checkout / create / rebase of the project's own
  // checkout, from the Git view. Each goes through the host's backend (an
  // agent runs the same git-branch-ops.ts) and claims the clone like Pull.
  // A refusal is a 200 with a reason (GitBranchOpResult), never a 4xx:
  // the dirty-tree, conflict and branch-state guards are git-branch-ops.ts's,
  // and the one that needs the DB — an active session working in the
  // checkout — runs here first, before the host is asked to touch anything.
  const branchRefSchema = { type: "string", minLength: 1, maxLength: 255 } as const;
  const projectIdParamsSchema = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[1-9][0-9]*$" } },
  } as const;

  async function runGuardedBranchOp(
    projectId: number,
    sessionId: string | undefined,
    reply: FastifyReply,
    opts: { movesHead: boolean; label: string },
    op: (
      backend: ReturnType<typeof resolveBackend>,
      project: typeof projects.$inferSelect,
    ) => Promise<GitBranchOpResult>,
  ): Promise<GitBranchOpResult | FastifyReply> {
    const project = await loadScopedProject(app, projectId, sessionId, reply);
    if (!project) return reply;
    if (isCloneBusy(project.hostId, project.cwd)) {
      return { ok: false, reason: "busy", detail: "A git operation is already running" };
    }
    markCloneBusy(project.hostId, project.cwd);
    try {
      const backend = resolveBackend(app, project.hostId);
      if (opts.movesHead) {
        const worktrees =
          project.hostId === LOCAL_HOST_ID
            ? await listWorktrees(project.cwd)
            : ((
                await getRemoteHostClient(app, project.hostId).resolveGitBranches(
                  project.cwd,
                  false,
                )
              )?.worktrees ?? null);
        // A project may itself be rooted in a linked worktree: that one is
        // the checkout being guarded, not a neighbour to exclude.
        const linked = (worktrees ?? [])
          .filter((w) => !w.isMain && !isWithinAnyWorktree(project.cwd, [w.path]))
          .map((w) => w.path);
        const sid = sessionId === undefined ? undefined : Number(sessionId);
        const sessionIds = sessionsInProjectCheckout(app, project, linked, sid);
        if (sessionIds.length > 0) {
          return { ok: false, reason: "sessions-active", detail: sessionIds.join(",") };
        }
      }
      return await op(backend, project);
    } catch (err) {
      if (isHostBusyError(err)) {
        app.log.warn(
          { hostId: project.hostId, err },
          `host busy, git ${opts.label} temporarily unavailable`,
        );
        return reply
          .status(503)
          .send({ message: `Host ${project.hostId} is busy`, retryable: true });
      }
      if (!(err instanceof HostUnreachableError || err instanceof HostRequestError)) throw err;
      if (replyUnsupportedOnAgent(err, sessionId, project.hostId, reply)) return reply;
      return reply.serviceUnavailable(hostFailMsg(app, project.hostId, err, `git ${opts.label}`));
    } finally {
      releaseClone(project.hostId, project.cwd);
    }
  }

  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { branch: string };
  }>(
    "/api/projects/:id/git-checkout",
    {
      schema: {
        params: projectIdParamsSchema,
        body: {
          type: "object",
          required: ["branch"],
          additionalProperties: false,
          properties: { branch: branchRefSchema },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) =>
      runGuardedBranchOp(
        Number(request.params.id),
        request.query.sessionId,
        reply,
        { movesHead: true, label: "checkout" },
        (backend, project) => backend.checkoutBranch(project.cwd, request.body.branch),
      ),
  );

  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { name: string; from: string; checkout?: boolean };
  }>(
    "/api/projects/:id/git-branch-create",
    {
      schema: {
        params: projectIdParamsSchema,
        body: {
          type: "object",
          required: ["name", "from"],
          additionalProperties: false,
          properties: {
            name: branchRefSchema,
            from: branchRefSchema,
            checkout: { type: "boolean" },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { name, from, checkout } = request.body;
      // Creating a branch alone moves nothing; switching to it does.
      return runGuardedBranchOp(
        Number(request.params.id),
        request.query.sessionId,
        reply,
        { movesHead: checkout === true, label: "branch create" },
        (backend, project) => backend.createBranch(project.cwd, name, from, { checkout }),
      );
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { onto?: string };
  }>(
    "/api/projects/:id/git-rebase",
    {
      schema: {
        params: projectIdParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          properties: { onto: branchRefSchema },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) =>
      runGuardedBranchOp(
        Number(request.params.id),
        request.query.sessionId,
        reply,
        { movesHead: true, label: "rebase" },
        (backend, project) => backend.rebaseBranch(project.cwd, request.body?.onto),
      ),
  );

  // A3 — one branch's drilldown: upstream / base ahead-behind, the commits
  // only it has, worktree, task claim and PR. Local projects only (a remote
  // host's git is behind the agent; History on remote hosts is A4's seam).
  app.get<{ Params: { id: string }; Querystring: { sessionId?: string; name?: string } }>(
    "/api/projects/:id/git-branch",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const name = request.query.name;
      if (!name || !isPlainBranchName(name)) return reply.badRequest("Invalid branch name");
      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;
      if (project.hostId !== LOCAL_HOST_ID) {
        reply.code(204);
        return;
      }
      const [detail, refs] = await Promise.all([
        getBranchDetail(project.cwd, name),
        resolveProjectGitBranches(app, project, true),
      ]);
      if (!detail || !refs) return reply.notFound("Branch not found");
      const branch = refs.branches.find((b) => b.name === name);
      const worktree = refs.worktrees.find((w) => w.branch === name);
      const taskId = branchClaimedByResumableTask(app, project.id, name);
      return {
        ...detail,
        isCurrent: branch?.isCurrent ?? false,
        mergeState: branch?.mergeState ?? null,
        pr: branch?.pr ?? null,
        worktreePath: worktree?.path ?? null,
        taskId,
      };
    },
  );

  // A3 — local-only prune of branches that are done (merged by ancestry,
  // upstream deleted, or squash-merged PR). `confirm` deletes `names`, each
  // re-validated against a fresh read first: a stale preview must never widen
  // what gets deleted. The remote is never touched.
  const gitBranchPruneBodySchema = {
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
        names: {
          type: "array",
          maxItems: 200,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 255 },
        },
      },
    },
  };
  app.post<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { dryRun?: boolean; confirm?: boolean; names?: string[] };
  }>(
    "/api/projects/:id/git-branch-prune",
    {
      schema: gitBranchPruneBodySchema,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      const { dryRun, names } = request.body ?? {};
      // Deleting needs an explicit confirm; dryRun:true always wins.
      const confirm = request.body?.confirm === true && dryRun !== true;
      if (confirm && (!names || names.length === 0)) {
        return reply.badRequest("confirm requires names");
      }
      // Local only, like the branch detail route: a remote host's branches
      // are not ours to delete through this preview-and-confirm flow.
      if (project.hostId !== LOCAL_HOST_ID) {
        reply.code(204);
        return;
      }

      let refs: ProjectGitBranchesResult | null;
      try {
        // Fresh PR read on confirm: the delete decision is re-validated here.
        refs = await resolveProjectGitBranches(app, project, true, { freshPrs: confirm === true });
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, git branch prune failed");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
      if (!refs) {
        reply.code(204);
        return;
      }
      const plan = planPrune(
        refs.branches,
        refs.worktrees,
        refs.defaultBranch,
        (name) => branchClaimedByResumableTask(app, project.id, name) !== null,
      );
      if (!confirm) return { dryRun: true, ...plan, deleted: [], failed: [] };

      const byName = new Map(plan.candidates.map((c) => [c.name, c]));
      const guarded = new Map(plan.skipped.map((s) => [s.name, s.why]));
      const backend = resolveBackend(app, project.hostId);
      const deleted: string[] = [];
      const failed: { name: string; why: string }[] = [];
      for (const name of names ?? []) {
        const candidate = byName.get(name);
        if (!candidate) {
          failed.push({ name, why: guarded.get(name) ?? "not-prunable" });
          continue;
        }
        try {
          // `ancestor` is provably contained in the base, so plain -d. The
          // other signals (squash-merged PR, upstream gone) can't satisfy -d
          // and were re-validated above, hence -D.
          const force = candidate.reason !== "ancestor";
          if (force) {
            app.log.warn(
              { projectId: project.id, branchName: name, reason: candidate.reason },
              "git-branch-prune: force-deleting a branch that is not an ancestor of the base",
            );
          }
          const result = await backend.deleteBranch(project.cwd, name, { force });
          if (result.deleted) deleted.push(name);
          else failed.push({ name, why: result.reason ?? "delete-failed" });
        } catch (err) {
          app.log.warn({ hostId: project.hostId, err }, "git branch prune: delete failed");
          failed.push({ name, why: "delete-failed" });
        }
      }
      return { dryRun: false, ...plan, deleted, failed };
    },
  );

  // Issue #442 — Source Control manual worktree removal. Validity gate is
  // membership in `listWorktrees` (git-worktree.ts's removeListedWorktree),
  // not a path prefix — see that function's own doc comment.
  const gitWorktreeRemoveBodySchema = {
    body: {
      type: "object",
      required: ["worktreePath"],
      additionalProperties: false,
      properties: {
        // maxLength (Hermes review on PR #505) — 4096, not 255: unlike
        // git-branch-delete's `name`, this is a full absolute path, not a
        // single ref-like string, and Linux's own PATH_MAX is 4096.
        worktreePath: { type: "string", minLength: 1, maxLength: 4096 },
        force: { type: "boolean" },
        // Issue #2026 — the ended session that owns this worktree (Settings →
        // Storage's "Kept session worktrees"). It may live on a different host
        // than the project, and was cut from `worktreeRepoCwd`, so both come
        // from the session row instead of the project.
        sessionId: { type: "integer", minimum: 1 },
      },
    },
  };
  app.post<{
    Params: { id: string };
    Body: { worktreePath: string; force?: boolean; sessionId?: number };
  }>(
    "/api/projects/:id/git-worktree-remove",
    {
      schema: gitWorktreeRemoveBodySchema,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const { worktreePath, force, sessionId } = request.body;

      // Where the removal runs: the project's host and checkout, or — for a
      // session's own worktree — the session's host and the repository the
      // worktree was cut from.
      let target: { id: number; hostId: string; cwd: string } = project;
      let owner: typeof sessions.$inferSelect | undefined;
      if (sessionId !== undefined) {
        [owner] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
        if (!owner || owner.projectId !== project.id) {
          return reply.notFound("No such session in this project");
        }
        if (!owner.worktreeBranch || !owner.worktreeRepoCwd || !owner.cwd) {
          return reply.badRequest("This session does not own a worktree");
        }
        if (path.resolve(owner.cwd) !== path.resolve(worktreePath)) {
          return reply.badRequest("worktreePath is not this session's worktree");
        }
        if (owner.worktreeReclaimedAt) return { removed: false, reason: "not-listed" };
        // A live session's worktree is not a leftover — even under force.
        if (owner.status === "active") {
          return reply.badRequest("This session is still active");
        }
        target = {
          id: project.id,
          hostId: resolveSessionHostId(app, owner),
          cwd: owner.worktreeRepoCwd,
        };
      }

      // The main worktree IS project.cwd — skip the live-session guard for
      // it (almost every session in a non-isolated project has an
      // effective cwd under it, which would otherwise report a confusing
      // "sessions-active" for what removeListedWorktree itself already
      // refuses as "is-main" regardless of force).
      const isMainWorktreeTarget = path.resolve(worktreePath) === path.resolve(target.cwd);

      // Live-session guard — same force-overrides-as-UX-safety-net posture
      // as the task-branch guard above (Hermes review on PR #505): the
      // lookup always runs (skipped only for the main worktree, which
      // `removeListedWorktree` itself already refuses as "is-main"
      // regardless of force), and a force bypass is logged rather than
      // silently skipped.
      if (!isMainWorktreeTarget) {
        let sessionIds: number[];
        try {
          const usage = await sessionsUsingWorktree(app, worktreePath, target.hostId, owner?.id);
          sessionIds = [
            ...new Set([
              ...usage.active,
              ...usage.alive,
              ...usage.unknown,
              ...taskSessionsUnderWorktree(app, target, worktreePath),
            ]),
          ];
        } catch (err) {
          app.log.warn({ hostId: target.hostId, err }, "worktree usage check failed");
          if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
          if (isHostTransientError(err))
            return reply.serviceUnavailable(`Host ${target.hostId} is unavailable`);
          return reply.serviceUnavailable(
            "Could not check whether sessions are using this worktree",
          );
        }
        if (sessionIds.length > 0) {
          if (!force) {
            const result:
              | RemoveListedWorktreeResult
              | { removed: false; reason: "sessions-active"; detail: string } = {
              removed: false,
              reason: "sessions-active",
              detail: sessionIds.join(","),
            };
            return result;
          }
          app.log.warn(
            { projectId: project.id, worktreePath, sessionIds },
            "force-removing a worktree with active sessions under it",
          );
        }
      }

      // The reclaim sweep may be working on this same session right now;
      // share its in-flight slot rather than run git against it twice.
      if (owner && !claimReclaimSlot(owner.id)) {
        return reply.conflict("Mullion is reclaiming this worktree right now — try again shortly");
      }
      const backend = resolveBackend(app, target.hostId);
      try {
        // The owning session has ENDED, but its agent may still be exiting
        // inside the directory (a cascade kill, a kill whose terminate
        // failed) — the reclaim sweep's `still-running`. Same rule as the
        // sweep: only a confirmed-dead process proceeds; force overrides.
        if (owner) {
          const liveness = (await backend.liveness([String(owner.id)]))[String(owner.id)];
          if (liveness !== "dead") {
            if (!force) {
              return { removed: false, reason: "still-running", detail: liveness };
            }
            app.log.warn(
              { projectId: project.id, worktreePath, sessionId: owner.id, liveness },
              "force-removing a session worktree whose process is not confirmed gone",
            );
          }
        }
        const result = await removeListedCheckout(
          app,
          { projectId: project.id, hostId: target.hostId, cwd: target.cwd, worktreePath },
          { force },
        );
        // `not-listed` / `directory-gone`: git no longer has a worktree at
        // this path, or its directory is already gone — nothing of the
        // session's is left to remove, so the row must not linger. Not
        // `not-a-repo`: listWorktrees also reports that for a git failure,
        // and the sweep double-checks that case itself before stamping.
        if (
          owner &&
          (result.removed || result.reason === "not-listed" || result.reason === "directory-gone")
        ) {
          recordReclaimed(app, owner);
        }
        return result;
      } catch (err) {
        return reply.serviceUnavailable(hostFailMsg(app, target.hostId, err, "worktree remove"));
      } finally {
        if (owner) releaseReclaimSlot(owner.id);
      }
    },
  );

  // Issue #442 — Source Control "Prune stale" button: clears administrative
  // metadata for worktrees whose directory is already gone (`git worktree
  // prune`). Never removes a worktree that still exists on disk.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/git-worktree-prune",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      const backend = resolveBackend(app, project.hostId);
      try {
        return await backend.pruneWorktreeMetadata(project.cwd);
      } catch (err) {
        return reply.serviceUnavailable(
          hostFailMsg(app, project.hostId, err, "the worktree prune"),
        );
      }
    },
  );
}
