// The project Git READ routes, moved out of src/routes/projects.ts
// (issue #2475).
//
// This file is a MOVE, not a rewrite: the routes, their schemas, their status
// codes and their error mapping are exactly what they were. It exists because
// src/routes/projects.ts was one 3,987-code-line function holding four
// unrelated surfaces, and the file-size guardrail turns over one ceiling at a
// time.
//
// projectsRoute() calls projectGitRoute() at the position this block used to
// occupy, so Fastify registration ORDER — and the plugin encapsulation context
// the routes are registered in — are unchanged. It is a plain call, not an
// app.register(): a registered plugin is deferred to the end of the enclosing
// plugin, which would reorder the routes.
//
// The WRITE side of the same surface (fetch, pull, repair, branch and worktree
// operations) lives in project-git-writes.ts, which projectsRoute() calls
// immediately after this one.
//
// resolveProjectGitBranches() is shared with that write module (the branch
// prune and worktree-remove routes read the same branch/worktree shape), so
// it lives here and project-git-writes.ts imports it — the same one-way
// arrangement project-github-writes.ts uses for loadProjectRepoContext.

import type { FastifyInstance, FastifyReply } from "fastify";
import { getProjectById, getProjectsByIds, type ProjectRow } from "../services/project-records.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { resolveSessionCwdTargets } from "../services/session-cwd-targets.js";
import { loadScopedProject } from "../services/session-git-scope.js";
import type { HostGitResult, HostHistoryValue } from "../services/host-git.js";
import {
  resolveHostGitCommit,
  resolveHostGitCommitFile,
  resolveHostGitLog,
  resolveRepoRefResult,
} from "../services/host-git.js";
import type { GitStatusResult, GitStatus, GitStatusFailure } from "../services/git-status.js";
import { getGitStatus, getGitStatusFailure, isGitRepo } from "../services/git-status.js";
import type { GitDiffStats } from "../services/git-diff.js";
import { getDiffStats, getDefaultBaseRef, getFileDiff } from "../services/git-diff.js";
import type { GitBranchInfo, GitWorktreeInfo } from "../services/git-refs.js";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  resolveDefaultBaseRefForPicker,
  isPlainBranchName,
} from "../services/git-refs.js";
import {
  MAX_LOG_PAGE,
  getCommitDetail,
  getCommitFileDiff,
  getCommitLog,
  isSafeRepoPath,
  isValidSha,
} from "../services/git-log.js";
import { applyPrState } from "../services/branch-merge-state.js";
import { getClosedPrsByBranch } from "../services/github-merged-prs.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import type { GitHubCiStatus, GitHubPRsStatus } from "../services/github.js";
import { getPRsStatus, getCachedDefaultBranchCi } from "../services/github.js";
import { overlayRelayRuns } from "../services/relay-review-state.js";
import { annotatePrTasks } from "../services/mullion-links.js";
import path from "node:path";
import { HostOutcomes, warnHostThrottled } from "../services/host-warn-throttle.js";

// Throttled per (host, message) — see services/host-warn-throttle.ts.
const MSG_STATUS_PROJECT = "batch git-status: remote host unreachable, omitting project";
const MSG_STATUS_SESSION = "batch git-status: remote host unavailable for session cwd, omitting";
const MSG_DIFF_STATS = "batch git-diff-stats: remote host unavailable, omitting";
const MSG_REFS = "batch git-refs: remote host unavailable for branches, omitting";

/** Shared by every `?ids=`/`?sessionIds=` batch query param below (git-
 * statuses, git-diff-stats) — a comma-separated list of positive integers,
 * silently dropping anything malformed rather than 400ing (a stray
 * non-numeric id from a stale/racing client is just "nothing to report for
 * that one," not a client error worth failing the whole batch over). */
function parseIdListParam(param: string | undefined): number[] {
  if (!param) return [];
  return param
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Shared by /api/projects/:id/git-branches and the batch
// /api/projects/git-refs route below (issue #1007) — the latter needs the
// exact same shape per project id, so this is factored out rather than
// duplicated.
//
// `defaultBranch` (issue #271 follow-up) — the promote/launcher base-ref
// pickers' default. `undefined` on an old remote host that hasn't been
// upgraded yet (see the degradation convention at shared/types.ts's own
// doc comment); `null` when this host resolved it and found no usable
// default (no remote, or the fallback chain bottomed out at "HEAD" — see
// resolveDefaultBaseRefForPicker). Either way callers fall back to the
// current branch.
export interface ProjectGitBranchesResult {
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  remoteBranches: string[];
  defaultBranch?: string | null;
}

/**
 * Local branches/worktrees/remote-branches/defaultBranch for one project,
 * host-aware (local git spawns vs. a remote agent RPC) — the body shared
 * by the per-project `/git-branches` route and the batch `/git-refs`
 * route (issue #1007). Returns `null` for the same "durably nothing to
 * show" cases the per-project route turns into a 204 (not a git repo, or
 * an old remote agent that returned nothing). A remote host being
 * unreachable is the ONE case this throws instead of returning null —
 * callers that want to omit-and-continue (the batch route) must catch it
 * themselves; the single-project route re-throws it as a 503 by design.
 */
export async function resolveProjectGitBranches(
  app: FastifyInstance,
  project: ProjectRow,
  detail: boolean,
  opts?: { freshPrs?: boolean },
): Promise<ProjectGitBranchesResult | null> {
  let result: ProjectGitBranchesResult | null;
  if (project.hostId === LOCAL_HOST_ID) {
    const [branches, worktrees, remoteBranches, defaultBranch] = await Promise.all([
      listBranches(project.cwd, { detail }),
      listWorktrees(project.cwd),
      listRemoteBranches(project.cwd),
      resolveDefaultBaseRefForPicker(project.cwd),
    ]);
    result =
      branches && worktrees && remoteBranches
        ? { branches, worktrees, remoteBranches, defaultBranch }
        : null;
  } else {
    result = await getRemoteHostClient(app, project.hostId).resolveGitBranches(project.cwd, detail);
  }
  if (result && detail) await attachBranchPrState(app, project, result.branches, opts?.freshPrs);
  return result;
}

/**
 * Layers PR-derived merge state (squash merges) onto a detail branch list:
 * one cached closed-PR listing per repo plus the already-cached open PRs, no
 * per-branch GitHub call. Best-effort — no repo, no token or a GitHub error
 * just leaves the git-derived states, which is also why a prune never trusts
 * a `pr-merged` it could not just re-fetch (`fresh`).
 */
async function attachBranchPrState(
  app: FastifyInstance,
  project: ProjectRow,
  branches: GitBranchInfo[],
  fresh = false,
): Promise<void> {
  try {
    const ref = await resolveRepoRefResult(app, project);
    if (!ref.ok || !ref.value) return;
    const token = await resolveGitHubToken(app, ref.value, "read");
    if (!token) return;
    const { owner, repo } = ref.value;
    const closed = await getClosedPrsByBranch(token, owner, repo, { fresh });
    applyPrState(branches, closed, getPRsStatus(owner, repo)?.prs ?? null);
  } catch (err) {
    app.log.warn({ err, projectId: project.id }, "branch PR state unavailable");
  }
}

export async function projectGitRoute(app: FastifyInstance): Promise<void> {
  // Batch git-status for the sidebar's live-refresh loop: replaces N
  // parallel per-project requests with a single request (issue #76).
  // Accepts ?ids=1,2,3 (project ids) and returns `{ projects, sessions }`
  // where each is a `Record<id, GitStatus | null>` — `null` means "durably
  // not a git repo" (the per-project endpoint's 204 case). An id whose
  // status failed transiently (503-equivalent) is simply omitted from its
  // map, so the frontend preserves its last-known-good for that one.
  // Higher rate limit than the per-project endpoint since this replaces N
  // requests with 1.
  //
  // Optional `?sessionIds=10,11` (issue #202): per-session git status for
  // each session's *effective* cwd (`resolveSessionCwdTargets` above) —
  // most sessions share their project's own cwd (and therefore its status,
  // already computed above and served from the same git-status.ts cache),
  // but a session running in a worktree gets its own distinct status here.
  // Kept in a separate `sessions` map rather than merged into `projects`:
  // project ids and session ids are both plain positive integers from
  // different id spaces, so a merged flat map would be ambiguous about
  // which space a given key belonged to.
  app.get<{ Querystring: { ids?: string; sessionIds?: string } }>(
    "/api/projects/git-statuses",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            ids: { type: "string" },
            sessionIds: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const ids = parseIdListParam(request.query.ids);
      const sessionIds = parseIdListParam(request.query.sessionIds);

      const projectsResult: Record<string, GitStatus | null> = {};
      const projectOutcome = new HostOutcomes();
      const problemsResult: Record<string, GitStatusFailure> = {};
      if (ids.length > 0) {
        const rows = getProjectsByIds(app.db, ids);

        for (const project of rows) {
          if (project.hostId === LOCAL_HOST_ID) {
            if (!isGitRepo(project.cwd)) {
              projectsResult[project.id] = null;
              continue;
            }
            const status = await getGitStatus(project.cwd);
            if (status) {
              projectsResult[project.id] = status;
            } else {
              // A repo whose `git status` fails (issue #1602): left out of
              // `projects` so the client keeps last-known-good, but the reason
              // is reported so it can say more than "not a git repository".
              const failure = getGitStatusFailure(project.cwd);
              if (failure) problemsResult[project.id] = failure;
            }
          } else {
            try {
              const remoteResult = await getRemoteHostClient(app, project.hostId).resolveGitStatus(
                project.cwd,
              );
              projectOutcome.ok(project.hostId);
              if (!remoteResult.isRepo) {
                projectsResult[project.id] = null;
              } else if (remoteResult.status) {
                projectsResult[project.id] = remoteResult.status;
              } else if (remoteResult.problem) {
                // Issue #1612: the agent reported why `git status` failed.
                problemsResult[project.id] = remoteResult.problem;
              }
            } catch (err) {
              projectOutcome.failed(project.hostId);
              warnHostThrottled(
                app.log,
                project.hostId,
                { projectId: project.id, err },
                MSG_STATUS_PROJECT,
              );
            }
          }
        }
      }

      projectOutcome.settle(app.log, MSG_STATUS_PROJECT);

      const sessionsResult: Record<string, GitStatus | null> = {};
      const sessionOutcome = new HostOutcomes();
      if (sessionIds.length > 0) {
        const targets = await resolveSessionCwdTargets(app, sessionIds);
        for (const target of targets) {
          if (target.invalid) {
            sessionsResult[target.sessionId] = null;
            continue;
          }
          if (target.hostId === LOCAL_HOST_ID) {
            if (!isGitRepo(target.cwd)) {
              sessionsResult[target.sessionId] = null;
              continue;
            }
            const status = await getGitStatus(target.cwd);
            if (status) {
              sessionsResult[target.sessionId] = status;
            }
          } else {
            try {
              const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitStatus(
                target.cwd,
              );
              sessionOutcome.ok(target.hostId);
              if (!remoteResult.isRepo) {
                sessionsResult[target.sessionId] = null;
              } else if (remoteResult.status) {
                sessionsResult[target.sessionId] = remoteResult.status;
              }
            } catch (err) {
              // A remote worktree cwd outside that agent's own
              // PROJECTS_ROOTS (resolveWithinRoots, routes/internal.ts)
              // surfaces here as a 4xx HostRequestError, not just the usual
              // HostUnreachableError — both just mean "omit this session,"
              // same as the project loop above.
              sessionOutcome.failed(target.hostId);
              warnHostThrottled(
                app.log,
                target.hostId,
                { sessionId: target.sessionId, err },
                MSG_STATUS_SESSION,
              );
            }
          }
        }
      }

      sessionOutcome.settle(app.log, MSG_STATUS_SESSION);

      return { projects: projectsResult, sessions: sessionsResult, problems: problemsResult };
    },
  );

  // Diff stats (issue #202, greenfield) — files-changed + insertions/
  // deletions per session's effective cwd (git-diff.ts's `git diff [base]...HEAD
  // --numstat`). When `base` is set (e.g. `origin/main`), the diff is
  // computed against the merge-base of that ref instead of just HEAD,
  // surfacing the full branch delta even after commits. Batched the same
  // way as the git-statuses endpoint above and for the same reason (one
  // request per live-refresh tick, not one per session). `null` means "not
  // a repo, or nothing to diff yet"; an id whose stats failed transiently
  // is simply omitted.
  app.get<{ Querystring: { sessionIds?: string; base?: string } }>(
    "/api/projects/git-diff-stats",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionIds: { type: "string" },
            base: { type: "string", pattern: "^(?!.*\\.\\.)[a-zA-Z0-9_./-]+$" },
          },
        },
      },
    },
    async (request) => {
      const { base } = request.query;
      const sessionIds = parseIdListParam(request.query.sessionIds);
      const result: Record<string, GitDiffStats | null> = {};
      if (sessionIds.length === 0) return result;

      const outcome = new HostOutcomes();
      const targets = await resolveSessionCwdTargets(app, sessionIds);
      for (const target of targets) {
        if (target.invalid) {
          result[target.sessionId] = null;
          continue;
        }
        if (target.hostId === LOCAL_HOST_ID) {
          if (!isGitRepo(target.cwd)) {
            result[target.sessionId] = null;
            continue;
          }
          const effectiveBase =
            base === "AUTO" ? (getDefaultBaseRef(target.cwd) ?? undefined) : base;
          const stats = await getDiffStats(target.cwd, effectiveBase);
          if (stats) {
            result[target.sessionId] = stats;
          }
        } else {
          try {
            const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitDiffStats(
              target.cwd,
              base,
            );
            outcome.ok(target.hostId);
            if (!remoteResult.isRepo) {
              result[target.sessionId] = null;
            } else if (remoteResult.stats) {
              result[target.sessionId] = remoteResult.stats;
            }
          } catch (err) {
            outcome.failed(target.hostId);
            warnHostThrottled(
              app.log,
              target.hostId,
              { sessionId: target.sessionId, err },
              MSG_DIFF_STATS,
            );
          }
        }
      }
      outcome.settle(app.log, MSG_DIFF_STATS);

      return result;
    },
  );

  // Batch branches + open-PR list per project (issue #1007). Replaces the
  // frontend's former one-request-pair-per-project fan-out
  // (git-branches.ts's `refreshGitRefs`, formerly `Promise.all`ing 22
  // requests for 11 projects) with a single request, same batching shape as
  // git-statuses/git-diff-stats above. That fan-out is what blew through
  // git-branches'/github/prs's own 30/min per-route limiters during the
  // 0.3.8 update incident (three page loads × 11 projects = 33 > 30, 0.4s
  // before the first 429 — see issue #1005's timeline).
  //
  // `null` per id means the same "durably nothing to show" case the
  // per-project routes turn into a 204 (not a git repo / an old remote
  // agent / no open PRs). A transiently-unavailable id (remote host
  // unreachable) is simply omitted, same last-known-good posture as
  // git-statuses/git-diff-stats — the frontend preserves its previous
  // value for that id rather than clearing it.
  //
  // Deliberately reuses `resolveProjectGitBranches` (declared below, but
  // hoisted within this function body like every other route handler
  // here) rather than calling the per-project `/git-branches` route
  // in-process — this needs a catchable rejection to omit-and-continue,
  // while the single-project route's contract is to 503 instead.
  app.get<{ Querystring: { ids?: string } }>(
    "/api/projects/git-refs",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { ids: { type: "string" } },
        },
      },
    },
    async (request) => {
      const ids = parseIdListParam(request.query.ids);
      const branchesResult: Record<string, ProjectGitBranchesResult | null> = {};
      const prsResult: Record<string, GitHubPRsStatus | null> = {};
      // Default-branch CI per project (right-sidebar rail badge). Kept apart
      // from `prs`, which collapses to null when a repo has no open PRs —
      // that is exactly when a red default branch matters most.
      const defaultBranchCiResult: Record<string, GitHubCiStatus> = {};
      if (ids.length === 0) {
        return { branches: branchesResult, prs: prsResult, defaultBranchCi: defaultBranchCiResult };
      }

      const rows = getProjectsByIds(app.db, ids);

      const refsOutcome = new HostOutcomes();
      await Promise.all(
        rows.map(async (project) => {
          // Branches half and PR half run concurrently, not sequentially —
          // for a remote-hosted project each is its own RPC round trip to
          // the same agent, and awaiting them one after the other would
          // roughly double this project's contribution to the batch's
          // total latency for no reason (nothing here depends on the
          // other's result).
          const branchesPromise = (async () => {
            // No `detail` param, same as the background poll path already
            // documented on the per-project route's own comment (the
            // Source Control's own on-demand fetch is what opts into the
            // isMerged enrichment).
            try {
              branchesResult[project.id] = await resolveProjectGitBranches(app, project, false);
              if (project.hostId !== LOCAL_HOST_ID) refsOutcome.ok(project.hostId);
            } catch (err) {
              refsOutcome.failed(project.hostId);
              warnHostThrottled(app.log, project.hostId, { projectId: project.id, err }, MSG_REFS);
            }
          })();

          // PR half — a warm-cache read (github-pr-poller.ts's background
          // poller), same as the per-project /github/prs route. Uses
          // `resolveRepoRefResult` directly (Hermes review), NOT the
          // null-collapsing `resolveRepoRef` — that collapse conflates
          // "durably no GitHub remote" with "host momentarily unreachable"
          // into the same `null`, which this route can't afford: setting
          // `prsResult[project.id] = null` for a transient outage clears
          // the frontend's last-known-good PR list for that project
          // (store/slices/git.ts maps a present `null` to `undefined`,
          // same as every other "nothing here" case), contradicting the
          // omit-on-transient-failure contract the branches half above
          // already follows. `resolveRepoRefResult` never throws either
          // (viaRemote's own doc comment), so this still needs no
          // try/catch — just a three-way branch instead of a collapsed one.
          const prsPromise = (async () => {
            const result = await resolveRepoRefResult(app, project);
            if (!result.ok) {
              // Transient (remote host unreachable) — omit, preserving
              // last-known-good, exactly like the branches half's catch.
              return;
            }
            if (!result.value) {
              // Durable — no GitHub remote configured for this project.
              prsResult[project.id] = null;
              defaultBranchCiResult[project.id] = null;
              return;
            }
            // Present only once the poller has computed it, so a cold cache
            // leaves the client's last-known-good alone.
            const ci = getCachedDefaultBranchCi(result.value.owner, result.value.repo);
            if (ci !== undefined) defaultBranchCiResult[project.id] = ci;
            const status = getPRsStatus(result.value.owner, result.value.repo);
            if (!status || status.prs.length === 0) {
              prsResult[project.id] = null;
              return;
            }
            // The relay's state for each PR the relay knows about (issues
            // #1630, #1744). This half is where the panel's PR list comes from
            // in a running app (the batch route feeds the Zustand store, which
            // shadows the per-project fetch). The poller already annotated the
            // cache with the landed check, so this stays a pure cache read plus
            // an in-memory overlay — it never waits on GitHub.
            prsResult[project.id] = {
              ...status,
              prs: annotatePrTasks(app, project.id, overlayRelayRuns(status.prs, result.value)),
            };
          })();

          await Promise.all([branchesPromise, prsPromise]);
        }),
      );
      refsOutcome.settle(app.log, MSG_REFS);

      return { branches: branchesResult, prs: prsResult, defaultBranchCi: defaultBranchCiResult };
    },
  );

  // Per-file unified diff (issue #262, follow-up to #177) — returns the raw
  // patch text for a specific file in a session's effective cwd, computed
  // against `<base>...HEAD` (defaults to `HEAD`). The frontend fetches this
  // on demand when the user clicks a file-change chip in the sidebar.
  // `null` in the response means "no changes to show"; a missing entry
  // means the session was transiently unavailable.
  //
  // Also accepts `projectId` as an alternative to `sessionId` (issue #433's
  // Source Control sidebar section, which has no session to anchor to — it
  // shows a project's own working-tree diff). Exactly one of the two must be
  // given; everything past cwd resolution is shared with the sessionId path.
  app.get<{
    Querystring: { sessionId?: string; projectId?: string; path?: string; base?: string };
  }>(
    "/api/projects/git-file-diff",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            sessionId: { type: "string" },
            projectId: { type: "string" },
            path: { type: "string" },
            base: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { sessionId: sessionIdRaw, projectId: projectIdRaw } = request.query;
      const filePath = request.query.path;
      const base = request.query.base;
      if (!filePath || filePath.includes("..")) return reply.badRequest("Invalid path");
      if ((sessionIdRaw == null) === (projectIdRaw == null)) {
        return reply.badRequest("Provide exactly one of sessionId or projectId");
      }

      let target: { hostId: string; cwd: string };
      if (sessionIdRaw != null) {
        const sessionId = Number(sessionIdRaw);
        if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid sessionId");
        const targets = await resolveSessionCwdTargets(app, [sessionId]);
        if (targets.length === 0 || targets[0].invalid) return reply.notFound("Session not found");
        target = targets[0];
      } else {
        const projectId = Number(projectIdRaw);
        if (!Number.isInteger(projectId)) return reply.badRequest("Invalid projectId");
        const project = getProjectById(app.db, projectId);
        if (!project) return reply.notFound("Project not found");
        target = { hostId: project.hostId, cwd: project.cwd };
      }

      if (target.hostId !== LOCAL_HOST_ID) {
        try {
          const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitFileDiff(
            target.cwd,
            filePath,
            base,
          );
          return { patch: remoteResult.patch ?? null };
        } catch (err) {
          app.log.warn(
            { hostId: target.hostId, sessionId: sessionIdRaw, projectId: projectIdRaw, err },
            "git-file-diff: remote host unavailable",
          );
          return { patch: null };
        }
      }

      if (!isGitRepo(target.cwd)) return { patch: null };

      // Resolve the file path relative to the target cwd.
      // The hook's file_change path can be absolute (Claude Code) or
      // relative (Codex); git needs a path relative to its -C directory.
      const resolvedPath = path.isAbsolute(filePath)
        ? path.relative(target.cwd, filePath)
        : filePath;
      if (resolvedPath.startsWith("..")) return { patch: null };

      const effectiveBase = base === "AUTO" ? (getDefaultBaseRef(target.cwd) ?? undefined) : base;
      const patch = await getFileDiff(target.cwd, resolvedPath, effectiveBase);
      return { patch };
    },
  );

  // Fuller git status for Source Control'sidebar badge (issue #76): branch,
  // short hash, ahead/behind vs. upstream, and per-file status — cloned from
  // the /github handler just above. Two distinct "nothing to show" cases,
  // deliberately given different status codes so the frontend can tell a
  // durable state apart from a recoverable one instead of collapsing both
  // into the same "not a git repository" render (the flicker/no-recovery bug
  // fixed alongside this route change):
  //   - 204: `cwd` genuinely isn't a git repo (or a remote host reports the
  //     same). Durable — no point retrying, no last-known-good to keep.
  //   - 503: `cwd` *is* a repo (or the remote host confirms as much) but
  //     `git status` itself failed transiently, or the remote host is
  //     unreachable. The frontend should keep showing its last-known-good
  //     status here rather than blanking to "not a repo".
  //
  // `?fresh=1` (issue #433, Hermes review on PR #506) opts into
  // getGitStatus's `forceFresh`, bypassing its CACHE_TTL_MS in-memory cache
  // — used by the sidebar's Source Control section and Source Control's own
  // manual "Fetch" buttons, whose whole point is to show the state
  // immediately after a `git fetch`, not whatever was cached up to 5s
  // beforehand. The default 4s live-refresh poll never sets this, so the
  // cache still does its job for that path. Local only for now — a remote-
  // hosted project's Fetch button still shows the agent's own cached read
  // (same limitation Source Control's handleFetch already had).
  app.get<{ Params: { id: string }; Querystring: { sessionId?: string; fresh?: string } }>(
    "/api/projects/:id/git-status",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      if (project.hostId === LOCAL_HOST_ID) {
        if (!isGitRepo(project.cwd)) {
          reply.code(204);
          return;
        }
        const status = await getGitStatus(project.cwd, { forceFresh: request.query.fresh === "1" });
        if (!status) {
          return reply.serviceUnavailable(
            getGitStatusFailure(project.cwd)?.message ?? "git status is temporarily unavailable",
          );
        }
        return status;
      }

      let remoteResult: GitStatusResult;
      try {
        remoteResult = await getRemoteHostClient(app, project.hostId).resolveGitStatus(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, git status unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
      if (!remoteResult.isRepo) {
        reply.code(204);
        return;
      }
      if (!remoteResult.status) {
        return reply.serviceUnavailable(
          remoteResult.problem?.message ?? "git status is temporarily unavailable",
        );
      }
      return remoteResult.status;
    },
  );

  // Local branches + worktrees for Source Control (issue #162's "worktree
  // awareness" — Mullion observes whatever worktrees exist, whoever created
  // them, rather than managing its own). Unlike /git-status, this is
  // deliberately NOT part of the sidebar's 4s live-refresh loop — the
  // frontend only calls this when Source Control is opened (git-refs.ts's own
  // doc comment on why). Same "widget just doesn't render" 204 degradation
  // as /git-status.
  app.get<{ Params: { id: string }; Querystring: { sessionId?: string; detail?: string } }>(
    "/api/projects/:id/git-branches",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
      if (!project) return reply;

      // Issue #442 — opt-in isMerged enrichment (extra base-resolution +
      // `git branch --merged` spawns), set only by Source Control's own
      // explicit fetch. The batch /git-refs route below calls this with no
      // `detail` param, so it keeps paying for exactly the one
      // for-each-ref spawn it always has.
      const detail = request.query.detail === "1";

      let result: ProjectGitBranchesResult | null;
      try {
        result = await resolveProjectGitBranches(app, project, detail);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, git branches unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
      if (!result) {
        reply.code(204);
        return;
      }
      return result;
    },
  );

  // History for the right sidebar's Git view. A local project reads git
  // directly; a remote one goes through the host agent's /internal/git-log,
  // /git-commit and /git-commit-file (issue #1969), which re-validate the
  // worktree on their side. `cwd` optionally scopes the query to one of the
  // project's own worktrees; it is accepted only if `git worktree list`
  // reports it, so it can never point git at an arbitrary directory.
  async function resolveGitLogCwd(
    project: ProjectRow,
    requestedCwd: string | undefined,
  ): Promise<string | "forbidden"> {
    if (requestedCwd === undefined || requestedCwd === project.cwd) return project.cwd;
    if (project.hostId !== LOCAL_HOST_ID) return requestedCwd; // the agent validates it
    const worktrees = await listWorktrees(project.cwd);
    // Hand back git's own path for the match, never the request's string.
    const match = worktrees?.find((w) => w.path === requestedCwd);
    return match ? match.path : "forbidden";
  }

  // Runs a remote history read. Returns the value, or sends the reply: 204
  // for an agent too old to have the route (same "nothing to show" as other
  // git widgets), 503 when the host can't be reached, 400 for a worktree the
  // agent refused. `undefined` in the return means "reply already sent".
  async function remoteHistory<T>(
    project: ProjectRow,
    reply: FastifyReply,
    call: () => Promise<HostGitResult<HostHistoryValue<T>>>,
  ): Promise<{ value: T } | undefined> {
    const result = await call();
    if (!result.ok) {
      if (result.reason === "unsupported") {
        reply.code(204).send();
      } else {
        const bindings = { hostId: project.hostId, detail: result.detail };
        if (result.reason === "busy") {
          app.log.warn(bindings, "host busy, git history temporarily unavailable");
          reply.status(503).send({ message: `Host ${project.hostId} is busy`, retryable: true });
        } else if (result.status !== undefined) {
          app.log.warn(bindings, "host rejected git history request");
          reply.badGateway(result.detail);
        } else {
          app.log.warn(bindings, "host unreachable, git history unavailable");
          reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
        }
      }
      return undefined;
    }
    if (result.value.forbidden) {
      reply.badRequest("cwd is not one of this project's worktrees");
      return undefined;
    }
    return { value: result.value.value };
  }

  const gitLogRateLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.get<{
    Params: { id: string };
    Querystring: {
      sessionId?: string;
      cwd?: string;
      skip?: string;
      limit?: string;
      scope?: string;
    };
  }>("/api/projects/:id/git-log", gitLogRateLimit, async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
    const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
    if (!project) return reply;
    const cwd = await resolveGitLogCwd(project, request.query.cwd);
    if (cwd === "forbidden") return reply.badRequest("cwd is not one of this project's worktrees");
    const skip = request.query.skip === undefined ? 0 : Number(request.query.skip);
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit < 1) {
      return reply.badRequest("skip and limit must be non-negative integers");
    }
    const scope = request.query.scope;
    const branchScope = scope?.startsWith("branch:") ? scope.slice("branch:".length) : undefined;
    if (branchScope !== undefined) {
      if (!isPlainBranchName(branchScope)) return reply.badRequest("Invalid branch name");
    } else if (scope !== undefined && scope !== "all" && scope !== "head") {
      return reply.badRequest("scope must be all, head or branch:<name>");
    }
    let commits: Awaited<ReturnType<typeof getCommitLog>>;
    if (project.hostId === LOCAL_HOST_ID) {
      commits = await getCommitLog(cwd, {
        skip,
        limit,
        all: scope !== "head",
        branch: branchScope,
      });
    } else if (branchScope !== undefined) {
      // The host agent has no per-branch log route yet: same "nothing to
      // show" 204 as any other unsupported remote widget.
      reply.code(204);
      return;
    } else {
      const remote = await remoteHistory(project, reply, () =>
        resolveHostGitLog(app, project.hostId, project.cwd, {
          worktree: cwd === project.cwd ? undefined : cwd,
          skip,
          limit,
          scope: scope === "head" ? "head" : "all",
        }),
      );
      if (!remote) return reply;
      commits = remote.value;
    }
    if (!commits) {
      reply.code(204);
      return;
    }
    return { commits, hasMore: commits.length >= Math.min(limit, MAX_LOG_PAGE) };
  });

  app.get<{
    Params: { id: string; sha: string };
    Querystring: { sessionId?: string; cwd?: string };
  }>("/api/projects/:id/git-commit/:sha", gitLogRateLimit, async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
    if (!isValidSha(request.params.sha)) return reply.badRequest("Invalid commit id");
    const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
    if (!project) return reply;
    const cwd = await resolveGitLogCwd(project, request.query.cwd);
    if (cwd === "forbidden") return reply.badRequest("cwd is not one of this project's worktrees");
    let detail: Awaited<ReturnType<typeof getCommitDetail>>;
    if (project.hostId === LOCAL_HOST_ID) {
      detail = await getCommitDetail(cwd, request.params.sha);
    } else {
      const remote = await remoteHistory(project, reply, () =>
        resolveHostGitCommit(
          app,
          project.hostId,
          project.cwd,
          request.params.sha,
          cwd === project.cwd ? undefined : cwd,
        ),
      );
      if (!remote) return reply;
      detail = remote.value;
    }
    if (!detail) return reply.notFound("Commit not found");
    return detail;
  });

  app.get<{
    Params: { id: string; sha: string };
    Querystring: { sessionId?: string; cwd?: string; path?: string };
  }>("/api/projects/:id/git-commit/:sha/file", gitLogRateLimit, async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
    const file = request.query.path;
    if (!isValidSha(request.params.sha) || !file || !isSafeRepoPath(file)) {
      return reply.badRequest("Invalid commit id or path");
    }
    const project = await loadScopedProject(app, projectId, request.query.sessionId, reply);
    if (!project) return reply;
    const cwd = await resolveGitLogCwd(project, request.query.cwd);
    if (cwd === "forbidden") return reply.badRequest("cwd is not one of this project's worktrees");
    let patch: string | null;
    if (project.hostId === LOCAL_HOST_ID) {
      patch = await getCommitFileDiff(cwd, request.params.sha, file);
    } else {
      const remote = await remoteHistory(project, reply, () =>
        resolveHostGitCommitFile(
          app,
          project.hostId,
          project.cwd,
          request.params.sha,
          file,
          cwd === project.cwd ? undefined : cwd,
        ),
      );
      if (!remote) return reply;
      patch = remote.value;
    }
    if (patch === null) return reply.notFound("Diff not available");
    return { patch };
  });
}
