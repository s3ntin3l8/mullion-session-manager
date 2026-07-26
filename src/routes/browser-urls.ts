import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projectUrls } from "../db/schema.js";

export async function browserUrlsRoute(app: FastifyInstance) {
  app.get("/api/browser-urls/favorites", async (_request, _reply) => {
    return app.db
      .select()
      .from(projectUrls)
      .where(eq(projectUrls.favorite, true))
      .orderBy(projectUrls.order)
      .all();
  });
}
