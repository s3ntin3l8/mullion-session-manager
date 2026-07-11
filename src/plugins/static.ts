import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// The frontend (frontend/ — its own Vite project, see M3) is built
// separately and not guaranteed to exist: local dev commonly runs the
// backend and Vite's own dev server side by side instead (Vite proxies
// /api and /ws to this backend), and CI's `npm ci` never touches
// frontend/'s package.json at all. Registering @fastify/static against a
// missing root throws at startup, so this is a no-op until the directory
// is actually there — rootRoute's placeholder handles "/" until then.
export const staticPlugin = fp(async (app: FastifyInstance) => {
  const root = path.resolve(app.config.FRONTEND_DIST);
  if (!existsSync(root)) {
    app.log.debug(`frontend build not found at ${root}; skipping static asset serving`);
    return;
  }

  await app.register(fastifyStatic, { root });
});
