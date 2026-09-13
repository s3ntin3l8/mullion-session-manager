import type { FastifyInstance } from "fastify";
import os from "node:os";
import path from "node:path";
import { getStoredSettings } from "../services/settings.js";
import { expandHome, parseProjectsRootsEnv } from "../services/project-config.js";
import { inspectDockerStorage, pruneDockerStorage } from "../services/docker-storage.js";
import { sampleSystemStats, type MonitoredPath } from "../services/system-stats.js";

const STATS_CACHE_MS = 10_000;

function databaseDirectory(databaseUrl: string): string {
  const dbPath = databaseUrl.replace(/^file:/, "");
  return path.dirname(path.resolve(dbPath));
}

function monitoredPaths(app: FastifyInstance): MonitoredPath[] {
  const configuredRoots = getStoredSettings(app.db).projectRoots;
  const roots =
    configuredRoots.length > 0
      ? configuredRoots.map(expandHome)
      : parseProjectsRootsEnv(app.config.PROJECTS_ROOTS);
  return [
    { label: "Home", path: os.homedir() },
    { label: "Mullion data", path: databaseDirectory(app.config.DATABASE_URL) },
    { label: "Sessions", path: path.resolve(app.config.SESSIONS_DIR) },
    { label: "Working directory", path: process.cwd() },
    ...roots.map((root) => ({ label: `Projects: ${root}`, path: path.resolve(root) })),
  ];
}

export async function systemResourcesRoute(app: FastifyInstance) {
  let cached: { expiresAt: number; value: Awaited<ReturnType<typeof sampleSystemStats>> } | null =
    null;

  app.get("/api/system-stats", async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await sampleSystemStats(monitoredPaths(app));
    cached = { expiresAt: Date.now() + STATS_CACHE_MS, value };
    return value;
  });

  app.get("/api/storage/docker", async () => inspectDockerStorage());

  app.post("/api/storage/docker/prune", async (_request, reply) => {
    try {
      const result = await pruneDockerStorage();
      cached = null;
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "DOCKER_PRUNE_IN_PROGRESS") {
        return reply.conflict("Docker cleanup is already running");
      }
      return reply.internalServerError(
        error instanceof Error ? error.message : "Docker cleanup failed",
      );
    }
  });
}
