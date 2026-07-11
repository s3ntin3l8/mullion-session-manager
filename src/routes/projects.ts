import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";

interface CreateProjectBody {
  name: string;
  cwd: string;
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

export async function projectsRoute(app: FastifyInstance) {
  app.get("/api/projects", async () => {
    return app.db.select().from(projects).all();
  });

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema },
    async (request, reply) => {
      const { name, cwd } = request.body;
      const [created] = app.db.insert(projects).values({ name, cwd }).returning().all();
      reply.code(201);
      return created;
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
    await Promise.all(
      projectSessions.map((session) => app.pty.terminate(String(session.id))),
    );

    const deleted = app.db.delete(projects).where(eq(projects.id, projectId)).returning().all();
    if (deleted.length === 0) return reply.notFound();
    reply.code(204);
  });
}
