import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";

export async function rootRoute(app: FastifyInstance) {
  // Once the frontend is built, staticPlugin serves its index.html at "/"
  // instead — registering both would collide on the same route.
  if (existsSync(path.resolve(app.config.FRONTEND_DIST))) return;

  app.get("/", async () => {
    return { message: "Hello World" };
  });
}