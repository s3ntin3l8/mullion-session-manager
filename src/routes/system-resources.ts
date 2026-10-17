import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { claudeSessionsDirsFor } from "../services/claude-scratch.js";
import { getStoredSettings } from "../services/settings.js";
import { expandHome, parseProjectsRootsEnv } from "../services/project-config.js";
import {
  inspectDockerStorage,
  pruneDockerStorage,
  type DockerPruneMode,
} from "../services/docker-storage.js";
import {
  inspectTempStorage,
  pruneTempStorage,
  type TempPruneMode,
} from "../services/temp-storage.js";
import { inspectCacheStorage, pruneCacheStorage } from "../services/cache-storage.js";
import { inspectOpencodeStorage, pruneOpencodeStorage } from "../services/opencode-storage.js";
import {
  inspectDevWorktrees,
  pruneDevWorktrees,
  type DevWorktreeOptions,
} from "../services/dev-worktrees.js";
import { findMergedPullRequestByHead } from "../services/github-write.js";
import { resolveGitHubToken } from "../services/github-integration.js";
import { resolveRepoRef } from "../services/host-git.js";
import { worktreeInUse } from "../services/worktree-usage.js";
import { sampleSystemStats, type MonitoredPath } from "../services/system-stats.js";

const STATS_CACHE_MS = 10_000;
// `docker system df -v` is slow on large hosts; share one result across polls.
const DOCKER_STORAGE_CACHE_MS = 30_000;
const DOCKER_PRUNE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };

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

// A session started with its own CLAUDE_CONFIG_DIR registers there, not under
// the server's, while the tmp dir is shared. Only active sessions can vouch
// for anything (and only local ones: a remote host's config dir is a path on
// another machine), and a dir that is gone just means nothing registers there.
function claudeSessionsDirs(app: FastifyInstance): string[] {
  const rows = app.db
    .select({ env: sessions.env })
    .from(sessions)
    .innerJoin(projects, eq(sessions.projectId, projects.id))
    .where(
      and(
        eq(sessions.status, "active"),
        eq(projects.hostId, LOCAL_HOST_ID),
        isNotNull(sessions.env),
      ),
    )
    .all();
  return claudeSessionsDirsFor(rows.map((row) => row.env));
}

const MERGED_PR_CACHE_MS = 10 * 60_000;
const MERGED_PR_CACHE_MAX = 500;

export async function systemResourcesRoute(app: FastifyInstance) {
  // The preview polls; a merged PR doesn't un-merge, and an unmerged one is
  // unlikely to merge between two looks, so each (repo, branch, commit) is
  // asked about GitHub at most once per window, answers of "no" included.
  const mergedPrCache = new Map<string, { at: number; pr: number | null }>();

  async function mergedPullRequest(
    project: { cwd: string },
    branch: string,
    tipSha: string,
    defaultBranch: string,
  ): Promise<number | null> {
    const key = `${project.cwd}\0${branch}\0${tipSha}\0${defaultBranch}`;
    const hit = mergedPrCache.get(key);
    if (hit && Date.now() - hit.at < MERGED_PR_CACHE_MS) return hit.pr;
    let pr: number | null = null;
    try {
      const repoRef = await resolveRepoRef(app, { cwd: project.cwd, hostId: LOCAL_HOST_ID });
      const token = repoRef ? await resolveGitHubToken(app, repoRef, "read") : null;
      // Nothing to ask without a GitHub remote and a token: not cached, since
      // either can appear later.
      if (!repoRef || !token) return null;
      const found = await findMergedPullRequestByHead(
        token,
        repoRef.owner,
        repoRef.repo,
        `${repoRef.owner}:${branch}`,
      );
      // Only if it merged exactly this commit (later commits on the branch are
      // work the merged PR doesn't contain), and into the default branch (a
      // merge into another feature branch isn't "elsewhere" yet).
      if (found?.headSha === tipSha && found.baseRef === defaultBranch) pr = found.number;
    } catch {
      // Rate limited, offline, a bad token: unknown, not "no". Answering null
      // without remembering it means the next look asks again.
      return null;
    }
    if (mergedPrCache.size >= MERGED_PR_CACHE_MAX) {
      const oldest = mergedPrCache.keys().next().value;
      if (oldest !== undefined) mergedPrCache.delete(oldest);
    }
    mergedPrCache.set(key, { at: Date.now(), pr });
    return pr;
  }

  // Local projects only: a remote host's worktrees are on another machine.
  function devWorktreeOptions(): DevWorktreeOptions {
    const rows = app.db
      .select({ id: projects.id, name: projects.name, cwd: projects.cwd })
      .from(projects)
      .where(eq(projects.hostId, LOCAL_HOST_ID))
      .all();
    return {
      projects: rows,
      inUse: (_project, worktreePath) => worktreeInUse(app, worktreePath),
      mergedPr: mergedPullRequest,
    };
  }

  let cached: { expiresAt: number; value: Awaited<ReturnType<typeof sampleSystemStats>> } | null =
    null;

  app.get("/api/system-stats", async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await sampleSystemStats(monitoredPaths(app));
    cached = { expiresAt: Date.now() + STATS_CACHE_MS, value };
    return value;
  });

  let dockerCached: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof inspectDockerStorage>>>;
  } | null = null;

  app.get("/api/storage/docker", async () => {
    if (dockerCached && dockerCached.expiresAt > Date.now()) return dockerCached.value;
    const value = inspectDockerStorage();
    dockerCached = { expiresAt: Date.now() + DOCKER_STORAGE_CACHE_MS, value };
    return value;
  });

  app.post<{ Body?: { mode?: DockerPruneMode } }>(
    "/api/storage/docker/prune",
    {
      config: { rateLimit: DOCKER_PRUNE_RATE_LIMIT },
      schema: {
        body: {
          type: ["object", "null"],
          properties: { mode: { type: "string", enum: ["safe", "aggressive"] } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await pruneDockerStorage(request.body?.mode ?? "safe");
        cached = null;
        dockerCached = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "DOCKER_PRUNE_IN_PROGRESS") {
          return reply.conflict("Docker cleanup is already running");
        }
        return reply.internalServerError(
          error instanceof Error ? error.message : "Docker cleanup failed",
        );
      }
    },
  );

  let tempCached: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof inspectTempStorage>>>;
  } | null = null;

  app.get("/api/storage/temp", async () => {
    if (tempCached && tempCached.expiresAt > Date.now()) return tempCached.value;
    const value = inspectTempStorage({ claudeSessionsDirs: claudeSessionsDirs(app) });
    tempCached = { expiresAt: Date.now() + DOCKER_STORAGE_CACHE_MS, value };
    return value;
  });

  app.post<{ Body?: { mode?: TempPruneMode } }>(
    "/api/storage/temp/prune",
    {
      config: { rateLimit: DOCKER_PRUNE_RATE_LIMIT },
      schema: {
        body: {
          type: ["object", "null"],
          properties: { mode: { type: "string", enum: ["safe", "aggressive"] } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await pruneTempStorage(request.body?.mode ?? "safe", {
          claudeSessionsDirs: claudeSessionsDirs(app),
        });
        cached = null;
        tempCached = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "TEMP_PRUNE_IN_PROGRESS") {
          return reply.conflict("Temp file cleanup is already running");
        }
        return reply.internalServerError(
          error instanceof Error ? error.message : "Temp file cleanup failed",
        );
      }
    },
  );

  let opencodeCached: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof inspectOpencodeStorage>>>;
  } | null = null;

  app.get("/api/storage/opencode", async () => {
    if (opencodeCached && opencodeCached.expiresAt > Date.now()) return opencodeCached.value;
    const value = inspectOpencodeStorage();
    opencodeCached = { expiresAt: Date.now() + DOCKER_STORAGE_CACHE_MS, value };
    return value;
  });

  // No body: there is nothing a client can choose. The path is fixed server-side
  // and the VACUUM is skipped whenever opencode has the database open.
  app.post(
    "/api/storage/opencode/prune",
    { config: { rateLimit: DOCKER_PRUNE_RATE_LIMIT } },
    async (_request, reply) => {
      try {
        const result = await pruneOpencodeStorage();
        cached = null;
        opencodeCached = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "OPENCODE_PRUNE_IN_PROGRESS") {
          return reply.conflict("opencode database cleanup is already running");
        }
        return reply.internalServerError(
          error instanceof Error ? error.message : "opencode database cleanup failed",
        );
      }
    },
  );

  let worktreesCached: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof inspectDevWorktrees>>>;
  } | null = null;

  app.get("/api/storage/worktrees", async () => {
    if (worktreesCached && worktreesCached.expiresAt > Date.now()) return worktreesCached.value;
    const value = inspectDevWorktrees(devWorktreeOptions());
    worktreesCached = { expiresAt: Date.now() + DOCKER_STORAGE_CACHE_MS, value };
    return value;
  });

  // No body: which worktrees are stale is decided here, from git and GitHub,
  // never from the client.
  app.post(
    "/api/storage/worktrees/prune",
    { config: { rateLimit: DOCKER_PRUNE_RATE_LIMIT } },
    async (_request, reply) => {
      try {
        const result = await pruneDevWorktrees(devWorktreeOptions());
        cached = null;
        worktreesCached = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "DEV_WORKTREE_PRUNE_IN_PROGRESS") {
          return reply.conflict("Developer worktree cleanup is already running");
        }
        return reply.internalServerError(
          error instanceof Error ? error.message : "Developer worktree cleanup failed",
        );
      }
    },
  );

  let cachesCached: {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof inspectCacheStorage>>>;
  } | null = null;

  app.get("/api/storage/caches", async () => {
    if (cachesCached && cachesCached.expiresAt > Date.now()) return cachesCached.value;
    const value = inspectCacheStorage();
    cachesCached = { expiresAt: Date.now() + DOCKER_STORAGE_CACHE_MS, value };
    return value;
  });

  // Both sides must agree: the client sends the ids it is showing as ticked
  // (settings are saved on a short debounce, so the stored set can briefly lag
  // an untick), and only ids that are ALSO in the stored opt-in set are
  // emptied. Neither a request nor a stale store can widen the other.
  app.post<{ Body?: { cacheDirs?: string[] } | null }>(
    "/api/storage/caches/prune",
    {
      config: { rateLimit: DOCKER_PRUNE_RATE_LIMIT },
      schema: {
        body: {
          type: ["object", "null"],
          properties: { cacheDirs: { type: "array", items: { type: "string" }, maxItems: 20 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const stored = getStoredSettings(app.db).diskCleanup.cacheDirs;
        const requested = request.body?.cacheDirs;
        const ids =
          requested === undefined ? stored : stored.filter((id) => requested.includes(id));
        const result = await pruneCacheStorage(ids);
        cached = null;
        cachesCached = null;
        return result;
      } catch (error) {
        if (error instanceof Error && error.message === "CACHE_PRUNE_IN_PROGRESS") {
          return reply.conflict("Cache cleanup is already running");
        }
        return reply.internalServerError(
          error instanceof Error ? error.message : "Cache cleanup failed",
        );
      }
    },
  );
}
