import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  taskReviewFindingsPath,
  taskCommitTitlePath,
  taskRereviewRequestPath,
} from "../services/task-prompt.js";
import {
  checkoutBranchWorktree,
  clearOrphanedTaskWorktree,
  commitWipChanges,
  createWorktree,
  listTaskWorktreeDirs,
  pruneWorktrees,
  pruneWorktreeMetadata,
  removeListedWorktree,
  removeWorktree,
  removeWorktreeIfClean,
  resumeTaskWorktree,
  syncWorktree,
} from "../services/git-worktree.js";
import { deleteBranch } from "../services/git-branch-delete.js";
import {
  runGenerationTurnInScratchWorktree,
  UnsupportedGenerationAgentError,
  GenerationWorktreeError,
  GenerationSpawnError,
  isSandboxCapable,
} from "../services/scaffold-generate.js";
import {
  readAgentBundleDisabled,
  writeAgentBundleDisabled,
} from "../services/agent-bundle-state.js";
import { uninstallBundleContent, runBundleSyncExclusive } from "../services/bundle-sync.js";
import { execSetupRecipe, readLocalSetupLog } from "../services/setup-recipe.js";
import { effectiveProjectsRoots } from "../services/agent-projects-roots.js";
import {
  gitWorktreeCreateSchema,
  gitWorktreeRemoveSchema,
  gitWorktreeCheckoutSchema,
  gitWorktreeForceRemoveSchema,
  gitWorktreeSyncSchema,
  gitWorktreeClearOrphanSchema,
  gitWorktreePruneSchema,
  gitBranchDeleteSchema,
  gitWorktreeRemoveListedSchema,
  gitWorktreePruneMetadataSchema,
  gitWorktreeResumeSchema,
  gitCommitWipSchema,
  runGenerationTurnSchema,
  runSetupSchema,
  setupLogQuerySchema,
  bundleSyncRemoveSchema,
} from "./internal-schemas.js";
import type {
  GitWorktreeCreateBody,
  GitWorktreeRemoveBody,
  GitWorktreeCheckoutBody,
  GitWorktreeForceRemoveBody,
  GitWorktreeSyncBody,
  GitWorktreeClearOrphanBody,
  GitWorktreePruneBody,
  GitBranchDeleteBody,
  GitWorktreeRemoveListedBody,
  GitWorktreePruneMetadataBody,
  GitWorktreeResumeBody,
  GitCommitWipBody,
  RunGenerationTurnBody,
  RunSetupBody,
  BundleSyncRemoveBody,
} from "./internal-schemas.js";
import { INTERNAL_RATE_LIMIT, GENERATION_TURN_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots, requireAllWithinRoots } from "./internal-roots.js";

/**
 * The agent's git-commit-wip, generation, setup, bundle-sync, git-worktree, task-* and git-branch-delete routes. Registered from `internalRoutes` so they sit
 * behind its auth hook and share its rate limits.
 */
export function registerWorktreeRoutes(app: FastifyInstance): void {
  // Issue #895 — salvages uncommitted work in `cwd` on this agent's own
  // filesystem into a single commit — the agent-side counterpart of
  // commitHostWipChanges (host-git.ts), for a remote-hosted project's
  // scaffold apply (routes/project-setup.ts). Wraps the SAME
  // commitWipChanges (git-worktree.ts) the LOCAL_HOST_ID caller uses
  // directly — see that function's own doc comment for its staging/no-op/
  // never-throws contract, preserved unchanged over the wire.
  app.post<{ Body: GitCommitWipBody }>(
    "/internal/git-commit-wip",
    { ...INTERNAL_RATE_LIMIT, schema: gitCommitWipSchema },
    async (request, reply) => {
      const { cwd, message, gitIdentity } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await commitWipChanges(resolvedCwd, message, gitIdentity);
    },
  );

  // Issue #1101 — the agent-side handler for a remote-hosted project's
  // scaffold-generation turn: runs the IDENTICAL worktree-create ->
  // sandboxed-spawn -> teardown logic scaffold-generate.ts's
  // generateScaffoldContent already runs for a LOCAL_HOST_ID project
  // (runGenerationTurnInScratchWorktree, reused unchanged — including its
  // own reuse of wrapWithSandbox/isSandboxCapable/agentSandboxWritablePaths/
  // ensureSandboxWritablePathsExist internally via defaultSpawnGenerationTurn),
  // just on THIS agent's own filesystem instead of the primary's.
  //
  // Always 200 with a discriminated `outcome` field for an
  // application-level failure (unsupported agent CLI, worktree-create
  // failure, spawn failure) — never a 4xx/5xx for those, since viaRemote's
  // HostRequestError mapping (host-git.ts) only distinguishes a 404 from
  // "everything else" and would otherwise collapse three distinguishable
  // error classes into one indistinguishable bucket on the primary side.
  // See scaffold-generate.ts's own GenerationTurnResult doc comment. A
  // genuine connectivity failure (host unreachable, or an old agent build
  // predating this route entirely) still surfaces the ordinary way — this
  // handler never gets a chance to run for either of those.
  app.post<{ Body: RunGenerationTurnBody }>(
    "/internal/run-generation-turn",
    { ...GENERATION_TURN_RATE_LIMIT, schema: runGenerationTurnSchema },
    async (request, reply) => {
      const { cwd, slug, baseRef, agentCommand, prompt, timeoutMs } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        const stdout = await runGenerationTurnInScratchWorktree({
          cwd: resolvedCwd,
          slug,
          baseRef,
          agentCommand,
          prompt,
          timeoutMs,
          // Issue #1133 — THIS agent's own opt-out, never the primary's:
          // deliberately not part of RunGenerationTurnBody/the wire schema
          // (see runGenerationTurnSchema's own additionalProperties: false
          // posture) — a caller choosing what executes here would defeat
          // the sandboxing this handler's own spawn step applies.
          sandbox: app.config.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED,
        });
        // Issue #1144, #1159 — surface whether the turn actually ran inside
        // a bwrap sandbox. Same logic as generateScaffoldContent's own
        // LOCAL_HOST_ID path: config opt-out short-circuits before
        // isSandboxCapable() in defaultSpawnGenerationTurn.
        const sandboxRequested = app.config.MULLION_SCAFFOLD_GENERATE_SANDBOX_ENABLED !== false;
        const sandboxed = sandboxRequested && (await isSandboxCapable());
        // Issue #2554 — runGenerationTurnInScratchWorktree wraps every turn in
        // the read canary (a failed canary throws), so reaching here means it ran.
        return { outcome: "ok", stdout, sandboxed, canary: true };
      } catch (err) {
        if (err instanceof UnsupportedGenerationAgentError) {
          return { outcome: "unsupported-agent", detail: err.message };
        }
        if (err instanceof GenerationWorktreeError) {
          return { outcome: "worktree-error", detail: err.message };
        }
        if (err instanceof GenerationSpawnError) {
          return { outcome: "spawn-error", detail: err.message };
        }
        throw err;
      }
    },
  );

  // Issue #2245 — runs a project's setup recipe (`sh -c`) in a freshly cut
  // worktree or cloned checkout on THIS agent, output to
  // `<sessionsDir>/<logKey>.setup.log`. Always 200 with a typed `outcome`
  // (ok | failed | timeout | busy) — like run-generation-turn, so the primary's
  // viaRemote can tell "the recipe failed" from "the host is unreachable". The
  // request stays open for the run (bounded by timeoutMs); the PRIMARY is what
  // never waits on it.
  app.post<{ Body: RunSetupBody }>(
    "/internal/run-setup",
    { ...INTERNAL_RATE_LIMIT, schema: runSetupSchema },
    async (request, reply) => {
      const { cwd, recipe, logKey } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await execSetupRecipe({
        cwd: resolvedCwd,
        recipe,
        logKey,
        sessionsDir: app.config.SESSIONS_DIR,
        withinRoots: effectiveProjectsRoots(app),
      });
    },
  );

  // Issue #2245 — the tail of a setup log on this agent, for the primary's
  // `GET /api/sessions/:id/setup-log`. Reads only `<sessionsDir>/<logKey>.setup.log`
  // (the key is a filename stem by schema), so no PROJECTS_ROOTS check applies.
  app.get<{ Querystring: { logKey: string } }>(
    "/internal/setup-log",
    { ...INTERNAL_RATE_LIMIT, schema: setupLogQuerySchema },
    async (request, reply) => {
      const log = readLocalSetupLog(app.config.SESSIONS_DIR, request.query.logKey);
      if (!log) return reply.notFound("no setup log");
      return log;
    },
  );

  // Issue #1089 — reads this agent's own persisted "bundle disabled" flag
  // (agent-bundle-state.ts), for routes/bundle-sync.ts's primary-side
  // per-host query (via agent-bundle-state.ts's getHostBundleDisabled /
  // RemoteHostClient.getAgentBundleState). No `cwd`/PROJECTS_ROOTS
  // containment to apply here — unlike /internal/read-files and friends,
  // this reads a single fixed, host-local state file, not caller-supplied
  // paths under a project checkout.
  app.get("/internal/bundle-sync/status", INTERNAL_RATE_LIMIT, async () => {
    return { disabled: readAgentBundleDisabled() };
  });

  // Issue #1089 — the agent-side counterpart of routes/bundle-sync.ts's
  // own POST /api/bundle-sync/remove: disables (or re-enables) bundle sync
  // on THIS agent's own filesystem and, when disabling, removes previously
  // installed bundle content. Writes the local flag FIRST (same ordering
  // as the primary's own /remove route, which flips its settings-DB value
  // before running the removal) so a killed process mid-removal still
  // leaves the flag set — this host's next boot-time sync
  // (plugins/bundle-sync.ts) will simply retry the removal branch rather
  // than silently reinstalling.
  //
  // Issue #1128 — `disabled: false` used to only clear the flag and stop
  // there, leaving this host's own bundle uninstalled until its NEXT
  // restart (or a hand-edit of agent-bundle-state.ts's own state file) —
  // the primary's own re-enable fan-out
  // (plugins/bundle-sync.ts's reenableAgentBundles) had nothing to call
  // that would actually reconcile a currently-running agent process. Now
  // also kicks this host's own runBundleSyncExclusive(true) — the SAME
  // function this plugin's own boot-time onReady hook calls — so the flag
  // clearing and the actual reinstall happen together, symmetric with the
  // `disabled: true` branch below (which clears/sets the flag AND removes
  // content in the same request, not just one or the other).
  app.post<{ Body: BundleSyncRemoveBody }>(
    "/internal/bundle-sync/remove",
    { ...INTERNAL_RATE_LIMIT, schema: bundleSyncRemoveSchema },
    async (request) => {
      const { disabled } = request.body;
      writeAgentBundleDisabled(disabled);
      if (!disabled) {
        await runBundleSyncExclusive(true);
        return { removed: 0, legacySwept: 0, disabled: false };
      }
      const result = await uninstallBundleContent();
      return { removed: result.removed, legacySwept: result.legacySwept, disabled: true };
    },
  );

  // #484 — lists this agent's own on-disk task-worktree directories, for
  // the primary's boot-time orphan sweep (plugins/task-watcher.ts). Mirrors
  // listTaskWorktreeDirs's own pure-filesystem-read contract exactly — see
  // that function's own doc comment for why it returns `[]` rather than
  // throwing for a missing/unreadable `.mullion-worktrees` directory.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/git-worktree/task-dirs",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return { dirs: listTaskWorktreeDirs(resolvedCwd) };
    },
  );

  // #484 — the agent-side counterpart of resumeTaskWorktree: checks out an
  // EXISTING `mullion/task-<id>-<slug>` branch into a fresh worktree at its
  // deterministic path, on THIS agent's own filesystem, for Retry (#483) on
  // a remote-hosted task. Returns `null` (200, not an error status) when
  // the resume fails for a git-level reason (branch missing, or checked out
  // elsewhere) — same "not applicable, not unreachable" shape as
  // /internal/git-worktree above.
  app.post<{ Body: GitWorktreeResumeBody }>(
    "/internal/git-worktree/resume",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeResumeSchema },
    async (request, reply) => {
      const { cwd, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await resumeTaskWorktree(resolvedCwd, branchName);
    },
  );

  // #760 — the agent-side counterpart of SessionBackend's
  // readTaskReviewFindings/deleteTaskReviewFindings (session-backend.ts),
  // for a remote-hosted task's review-findings ingestion
  // (task-reconciler.ts's processReviewingTasks). Unlike every other
  // filesystem route in this file, this pair takes NO cwd/path at all —
  // there's nothing here for a traversal attempt to reach: the path is
  // derived entirely on this side from THIS agent's own
  // `app.pty.hookSocketPath` plus the two numeric identifiers, the same
  // "target never a caller-supplied path" safety /internal/agent-rules'
  // own comment above describes for its global-scope targets.
  //
  // GET returns `{ content: null }` (200) for a genuinely absent/empty
  // file — never a 404. A 404 here can only mean this route itself
  // doesn't exist (an old peer build, i.e. version skew), which
  // RemoteHostClient's request() already turns into a thrown
  // HostRequestError for every 4xx — the caller-visible signal that must
  // stay distinguishable from "the file is absent" (see
  // SessionBackend.readTaskReviewFindings's own doc comment).
  app.get<{ Querystring: { taskId?: string; round?: string } }>(
    "/internal/task-review-findings",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const taskId = Number(request.query.taskId);
      const round = Number(request.query.round);
      if (!Number.isInteger(taskId) || !Number.isInteger(round)) {
        return reply.badRequest("taskId and round query params must be integers");
      }
      const findingsPath = taskReviewFindingsPath(app.pty.sessionsDir, taskId, round);
      if (!existsSync(findingsPath)) return { content: null };
      const content = readFileSync(findingsPath, "utf8").trim();
      return { content: content.length > 0 ? content : null };
    },
  );

  app.delete<{ Querystring: { taskId?: string; round?: string } }>(
    "/internal/task-review-findings",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const taskId = Number(request.query.taskId);
      const round = Number(request.query.round);
      if (!Number.isInteger(taskId) || !Number.isInteger(round)) {
        return reply.badRequest("taskId and round query params must be integers");
      }
      const findingsPath = taskReviewFindingsPath(app.pty.sessionsDir, taskId, round);
      if (existsSync(findingsPath)) unlinkSync(findingsPath);
      reply.code(204);
    },
  );

  // #778 — the agent-side counterpart of SessionBackend's
  // readTaskCommitTitle, for a remote-hosted task's Conventional Commits
  // title ingestion (task-reconciler.ts's `-> reviewing` transition). Same
  // no-cwd/path, identifier-only shape as `/internal/task-review-findings`
  // above, for the same reason: nothing here for a traversal attempt to
  // reach. No DELETE counterpart — unlike review findings (round-suffixed,
  // unlinked once ingested so a same-round re-review can't re-ingest stale
  // content), the commit-title file is deliberately NOT round-suffixed and
  // is meant to persist across rounds (see `taskCommitTitlePath`'s own doc
  // comment) — there is nothing to clean up here.
  app.get<{ Querystring: { taskId?: string } }>(
    "/internal/task-commit-title",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const taskId = Number(request.query.taskId);
      if (!Number.isInteger(taskId)) {
        return reply.badRequest("taskId query param must be an integer");
      }
      const titlePath = taskCommitTitlePath(app.pty.sessionsDir, taskId);
      if (!existsSync(titlePath)) return { content: null };
      const content = readFileSync(titlePath, "utf8").trim();
      return { content: content.length > 0 ? content : null };
    },
  );

  // The agent-side counterpart of SessionBackend's readTaskRereviewRequest —
  // a remote-hosted suggestions-round worker's "review this" request. Same
  // identifier-only shape as `/internal/task-commit-title` above; `key` is
  // the integer the path helper keys on, so there is nothing path-like for a
  // traversal attempt to reach.
  app.get<{ Querystring: { taskId?: string; key?: string } }>(
    "/internal/task-rereview-request",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const taskId = Number(request.query.taskId);
      const key = Number(request.query.key);
      if (!Number.isInteger(taskId) || !Number.isInteger(key)) {
        return reply.badRequest("taskId and key query params must be integers");
      }
      const requestPath = taskRereviewRequestPath(app.pty.sessionsDir, taskId, key);
      if (!existsSync(requestPath)) return { content: null };
      return { content: readFileSync(requestPath, "utf8").trim() || "(no reason given)" };
    },
  );

  // Issue #271 — creates a worktree on THIS agent's own filesystem, for a
  // remote-hosted project's launcher-toggle/promote flows. Same
  // resolveWithinRoots gate as every other filesystem-touching route in
  // this file; unlike those read-only routes, this one mutates (creates a
  // directory + a branch), so the gate matters even more here. Returns
  // `{ created: false, reason, detail? }` (200, not an error status — issue
  // #677) when creation fails for a git-level reason (bad baseRef, not a
  // repo, a branch/path collision) — same "not applicable, not unreachable"
  // shape as /internal/git-branches above, which RemoteHostClient.request()'s
  // HostUnreachableError/HostRequestError handling would otherwise conflate
  // with a genuine connectivity failure.
  app.post<{ Body: GitWorktreeCreateBody }>(
    "/internal/git-worktree",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeCreateSchema },
    async (request, reply) => {
      const { cwd, baseRef, seed, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await createWorktree({ cwd: resolvedCwd, baseRef, seed, branchName });
    },
  );

  // Issue #283 — removes a task worktree on THIS agent's own filesystem,
  // only when clean (never `--force`; see removeWorktreeIfClean's own doc
  // comment). Both path fields go through resolveWithinRoots — parentCwd
  // is where `git worktree remove` actually runs, so it needs the same
  // containment as worktreePath itself.
  app.post<{ Body: GitWorktreeRemoveBody }>(
    "/internal/git-worktree/remove",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeRemoveSchema },
    async (request, reply) => {
      const { worktreePath, parentCwd } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      let resolvedParentCwd: string | undefined;
      if (parentCwd) {
        const resolved = requireWithinRoots(app, reply, parentCwd, "parentCwd");
        if (resolved === null) return;
        resolvedParentCwd = resolved;
      }
      return await removeWorktreeIfClean(resolvedWorktreePath, resolvedParentCwd);
    },
  );

  // Issue #345 — checks out an EXISTING branch into a fresh detached-HEAD
  // worktree on THIS agent's own filesystem, for a remote-hosted project's
  // dock-preview flow. Distinct from /internal/git-worktree above (which
  // creates a NEW branch from a baseRef). Returns `null` (200) on a
  // git-level failure, same "not applicable, not unreachable" posture as
  // every other route in this file — see /internal/git-worktree's own
  // comment.
  app.post<{ Body: GitWorktreeCheckoutBody }>(
    "/internal/git-worktree/checkout",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeCheckoutSchema },
    async (request, reply) => {
      const { cwd, branch } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await checkoutBranchWorktree(resolvedCwd, branch);
    },
  );

  // Issue #345 — force-removes a dock-preview worktree on THIS agent's own
  // filesystem (`git worktree remove --force`), for the primary's
  // killSession/reconciler/spawn-rollback cleanup paths. Unlike
  // /internal/git-worktree/remove above (removeWorktreeIfClean, never
  // force), a preview worktree running an HMR dev server is almost always
  // dirty, so the safe path can't be reused here — see removeWorktree's own
  // doc comment. Both path fields go through resolveWithinRoots
  // independently, same as /internal/git-worktree/remove.
  app.post<{ Body: GitWorktreeForceRemoveBody }>(
    "/internal/git-worktree/force-remove",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeForceRemoveSchema },
    async (request, reply) => {
      const { worktreePath, parentCwd } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      let resolvedParentCwd: string | undefined;
      if (parentCwd) {
        const resolved = requireWithinRoots(app, reply, parentCwd, "parentCwd");
        if (resolved === null) return;
        resolvedParentCwd = resolved;
      }
      const removed = await removeWorktree(resolvedWorktreePath, resolvedParentCwd);
      return { removed };
    },
  );

  // Issue #345 — resets a dock-preview worktree on THIS agent's own
  // filesystem to the current tip of a LOCAL branch ref
  // (`git reset --hard`), for the primary's worktreeRefresh live-sync tick.
  // See syncWorktree's own doc comment for why this is safe only because
  // the worktree's HEAD is detached (checkoutBranchWorktree above).
  app.post<{ Body: GitWorktreeSyncBody }>(
    "/internal/git-worktree/sync",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeSyncSchema },
    async (request, reply) => {
      const { worktreePath, branch } = request.body;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      const synced = await syncWorktree(resolvedWorktreePath, branch);
      return { synced };
    },
  );

  // Issue #283 — task-claim.ts's pre-claim orphan clearing on THIS agent's
  // own filesystem: clears both the worktree directory and the branch ref
  // at task-claim.ts's deterministic mullion/task-<id>-<slug> path/name. See
  // clearOrphanedTaskWorktree's own doc comment for why deleting the
  // branch here is safe, unlike /internal/git-worktree/remove above.
  app.post<{ Body: GitWorktreeClearOrphanBody }>(
    "/internal/git-worktree/clear-orphan",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeClearOrphanSchema },
    async (request, reply) => {
      const { cwd, worktreePath, branchName } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      return await clearOrphanedTaskWorktree(resolvedCwd, resolvedWorktreePath, branchName);
    },
  );

  // Issue #283 — removes the explicitly-named orphan task worktrees under
  // `cwd` on THIS agent's own filesystem. Every entry in `orphanPaths` goes
  // through resolveWithinRoots individually, same containment as `cwd`
  // itself — pruneWorktrees itself re-validates containment/naming again on
  // top of this (defense in depth), but a path that fails resolveWithinRoots
  // shouldn't even reach that function.
  app.post<{ Body: GitWorktreePruneBody }>(
    "/internal/git-worktree/prune",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreePruneSchema },
    async (request, reply) => {
      const { cwd, orphanPaths } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedOrphanPaths = requireAllWithinRoots(app, reply, orphanPaths, "orphanPaths");
      if (resolvedOrphanPaths === null) return;
      return await pruneWorktrees(resolvedCwd, resolvedOrphanPaths);
    },
  );

  // Issue #442 — deletes a local branch on THIS agent's own filesystem, for
  // a remote-hosted project's Source Control manual branch-management UI. Always
  // 200 with a reason envelope, never a 5xx for a git-level refusal — see
  // deleteBranch's own DeleteBranchResult shape and the module-level
  // reasoning on every other route in this file that returns one.
  app.post<{ Body: GitBranchDeleteBody }>(
    "/internal/git-branch-delete",
    { ...INTERNAL_RATE_LIMIT, schema: gitBranchDeleteSchema },
    async (request, reply) => {
      const { cwd, name, force } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await deleteBranch(resolvedCwd, name, { force });
    },
  );

  // Issue #442 — removes any worktree `git worktree list` itself reports on
  // THIS agent's own filesystem (not scoped to task worktrees, unlike
  // /internal/git-worktree/remove above) — see removeListedWorktree's own
  // doc comment for the force-path preview-registry fix it performs.
  app.post<{ Body: GitWorktreeRemoveListedBody }>(
    "/internal/git-worktree/remove-listed",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreeRemoveListedSchema },
    async (request, reply) => {
      const { cwd, worktreePath, force } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const resolvedWorktreePath = requireWithinRoots(app, reply, worktreePath, "worktreePath");
      if (resolvedWorktreePath === null) return;
      return await removeListedWorktree(resolvedCwd, resolvedWorktreePath, { force });
    },
  );

  // Issue #442 — clears stale worktree administrative metadata on THIS
  // agent's own filesystem (`git worktree prune`, not pruneWorktrees'
  // task-worktree sweeper above). Never removes a worktree still on disk.
  app.post<{ Body: GitWorktreePruneMetadataBody }>(
    "/internal/git-worktree/prune-metadata",
    { ...INTERNAL_RATE_LIMIT, schema: gitWorktreePruneMetadataSchema },
    async (request, reply) => {
      const { cwd } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return await pruneWorktreeMetadata(resolvedCwd);
    },
  );
}
