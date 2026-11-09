import type { FastifyInstance } from "fastify";
import { listFavoriteProjectUrls } from "../services/browser-store.js";

export async function browserUrlsRoute(app: FastifyInstance) {
  app.get("/api/browser-urls/favorites", async (_request, _reply) => {
    return listFavoriteProjectUrls(app);
  });
}
