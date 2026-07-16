import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { projects, sessions } from "../db/schema.js";
import {
  expandHome,
  resolveProjectActions,
  resolveProjectDock,
} from "../services/project-config.js";
import { resolveGlobalPresets } from "./actions.js";

interface CreateProjectBody {
  name: string;
  cwd: string;
}

interface UpdateProjectBody {
  name?: string;
  cwd?: string;
}

interface DiscoveredProject {
  name: string;
  cwd: string;
  isGitRepo: boolean;
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
 * Scan each configured PROJECTS_ROOTS entry's immediate subdirectories for
 * candidate projects — vision item #1's auto-detection. Purely a
 * suggestion: this never inserts a row itself, it just flags which
 * candidates are already registered (matched by `cwd`) so the client can
 * offer "+ Add" only for the rest via the existing POST /api/projects.
 */
function discoverCandidates(
  rootsConfig: string,
): Array<{ name: string; cwd: string; isGitRepo: boolean }> {
  const roots = rootsConfig
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map(expandHome);

  const candidates = new Map<string, { name: string; cwd: string; isGitRepo: boolean }>();

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      console.warn(`[projects] failed to scan PROJECTS_ROOTS entry ${root}, skipping`, err);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cwd = path.join(root, entry.name);
      candidates.set(cwd, {
        name: entry.name,
        cwd,
        isGitRepo: existsSync(path.join(cwd, ".git")),
      });
    }
  }

  return [...candidates.values()];
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
  app.get(
    "/api/projects/discover",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async () => {
      const candidates = discoverCandidates(app.config.PROJECTS_ROOTS);
      const registeredCwds = new Set(
        app.db
          .select({ cwd: projects.cwd })
          .from(projects)
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

    const globalPresets = await resolveGlobalPresets(app);
    return resolveProjectActions(project.cwd, globalPresets);
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

    return resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR);
  });

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema },
    async (request, reply) => {
      const { name, cwd } = request.body;
      // The create-project modal's own placeholder is a literal `~/...`
      // path (ported from the design) — expand it the same way
      // PROJECTS_ROOTS/CRS_CONFIG_DIR already are, so a session spawned
      // against this project's cwd doesn't fail to resolve it.
      const [created] = app.db
        .insert(projects)
        .values({ name, cwd: expandHome(cwd) })
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

      const { name, cwd } = request.body;
      const updated = app.db
        .update(projects)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(cwd !== undefined ? { cwd: expandHome(cwd) } : {}),
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

    const projectSessions = app.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .all();
    await Promise.all(projectSessions.map((session) => app.pty.terminate(String(session.id))));

    const deleted = app.db.delete(projects).where(eq(projects.id, projectId)).returning().all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });
}
