import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import {
  discoverCandidates,
  expandHome,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
  type DiscoveredCandidate,
} from "../services/project-config.js";
import { getStoredSettings } from "../services/settings.js";
import { resolveGlobalPresets } from "./actions.js";
import { LOCAL_HOST_ID, getHostRow } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { resolveBackend } from "../services/session-backend.js";
import { parseGitRemote, type GitHubRepoRef } from "../services/git-remote.js";
import { readGitBranch } from "../services/git-branch.js";
import { getGitStatus, isGitRepo, type GitStatus } from "../services/git-status.js";
import { getDiffStats, type GitDiffStats } from "../services/git-diff.js";
import {
  listBranches,
  listRemoteBranches,
  listWorktrees,
  type GitBranchInfo,
  type GitWorktreeInfo,
} from "../services/git-refs.js";
import { getToken } from "../services/github-integration.js";
import {
  GitHubApiError,
  getRepoStatus,
  getPRsStatus,
  computePRSummary,
} from "../services/github.js";
import { detectDevServerPortForSessionIds } from "../services/dev-server-detect.js";

interface CreateProjectBody {
  name: string;
  cwd: string;
  hostId?: string;
}

interface UpdateProjectBody {
  name?: string;
  cwd?: string;
  // Bare port ("5173") or a full "scheme://host:port" URL — see schema.ts.
  // `null` clears a previously-set value.
  devServerUrl?: string | null;
}

interface DiscoveredProject extends DiscoveredCandidate {
  isRegistered: boolean;
}

const createProjectSchema = {
  body: {
    type: "object",
    required: ["name", "cwd"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
    },
  },
};

const updateProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      devServerUrl: { type: ["string", "null"], minLength: 1 },
    },
  },
};

// Issue #28's per-project dev-server field — the authoritative, manually-set
// fallback the preview proxy resolves against (auto-discovery, a later
// phase, only ever pre-fills this; it never overrides it). Accepts either a
// bare port, since "the project's dev server" is usually all a user actually
// knows, or a full URL for the uncommon case (non-default host/path). This
// only checks shape (a well-formed port/URL) — it deliberately does not
// reject a host component like "http://localhost:5173" for a remote-hosted
// project, because that host is never actually used for one: the preview
// proxy forces the connection to the owning agent's own loopback and only
// forwards the port/path from here (see schema.ts's devServerUrl comment).
const DEV_SERVER_PORT_ONLY = /^\d{1,5}$/;

function isValidDevServerUrl(value: string): boolean {
  if (DEV_SERVER_PORT_ONLY.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve the effective set of scan roots: settings.projectRoots (edited
 * from Settings -> Projects & discovery) wins when non-empty; an empty
 * settings array falls back to the deploy-time PROJECTS_ROOTS env var, so a
 * fresh install keeps working from its env config until someone actually
 * edits roots from the UI. DB-backed, so only meaningful on the primary —
 * an "agent" role (issue #26) has no settings and always uses
 * parseProjectsRootsEnv(app.config.PROJECTS_ROOTS) directly instead (see
 * routes/internal.ts).
 */
function resolveProjectRoots(app: FastifyInstance): string[] {
  const projectRoots = getStoredSettings(app.db).projectRoots;
  if (projectRoots.length > 0) return projectRoots.map(expandHome);

  return parseProjectsRootsEnv(app.config.PROJECTS_ROOTS);
}

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

interface SessionCwdTarget {
  sessionId: number;
  hostId: string;
  cwd: string;
}

/**
 * Effective cwd per session (`liveCwd ?? row.cwd ?? project.cwd`) joined to
 * its project's `hostId` — the shared "which host, which path" resolution
 * used by both the batch git-status and git-diff-stats session endpoints
 * below (issue #202). This is the plan's deliberate deviation from a
 * `session.worktreePath` column: `sessions.cwd` is already passed verbatim
 * as the spawn cwd with no confinement to the project root (see
 * sessions.ts's getOrCreate), so a worktree session's cwd can already point
 * anywhere — no schema change needed to derive it.
 *
 * `liveCwd` (issue: sidebar worktree display) is this process's own in-memory
 * PtyManager state — the shell's OSC-7-announced cwd, which reflects a
 * manual `cd` after launch that `sessions.cwd` (written once, at creation)
 * never does. Only merged for a LOCAL session: `app.pty` here only tracks
 * sessions this process itself spawned/attached (same caveat as this file's
 * detectedDevServerPort above) — a remote session's live cwd lives in that
 * agent's own PtyManager instead, out of reach from here. (The plain session
 * list's `Session.liveCwd` field, unlike this function, IS remote-aware —
 * see sessions.ts's withLiveInfo, which goes through resolveBackend(hostId)
 * .liveStatus() and therefore reaches the owning host's own PtyManager
 * regardless of which host that is. Extending that same reach to this
 * function's batch git-status/diff-stats resolution would need a new
 * remote-side endpoint; deferred as a known gap for remote-hosted worktree
 * sessions rather than silently assumed to already work.)
 *
 * A `liveCwd` is parsed straight off the PTY byte stream, not a value this
 * process already validated — `isGitRepo`'s absolute-path + no-".."-segment +
 * `.git`-exists guard must pass before it's trusted as a `git -C` target,
 * same as every other cwd this file hands to git. A `liveCwd` that fails
 * that check (stale, mid-typo, a shell integration bug) just falls back to
 * the DB cwd, same "nothing to show" posture as this function's other gaps.
 *
 * A session id with no matching row (already deleted, or a stale/racing
 * client) or whose project has since been deleted is simply omitted from
 * the result — same "nothing to show" posture as every other best-effort
 * lookup in this file, not an error.
 */
function resolveSessionCwdTargets(app: FastifyInstance, sessionIds: number[]): SessionCwdTarget[] {
  if (sessionIds.length === 0) return [];
  const sessionRows = app.db
    .select({ id: sessions.id, cwd: sessions.cwd, projectId: sessions.projectId })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds))
    .all();
  if (sessionRows.length === 0) return [];

  const projectIds = [...new Set(sessionRows.map((s) => s.projectId))];
  const projectRows = app.db.select().from(projects).where(inArray(projects.id, projectIds)).all();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const targets: SessionCwdTarget[] = [];
  for (const row of sessionRows) {
    const project = projectById.get(row.projectId);
    if (!project) continue;
    let cwd = row.cwd ?? project.cwd;
    if (project.hostId === LOCAL_HOST_ID) {
      const liveCwd = app.pty.get(String(row.id))?.liveCwd;
      if (liveCwd && isGitRepo(liveCwd)) cwd = liveCwd;
    }
    targets.push({ sessionId: row.id, hostId: project.hostId, cwd });
  }
  return targets;
}

export async function projectsRoute(app: FastifyInstance) {
  // detectedDevServerPort is derived, not persisted (see dev-server-detect.ts):
  // a project's own devServerUrl column is the sole authoritative value, this
  // is only ever a suggestion the frontend may offer to pre-fill it with.
  // Batched as one extra query across every returned project's active dock
  // sessions, rather than one query per project — this list is polled on
  // every dashboard refresh, so an N+1 here would cost real latency for a
  // feature nobody may even be using.
  //
  // currentBranch (issue #96) rides along on this same response rather than
  // a per-project fetch — it's cheap for a local project (git-branch.ts's
  // pure HEAD read) and, for a remote one, no worse than one extra
  // /internal/git-branch round trip per project on an already-polled list.
  // A single unreachable remote host degrades that project's own
  // currentBranch to null rather than failing the whole list — the same
  // "widget just doesn't render" posture as the /github and /git-status
  // routes below, just without a status code to express it through here.
  app.get("/api/projects", async () => {
    const rows = app.db
      .select()
      .from(projects)
      .orderBy(sql`LOWER(${projects.name})`)
      .all();

    const activeDockSessions = app.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.kind, "dock"), eq(sessions.status, "active")))
      .all();
    const dockSessionIdsByProject = new Map<number, string[]>();
    for (const session of activeDockSessions) {
      const ids = dockSessionIdsByProject.get(session.projectId) ?? [];
      ids.push(String(session.id));
      dockSessionIdsByProject.set(session.projectId, ids);
    }

    return Promise.all(
      rows.map(async (row) => {
        let currentBranch: string | null;
        if (row.hostId === LOCAL_HOST_ID) {
          currentBranch = readGitBranch(row.cwd);
        } else {
          try {
            currentBranch = await getRemoteHostClient(app, row.hostId).resolveGitBranch(row.cwd);
          } catch (err) {
            app.log.warn(
              { hostId: row.hostId, projectId: row.id, err },
              "host unreachable, currentBranch unavailable",
            );
            currentBranch = null;
          }
        }
        return {
          ...row,
          currentBranch,
          // Remote-hosted projects are skipped outright, not just "usually
          // null": app.pty only tracks sessions spawned/attached by this
          // same process, and a remote project's dock session lives in its
          // owning agent's own PtyManager instead — see dev-server-detect.ts's
          // own comment.
          detectedDevServerPort:
            row.hostId === LOCAL_HOST_ID
              ? detectDevServerPortForSessionIds(app, dockSessionIdsByProject.get(row.id) ?? [])
              : null,
        };
      }),
    );
  });

  // A real filesystem scan (readdirSync + existsSync per candidate), so
  // rate-limited more tightly than the app-wide default in security.ts —
  // both apply (this doesn't disable the global one, just tightens it for
  // this specific route). CodeQL's js/missing-rate-limiting query flagged
  // this route as unprotected before this was added — a genuine false
  // positive (the global limiter already covered it, confirmed live: 429s
  // kicked in past RATE_LIMIT_MAX on a real running instance) since the
  // query can't trace a rate limiter registered globally from a separate
  // plugin file back to this handler, but an explicit route-level limit
  // both satisfies that check directly and is independently reasonable
  // given the cost of this specific handler.
  app.get<{ Querystring: { hostId?: string } }>(
    "/api/projects/discover",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const hostId = request.query.hostId ?? LOCAL_HOST_ID;

      let candidates: DiscoveredCandidate[];
      if (hostId === LOCAL_HOST_ID) {
        candidates = discoverCandidates(resolveProjectRoots(app));
      } else {
        if (!getHostRow(app, hostId)) return reply.notFound(`Unknown host ${hostId}`);
        try {
          candidates = await getRemoteHostClient(app, hostId).discover();
        } catch (err) {
          app.log.warn({ hostId, err }, "host unreachable, discovery unavailable");
          return reply.serviceUnavailable(`Host ${hostId} is unreachable`);
        }
      }

      // Discovery is per-host (issue #26): a cwd on one host registering
      // as "already added" must never match a same-path project on a
      // different host, so the match key is (hostId, cwd), not cwd alone.
      const registeredCwds = new Set(
        app.db
          .select({ cwd: projects.cwd })
          .from(projects)
          .where(eq(projects.hostId, hostId))
          .all()
          .map((p) => p.cwd),
      );

      const discovered: DiscoveredProject[] = candidates.map((c) => ({
        ...c,
        isRegistered: registeredCwds.has(c.cwd),
      }));
      return discovered;
    },
  );

  // Merged launcher list for this project — see project-config.ts for the
  // precedence rules (package.json scripts / tasks.json / .crs/actions.json
  // layered over the global shell/agent/config presets from GET
  // /api/actions). Read-only: launching one of these is just the existing
  // POST /api/sessions using its `command` (and `id` as a stable label).
  app.get<{ Params: { id: string } }>("/api/projects/:id/actions", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return reply.notFound();

    if (project.hostId === LOCAL_HOST_ID) {
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(project.cwd, globalPresets);
    }
    // Global presets (installed CLIs, global .crs/actions.json) come from
    // the remote agent's own host, not this process — see
    // remote-host-client.ts's resolveActions and routes/internal.ts's
    // /internal/actions, which resolves both halves host-side already.
    try {
      return await getRemoteHostClient(app, project.hostId).resolveActions(project.cwd);
    } catch (err) {
      app.log.warn({ hostId: project.hostId, err }, "host unreachable, actions unavailable");
      return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    }
  });

  // Dock controls for this project — persistent monitors (dev server, git
  // status, logs), distinct from one-shot launchers above. Read-only config;
  // turning one "on" is just POST /api/sessions with kind: "dock" (see
  // sessions.ts) using this control's own id/command/cwd.
  app.get<{ Params: { id: string } }>("/api/projects/:id/dock", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return reply.notFound();

    if (project.hostId === LOCAL_HOST_ID) {
      return resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR);
    }
    try {
      return await getRemoteHostClient(app, project.hostId).resolveDock(project.cwd);
    } catch (err) {
      app.log.warn({ hostId: project.hostId, err }, "host unreachable, dock unavailable");
      return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    }
  });

  // Per-project GitHub status: open issue/PR counts + lists for whatever
  // repo this project's `origin` remote points at (issue #27). Degrades to
  // a bare 204 rather than erroring in every "not applicable" case — no
  // github.com remote, no GitHub account connected, or GitHub itself
  // rejecting the request (private repo without scope, rate limited, ...)
  // — see the plan's "widget just doesn't render" rule. A host that's
  // unreachable is the one case this treats as a real failure (503),
  // consistent with the actions/dock routes above.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/github",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      let repoRef: GitHubRepoRef | null;
      if (project.hostId === LOCAL_HOST_ID) {
        repoRef = parseGitRemote(project.cwd);
      } else {
        try {
          repoRef = await getRemoteHostClient(app, project.hostId).resolveGitHubRepo(project.cwd);
        } catch (err) {
          app.log.warn(
            { hostId: project.hostId, err },
            "host unreachable, github status unavailable",
          );
          return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
        }
      }
      if (!repoRef) {
        reply.code(204);
        return;
      }

      const token = getToken(app);
      if (!token) {
        reply.code(204);
        return;
      }

      try {
        return await getRepoStatus(token, repoRef.owner, repoRef.repo);
      } catch (err) {
        if (!(err instanceof GitHubApiError)) throw err;
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
          "github status unavailable",
        );
        reply.code(204);
        return;
      }
    },
  );

  // Per-PR CI/CD status (issue #102) — reads from the warm cache populated
  // by the server-side background poller (github-pr-poller.ts). Returns 204
  // when the poller hasn't run yet or the repo has no open PRs (same
  // degradation pattern as the /github endpoint above). Rate-limited the
  // same as /github since this is still a per-project GitHub endpoint.
  //
  // Optional `?branch=<name>` (issue #202): filters the cached PR list down
  // to whichever PR (if any) has that branch as its head — a session row
  // wants only its own worktree's PR, not every open PR in the repo. The
  // frontend's sidebar doesn't actually call this per-session (fetching the
  // unfiltered list once per project and matching `headBranch` client-side
  // is cheaper), but the filter is a real, independently useful capability
  // of this route either way.
  app.get<{ Params: { id: string }; Querystring: { branch?: string } }>(
    "/api/projects/:id/github/prs",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { branch: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      let repoRef: GitHubRepoRef | null;
      if (project.hostId === LOCAL_HOST_ID) {
        repoRef = parseGitRemote(project.cwd);
      } else {
        // Remote-hosted projects (issue #222, follow-up to #102): resolve
        // owner/repo via the agent, same as the /github endpoint above. The
        // per-PR cache is still keyed by owner/repo and populated by the
        // primary-side poller — this route only needs the ref to look it up.
        try {
          repoRef = await getRemoteHostClient(app, project.hostId).resolveGitHubRepo(project.cwd);
        } catch (err) {
          // 503 either way (this route has no way to serve PR status without
          // the ref, and "the agent rejected the request" isn't recoverable
          // by retrying here) — but the log message distinguishes "agent
          // never responded" from "agent responded and said no," since
          // those point a debugger in different directions (Hermes review,
          // PR #244).
          const message =
            err instanceof HostRequestError
              ? "agent rejected github-repo request, github prs status unavailable"
              : "host unreachable, github prs status unavailable";
          app.log.warn({ hostId: project.hostId, err }, message);
          return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
        }
      }
      if (!repoRef) {
        reply.code(204);
        return;
      }

      const token = getToken(app);
      if (!token) {
        reply.code(204);
        return;
      }

      const status = getPRsStatus(repoRef.owner, repoRef.repo);
      if (!status || status.prs.length === 0) {
        reply.code(204);
        return;
      }

      const { branch } = request.query;
      if (branch === undefined) return status;

      const filtered = status.prs.filter((pr) => pr.headBranch === branch);
      if (filtered.length === 0) {
        reply.code(204);
        return;
      }
      return { prs: filtered, prSummary: computePRSummary(filtered) };
    },
  );

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
      if (ids.length > 0) {
        const rows = app.db.select().from(projects).where(inArray(projects.id, ids)).all();

        for (const project of rows) {
          if (project.hostId === LOCAL_HOST_ID) {
            if (!isGitRepo(project.cwd)) {
              projectsResult[project.id] = null;
              continue;
            }
            const status = await getGitStatus(project.cwd);
            if (status) {
              projectsResult[project.id] = status;
            }
          } else {
            try {
              const remoteResult = await getRemoteHostClient(app, project.hostId).resolveGitStatus(
                project.cwd,
              );
              if (!remoteResult.isRepo) {
                projectsResult[project.id] = null;
              } else if (remoteResult.status) {
                projectsResult[project.id] = remoteResult.status;
              }
            } catch (err) {
              app.log.warn(
                { hostId: project.hostId, projectId: project.id, err },
                "batch git-status: remote host unreachable, omitting project",
              );
            }
          }
        }
      }

      const sessionsResult: Record<string, GitStatus | null> = {};
      if (sessionIds.length > 0) {
        const targets = resolveSessionCwdTargets(app, sessionIds);
        for (const target of targets) {
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
              app.log.warn(
                { hostId: target.hostId, sessionId: target.sessionId, err },
                "batch git-status: remote host unavailable for session cwd, omitting",
              );
            }
          }
        }
      }

      return { projects: projectsResult, sessions: sessionsResult };
    },
  );

  // Diff stats (issue #202, greenfield) — files-changed + insertions/
  // deletions per session's effective cwd (git-diff.ts's `git diff HEAD
  // --numstat`), batched the same way as the git-statuses endpoint above
  // and for the same reason (one request per live-refresh tick, not one
  // per session). `null` means "not a repo, or nothing to diff yet"; an id
  // whose stats failed transiently is simply omitted.
  app.get<{ Querystring: { sessionIds?: string } }>(
    "/api/projects/git-diff-stats",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { sessionIds: { type: "string" } },
        },
      },
    },
    async (request) => {
      const sessionIds = parseIdListParam(request.query.sessionIds);
      const result: Record<string, GitDiffStats | null> = {};
      if (sessionIds.length === 0) return result;

      const targets = resolveSessionCwdTargets(app, sessionIds);
      for (const target of targets) {
        if (target.hostId === LOCAL_HOST_ID) {
          if (!isGitRepo(target.cwd)) {
            result[target.sessionId] = null;
            continue;
          }
          const stats = await getDiffStats(target.cwd);
          if (stats) {
            result[target.sessionId] = stats;
          }
        } else {
          try {
            const remoteResult = await getRemoteHostClient(app, target.hostId).resolveGitDiffStats(
              target.cwd,
            );
            if (!remoteResult.isRepo) {
              result[target.sessionId] = null;
            } else if (remoteResult.stats) {
              result[target.sessionId] = remoteResult.stats;
            }
          } catch (err) {
            app.log.warn(
              { hostId: target.hostId, sessionId: target.sessionId, err },
              "batch git-diff-stats: remote host unavailable, omitting",
            );
          }
        }
      }

      return result;
    },
  );

  // Fuller git status for the GitPanel/sidebar badge (issue #76): branch,
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
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/git-status",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        if (!isGitRepo(project.cwd)) {
          reply.code(204);
          return;
        }
        const status = await getGitStatus(project.cwd);
        if (!status) return reply.serviceUnavailable("git status is temporarily unavailable");
        return status;
      }

      let remoteResult: { isRepo: boolean; status: GitStatus | null };
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
        return reply.serviceUnavailable("git status is temporarily unavailable");
      }
      return remoteResult.status;
    },
  );

  // Local branches + worktrees for the GitPanel (issue #162's "worktree
  // awareness" — Mullion observes whatever worktrees exist, whoever created
  // them, rather than managing its own). Unlike /git-status, this is
  // deliberately NOT part of the sidebar's 4s live-refresh loop — the
  // frontend only calls this when the GitPanel is opened (git-refs.ts's own
  // doc comment on why). Same "widget just doesn't render" 204 degradation
  // as /git-status.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/git-branches",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();

      let result: {
        branches: GitBranchInfo[];
        worktrees: GitWorktreeInfo[];
        remoteBranches: string[];
      } | null;
      if (project.hostId === LOCAL_HOST_ID) {
        const [branches, worktrees, remoteBranches] = await Promise.all([
          listBranches(project.cwd),
          listWorktrees(project.cwd),
          listRemoteBranches(project.cwd),
        ]);
        result =
          branches && worktrees && remoteBranches ? { branches, worktrees, remoteBranches } : null;
      } else {
        try {
          result = await getRemoteHostClient(app, project.hostId).resolveGitBranches(project.cwd);
        } catch (err) {
          app.log.warn(
            { hostId: project.hostId, err },
            "host unreachable, git branches unavailable",
          );
          return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
        }
      }
      if (!result) {
        reply.code(204);
        return;
      }
      return result;
    },
  );

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { name, cwd } = request.body;
      const hostId = request.body.hostId ?? LOCAL_HOST_ID;
      if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
        return reply.badRequest(`Unknown hostId ${hostId}`);
      }
      // The create-project modal's own placeholder is a literal `~/...`
      // path (ported from the design) — expand it the same way
      // PROJECTS_ROOTS/CRS_CONFIG_DIR already are, so a session spawned
      // against this project's cwd doesn't fail to resolve it. Only for
      // "local": a remote project's cwd expands against the *agent's* own
      // home dir, not this process's — see host-registry.ts/issue #26's
      // landmine #3 — so it's stored/forwarded raw instead.
      const resolvedCwd = hostId === LOCAL_HOST_ID ? path.resolve(expandHome(cwd)) : cwd;
      const [created] = app.db
        .insert(projects)
        .values({ name, cwd: resolvedCwd, hostId })
        .returning()
        .all();
      // Best-effort: create the directory so a session spawned against this
      // cwd doesn't fail. CodeQL flags this as js/path-injection since
      // resolvedCwd derives from request.body.cwd — that's a false positive
      // at this boundary: /api/projects is the authenticated-primary
      // boundary, and a caller who can reach it can already spawn a session
      // against an arbitrary cwd (full code execution), which is strictly
      // more powerful than mkdir on the same path. Same trust model as
      // internal.ts's resolveWithinRoots docstring for session-spawn cwd.
      // The alert is dismissed as a false positive rather than suppressed.
      if (hostId === LOCAL_HOST_ID) {
        await fs.promises.mkdir(resolvedCwd, { recursive: true }).catch((err) => {
          app.log.warn({ err, cwd: resolvedCwd }, "Could not create project directory");
        });
      }
      reply.code(201);
      return created;
    },
  );

  // Partial update — a project's own edit modal reuses CreateProjectModal
  // pre-filled, submitting whichever of name/cwd changed. Applies the same
  // expandHome() tilde-expansion POST already does, so re-pointing a
  // project at a literal `~/...` path via edit resolves the same way an
  // initial create does, rather than silently producing an unspawnable cwd.
  app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
    "/api/projects/:id",
    { schema: updateProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [existing] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!existing) return reply.notFound();

      const { name, cwd, devServerUrl } = request.body;
      if (
        devServerUrl !== undefined &&
        devServerUrl !== null &&
        !isValidDevServerUrl(devServerUrl)
      ) {
        return reply.badRequest("devServerUrl must be a 1-65535 port or a valid http(s) URL");
      }

      const resolvedCwd =
        cwd !== undefined && existing.hostId === LOCAL_HOST_ID
          ? path.resolve(expandHome(cwd))
          : cwd;
      const updated = app.db
        .update(projects)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(cwd !== undefined ? { cwd: resolvedCwd } : {}),
          ...(devServerUrl !== undefined ? { devServerUrl } : {}),
        })
        .where(eq(projects.id, projectId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
      // Best-effort, same false-positive rationale as the POST handler
      // above: /api/projects is the authenticated-primary boundary, so
      // mkdir on this cwd is no more powerful than the session-spawn cwd
      // this same caller can already reach.
      if (cwd !== undefined && existing.hostId === LOCAL_HOST_ID && resolvedCwd !== undefined) {
        await fs.promises.mkdir(resolvedCwd, { recursive: true }).catch((err) => {
          app.log.warn({ err, cwd: resolvedCwd }, "Could not create project directory");
        });
      }
      return updated[0];
    },
  );

  // Fully terminates every session under this project (master + program,
  // not just our tracked attach-client — see PtyManager.terminate()) before
  // the row delete, whose ON DELETE CASCADE only removes the DB rows.
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!project) return reply.notFound();

    const projectSessions = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .all();
    const backend = resolveBackend(app, project.hostId);
    await Promise.all(
      projectSessions.map((session) =>
        backend.terminate(String(session.id)).catch((err) => {
          // Best-effort, same as hosts.ts's cascade delete: an unreachable
          // host can't be told to terminate anything, and that must not
          // block deleting the (now orphaned-on-that-host) project row.
          app.log.warn(
            { hostId: project.hostId, sessionId: session.id, err },
            "project delete: best-effort session terminate failed",
          );
        }),
      ),
    );

    const deleted = app.db.delete(projects).where(eq(projects.id, projectId)).returning().all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });
}
