import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { claudeSessionsDirsFor } from "../services/claude-scratch.js";
import { getStoredSettings } from "../services/settings.js";
import { expandHome, parseProjectsRootsEnv } from "../services/project-config.js";
import { inspectDockerStorage, pruneDockerStorage } from "../services/docker-storage.js";
import { inspectTempStorage, pruneTempStorage } from "../services/temp-storage.js";
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
import { createMeasuredProbe } from "../services/measured-probe.js";
import {
  CLEANUP_IN_PROGRESS,
  createCleanupRunner,
  type CleanupMode,
  type CleanupStepPlan,
  type CleanupStepResult,
} from "../services/disk-cleanup-job.js";

const STATS_CACHE_MS = 10_000;
// `docker system df -v` is quick enough to keep fresh.
const DOCKER_INSPECT_CACHE_MS = 30_000;
// The temp, cache, opencode and worktree measurements walk the disk (minutes,
// for a large /tmp), so they are held for five minutes; the Refresh button
// (`?refresh=1`) is how a user asks for a new one sooner. The clock runs from
// when a measurement finishes, never from when it started.
const SLOW_INSPECT_CACHE_MS = 5 * 60_000;
const refreshRequested = (query: { refresh?: string }) => query.refresh === "1";
const REFRESH_QUERY = {
  schema: { querystring: { type: "object", properties: { refresh: { type: "string" } } } },
};
const PRUNE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };
// A cleanup only skips a source on a measurement this fresh. An older one (a
// daemon that has since come up, opencode that has since exited) is ignored and
// the source simply runs: each prune re-checks its own safety.
const SKIP_DECISION_MAX_AGE_MS = 60_000;

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

  app.get<{ Querystring: { refresh?: string } }>(
    "/api/system-stats",
    REFRESH_QUERY,
    async (request) => {
      if (!refreshRequested(request.query) && cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      const value = await sampleSystemStats(monitoredPaths(app));
      cached = { expiresAt: Date.now() + STATS_CACHE_MS, value };
      return value;
    },
  );

  const docker = createMeasuredProbe(() => inspectDockerStorage(), {
    ttlMs: DOCKER_INSPECT_CACHE_MS,
  });
  const temp = createMeasuredProbe(
    () => inspectTempStorage({ claudeSessionsDirs: claudeSessionsDirs(app) }),
    { ttlMs: SLOW_INSPECT_CACHE_MS },
  );
  const opencode = createMeasuredProbe(() => inspectOpencodeStorage(), {
    ttlMs: SLOW_INSPECT_CACHE_MS,
  });
  const worktrees = createMeasuredProbe(() => inspectDevWorktrees(devWorktreeOptions()), {
    ttlMs: SLOW_INSPECT_CACHE_MS,
  });
  const caches = createMeasuredProbe(() => inspectCacheStorage(), {
    ttlMs: SLOW_INSPECT_CACHE_MS,
  });

  const probeRoutes = [
    ["docker", docker],
    ["temp", temp],
    ["opencode", opencode],
    ["worktrees", worktrees],
    ["caches", caches],
  ] as const;
  for (const [name, probe] of probeRoutes) {
    app.get<{ Querystring: { refresh?: string } }>(
      `/api/storage/${name}`,
      REFRESH_QUERY,
      async (request) => probe.read({ refresh: refreshRequested(request.query) }),
    );
  }

  // A source's own "already running" guard surfaces as a code, not a sentence.
  const PRUNE_ERRORS: Record<string, string> = {
    DOCKER_PRUNE_IN_PROGRESS: "Docker cleanup is already running",
    TEMP_PRUNE_IN_PROGRESS: "Temp file cleanup is already running",
    CACHE_PRUNE_IN_PROGRESS: "Cache cleanup is already running",
    OPENCODE_PRUNE_IN_PROGRESS: "opencode database cleanup is already running",
    DEV_WORKTREE_PRUNE_IN_PROGRESS: "Developer worktree cleanup is already running",
  };

  // Runs one source's prune and drops its measurement afterwards, success or
  // not: the figures on screen are stale either way.
  const step = (
    probe: { invalidate(): void },
    prune: () => Promise<CleanupStepResult>,
  ): (() => Promise<CleanupStepResult>) => {
    return async () => {
      try {
        return await prune();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cleanup failed";
        throw new Error(PRUNE_ERRORS[message] ?? message, { cause: error });
      } finally {
        probe.invalidate();
      }
    };
  };

  // Which sources take part, and why one doesn't, is decided here from what the
  // server has already measured (never from the client, and never by starting a
  // new measurement). A source nobody has measured yet still runs: each prune
  // re-checks its own safety.
  function cleanupPlans(mode: CleanupMode, requestedCacheDirs?: string[]): CleanupStepPlan[] {
    const plans: CleanupStepPlan[] = [];
    const dockerSeen = docker.peek(SKIP_DECISION_MAX_AGE_MS);
    plans.push({
      source: "docker",
      label: "Docker",
      skip:
        dockerSeen && !dockerSeen.available
          ? `Docker unavailable: ${dockerSeen.error ?? "not installed, or permission denied"}`
          : null,
      run: step(docker, () => pruneDockerStorage(mode)),
    });
    const tempSeen = temp.peek(SKIP_DECISION_MAX_AGE_MS);
    plans.push({
      source: "temp",
      label: "Temp files",
      skip:
        tempSeen && !tempSeen.available
          ? `Temp files unavailable: ${tempSeen.error ?? "could not be scanned"}`
          : null,
      run: step(temp, () =>
        pruneTempStorage(mode, { claudeSessionsDirs: claudeSessionsDirs(app) }),
      ),
    });
    if (mode !== "aggressive") return plans;

    // Both sides must agree: the client sends the ids it is showing as ticked
    // (settings are saved on a short debounce, so the stored set can briefly lag
    // an untick), and only ids that are ALSO in the stored opt-in set are
    // emptied. Neither a request nor a stale store can widen the other.
    const stored = getStoredSettings(app.db).diskCleanup.cacheDirs;
    const cacheIds =
      requestedCacheDirs === undefined
        ? stored
        : stored.filter((id) => requestedCacheDirs.includes(id));
    if (cacheIds.length > 0) {
      plans.push({
        source: "caches",
        label: "Caches",
        skip: null,
        run: step(caches, () => pruneCacheStorage(cacheIds)),
      });
    }
    // The VACUUM is skipped whenever opencode has the database open; the prune
    // re-checks that itself, so this only decides what to tell the user.
    const opencodeSeen = opencode.peek(SKIP_DECISION_MAX_AGE_MS);
    if (!opencodeSeen || (opencodeSeen.available && opencodeSeen.reclaimableBytes > 0)) {
      const blocked = !opencodeSeen
        ? null
        : opencodeSeen.compacting
          ? "It is already being compacted"
          : opencodeSeen.inUse
            ? "opencode is running"
            : opencodeSeen.holdersUnknown
              ? "Can't tell whether opencode is running"
              : null;
      plans.push({
        source: "opencode",
        label: "opencode database",
        skip: blocked,
        // Freeing nothing with an explanation means it chose not to act (opencode
        // is running, nothing to reclaim, ...): show that as the reason, not as
        // a quiet "freed 0 B".
        run: step(opencode, async () => {
          const result = await pruneOpencodeStorage();
          return result.reclaimedBytes === 0 && result.output && !result.error
            ? { reclaimedBytes: 0, skipped: result.output }
            : result;
        }),
      });
    }
    // Always, whatever the preview says: it may be loading, failed, or as of the
    // last fetch, and fetching is the first thing the cleanup does. Which
    // worktrees are stale is decided from git and GitHub, never by the client.
    plans.push({
      source: "worktrees",
      label: "Developer worktrees",
      skip: null,
      run: step(worktrees, () => pruneDevWorktrees(devWorktreeOptions())),
    });
    return plans;
  }

  const cleanup = createCleanupRunner({
    onFinished: () => {
      // Free space changed whatever each source reported.
      cached = null;
    },
  });

  app.post<{ Body?: { mode?: CleanupMode; cacheDirs?: string[] } | null }>(
    "/api/storage/cleanup",
    {
      config: { rateLimit: PRUNE_RATE_LIMIT },
      schema: {
        body: {
          type: ["object", "null"],
          properties: {
            mode: { type: "string", enum: ["safe", "aggressive"] },
            cacheDirs: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      // Before building the plan (settings reads, measurement lookups): a second
      // click or tab shouldn't pay for work that is about to be refused.
      if (cleanup.status().state === "running")
        return reply.conflict("A cleanup is already running");
      try {
        const job = cleanup.start(
          request.body?.mode ?? "safe",
          cleanupPlans(request.body?.mode ?? "safe", request.body?.cacheDirs),
        );
        return reply.code(202).send(job);
      } catch (error) {
        if (error instanceof Error && error.message === CLEANUP_IN_PROGRESS) {
          return reply.conflict("A cleanup is already running");
        }
        throw error;
      }
    },
  );

  app.get("/api/storage/cleanup", async () => cleanup.status());
}
