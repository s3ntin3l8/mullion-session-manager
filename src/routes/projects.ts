import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
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
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { resolveBackend } from "../services/session-backend.js";
import { parseGitRemote, type GitHubRepoRef } from "../services/git-remote.js";
import { getToken } from "../services/github-integration.js";
import { GitHubApiError, getRepoStatus } from "../services/github.js";

interface CreateProjectBody {
  name: string;
  cwd: string;
  hostId?: string;
}

interface UpdateProjectBody {
  name?: string;
  cwd?: string;
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
    },
  },
};

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

export async function projectsRoute(app: FastifyInstance) {
  app.get("/api/projects", async () => {
    return app.db.select().from(projects).all();
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

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema },
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
      const [created] = app.db
        .insert(projects)
        .values({ name, cwd: hostId === LOCAL_HOST_ID ? expandHome(cwd) : cwd, hostId })
        .returning()
        .all();
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
    { schema: updateProjectSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [existing] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!existing) return reply.notFound();

      const { name, cwd } = request.body;
      const updated = app.db
        .update(projects)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(cwd !== undefined
            ? { cwd: existing.hostId === LOCAL_HOST_ID ? expandHome(cwd) : cwd }
            : {}),
        })
        .where(eq(projects.id, projectId))
        .returning()
        .all();
      if (updated.length === 0) return reply.notFound();
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
