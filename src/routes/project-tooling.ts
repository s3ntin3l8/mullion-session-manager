import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import {
  readProjectBriefing,
  writeProjectBriefing,
  deleteProjectBriefing,
  ProjectBriefingTooLargeError,
} from "../services/project-tooling.js";

// Issue: per-project Mullion briefing, authored from the UI. Unlike
// agent-rules.ts (a project's own filesystem, so every route branches on
// project.hostId to proxy a remote-hosted project through /internal), this
// is a DB row that lives only on the primary — see
// CreateSessionOptions.briefingOverride's own doc comment (pty-manager.ts)
// for why it's resolved here and threaded through the spawn body rather
// than read directly by whichever host actually spawns. No host branching
// needed: the row is read/written here regardless of which host a
// project's sessions run on.

const TOOLING_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

const writeBriefingSchema = {
  body: {
    type: "object",
    required: ["briefing"],
    additionalProperties: false,
    properties: {
      // No maxLength here — writeProjectBriefing's own byte-length check
      // (MAX_PROJECT_BRIEFING_BYTES, UTF-8 bytes) is the real bound and
      // returns a clean 400 with the actual byte count; a schema
      // maxLength here would only bound character count, not bytes, and
      // would reject with ajv's generic message instead.
      briefing: { type: "string" },
    },
  },
};

export async function projectToolingRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  // GET /api/projects/:id/tooling — { briefing: string | null }. `null`
  // (not 404) is the ordinary "no DB-authored briefing yet" case; 404 is
  // reserved for an unknown project id.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/tooling",
    TOOLING_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      return { briefing: readProjectBriefing(app.db, projectId) };
    },
  );

  // PUT /api/projects/:id/tooling — upserts the briefing row. Returns the
  // written value back (same "read-after-write" shape as agent-rules.ts's
  // PUT) so the frontend never has to guess whether a byte-length check
  // silently altered anything.
  app.put<{ Params: { id: string }; Body: { briefing: string } }>(
    "/api/projects/:id/tooling",
    { ...TOOLING_RATE_LIMIT, schema: writeBriefingSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      try {
        writeProjectBriefing(app.db, projectId, request.body.briefing);
      } catch (err) {
        if (err instanceof ProjectBriefingTooLargeError) return reply.badRequest(err.message);
        throw err;
      }
      return { briefing: readProjectBriefing(app.db, projectId) };
    },
  );

  // DELETE /api/projects/:id/tooling — removes the row entirely, NOT the
  // same as PUTting an empty string (see deleteProjectBriefing's own doc
  // comment for why that distinction matters to a project's committed
  // AGENTS.md/CLAUDE.md region). 204 either way — deleting an
  // already-absent row is not an error, same posture as agent-rules.ts's
  // DELETE.
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/tooling",
    TOOLING_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      deleteProjectBriefing(app.db, projectId);
      reply.code(204);
    },
  );
}
