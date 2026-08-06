import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

export async function healthRoute(app: FastifyInstance) {
  // Liveness: the process is up and serving.
  app.get("/health", async () => {
    return { status: "healthy" };
  });

  // Readiness: dependencies are reachable. An agent role has no app.db
  // (src/app.ts's agent branch never registers dbPlugin) — probing it would
  // 503 every agent unconditionally, so the DB check only runs when app.db
  // exists at all; app.pty is the one dependency every role has.
  app.get("/ready", async (_request, reply) => {
    try {
      if (app.db) app.db.run(sql`SELECT 1`);
      const sessions = app.pty.list();
      return {
        status: "ready",
        sessions: {
          tracked: sessions.length,
          alive: sessions.filter((s) => s.alive).length,
        },
      };
    } catch (err) {
      app.log.error(err);
      reply.code(503);
      return { status: "unavailable" };
    }
  });
}
