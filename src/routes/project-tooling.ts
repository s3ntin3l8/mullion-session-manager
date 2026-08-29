import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { parseSkillFrontmatter } from "../services/skills.js";
import { isDangerousSkillName } from "../services/hook-adapters/skill-name.js";
import {
  readProjectBriefing,
  writeProjectBriefing,
  deleteProjectBriefing,
  readProjectSkill,
  writeProjectSkill,
  deleteProjectSkill,
  readProjectReviewerAgent,
  writeProjectReviewerAgent,
  deleteProjectReviewerAgent,
  ProjectBriefingTooLargeError,
  ProjectToolingFieldTooLargeError,
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
//
// PR-5 extended this to `skill`/`reviewerAgent` on the same row — each
// gets its own PUT/DELETE (independent of the other two fields, per
// project-tooling.ts's clearToolingColumn semantics), but GET returns all
// three together in one response so the frontend never needs three
// separate round trips just to render the panel.

const TOOLING_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

const writeBriefingSchema = {
  body: {
    type: "object",
    required: ["briefing"],
    additionalProperties: false,
    properties: {
      // No maxLength here — writeProjectBriefing's own byte-length check
      // (MAX_PROJECT_TOOLING_FIELD_BYTES, UTF-8 bytes) is the real bound and
      // returns a clean 400 with the actual byte count; a schema
      // maxLength here would only bound character count, not bytes, and
      // would reject with ajv's generic message instead.
      briefing: { type: "string" },
    },
  },
};

const writeSkillSchema = {
  body: {
    type: "object",
    required: ["skill"],
    additionalProperties: false,
    properties: { skill: { type: "string" } },
  },
};

const writeReviewerAgentSchema = {
  body: {
    type: "object",
    required: ["reviewerAgent"],
    additionalProperties: false,
    properties: { reviewerAgent: { type: "string" } },
  },
};

export class ProjectSkillContentInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProjectSkillContentInvalidError";
  }
}

// Shared by both the skill and reviewer-agent PUT handlers below — both
// fields are stored as raw Markdown with the same `name`/`description`
// YAML-frontmatter shape SKILL.md and .claude/agents/*.md subagent files
// both use (skills.ts's parseSkillFrontmatter only ever reads those two
// keys, ignoring anything else, e.g. a reviewer file's own `tools:`/
// `model:` fields — see schema.ts's own doc comment on why reviewerAgent is
// stored in that one Claude-Code shape and translated per-adapter at spawn
// time rather than validated against every adapter's own schema here).
// Rejecting unparseable/unsafe frontmatter HERE, at write time, matters:
// hook-adapters/mullion-bundle.ts's composeClaudeSessionBundle silently
// skips content it can't derive a safe directory/file name from, so an
// invalid save would otherwise look like it worked and then simply never
// show up in any session — a confusing silent no-op rather than a clear
// 400 at the moment the mistake was made.
function assertValidSkillLikeContent(raw: string): void {
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed) {
    throw new ProjectSkillContentInvalidError(
      "Missing or unparseable YAML frontmatter — both `name` and `description` are required",
    );
  }
  if (isDangerousSkillName(parsed.name)) {
    throw new ProjectSkillContentInvalidError(`"${parsed.name}" is not a safe name`);
  }
}

export async function projectToolingRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  // GET /api/projects/:id/tooling — { briefing, skill, reviewerAgent }, each
  // string | null. `null` (not 404) is the ordinary "not authored yet" case
  // per field; 404 is reserved for an unknown project id.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/tooling",
    TOOLING_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      return {
        briefing: readProjectBriefing(app.db, projectId),
        skill: readProjectSkill(app.db, projectId),
        reviewerAgent: readProjectReviewerAgent(app.db, projectId),
      };
    },
  );

  // PUT /api/projects/:id/tooling — upserts the briefing field. Returns the
  // written value back (read-after-write) so the frontend never has to
  // guess whether a byte-length check silently altered anything.
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

  // DELETE /api/projects/:id/tooling — clears the briefing field, NOT the
  // same as PUTting an empty string (see deleteProjectBriefing's own doc
  // comment). Leaves skill/reviewerAgent on the same row untouched. 204
  // either way — clearing an already-unset field is not an error.
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

  // PUT/DELETE /api/projects/:id/tooling/skill — independent of briefing
  // above. Validated against parseSkillFrontmatter before it ever reaches
  // the DB (see assertValidSkillLikeContent's own doc comment).
  app.put<{ Params: { id: string }; Body: { skill: string } }>(
    "/api/projects/:id/tooling/skill",
    { ...TOOLING_RATE_LIMIT, schema: writeSkillSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      try {
        assertValidSkillLikeContent(request.body.skill);
        writeProjectSkill(app.db, projectId, request.body.skill);
      } catch (err) {
        if (err instanceof ProjectToolingFieldTooLargeError) return reply.badRequest(err.message);
        if (err instanceof ProjectSkillContentInvalidError) return reply.badRequest(err.message);
        throw err;
      }
      return { skill: readProjectSkill(app.db, projectId) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/tooling/skill",
    TOOLING_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      deleteProjectSkill(app.db, projectId);
      reply.code(204);
    },
  );

  // PUT/DELETE /api/projects/:id/tooling/reviewer-agent — same posture as
  // /skill above.
  app.put<{ Params: { id: string }; Body: { reviewerAgent: string } }>(
    "/api/projects/:id/tooling/reviewer-agent",
    { ...TOOLING_RATE_LIMIT, schema: writeReviewerAgentSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      try {
        assertValidSkillLikeContent(request.body.reviewerAgent);
        writeProjectReviewerAgent(app.db, projectId, request.body.reviewerAgent);
      } catch (err) {
        if (err instanceof ProjectToolingFieldTooLargeError) return reply.badRequest(err.message);
        if (err instanceof ProjectSkillContentInvalidError) return reply.badRequest(err.message);
        throw err;
      }
      return { reviewerAgent: readProjectReviewerAgent(app.db, projectId) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/tooling/reviewer-agent",
    TOOLING_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!getProjectOr404(projectId)) return reply.notFound();

      deleteProjectReviewerAgent(app.db, projectId);
      reply.code(204);
    },
  );
}
