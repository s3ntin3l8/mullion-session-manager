import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { parseGitRemote, type GitHubRepoRef } from "./git-remote.js";
import { getToken } from "./github-integration.js";
import { GitHubApiError, getRepoPRsStatus, setRepoPRsStatus } from "./github.js";
import { ActivityTracker } from "./github-activity-tracker.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient, HostRequestError } from "./remote-host-client.js";

async function resolveRemoteRepoRef(
  app: FastifyInstance,
  row: { cwd: string; hostId: string },
): Promise<GitHubRepoRef | null> {
  try {
    return await getRemoteHostClient(app, row.hostId).resolveGitHubRepo(row.cwd);
  } catch (err) {
    const message =
      err instanceof HostRequestError
        ? "[github-pr-poller] agent rejected github-repo request, skipping row"
        : "[github-pr-poller] host unreachable, skipping row";
    app.log.warn({ hostId: row.hostId, err }, message);
    return null;
  }
}

function repoHasActivity(status: { prSummary: { total: number } }): boolean {
  return status.prSummary.total > 0;
}

function computeNextInterval(
  tracker: ActivityTracker,
  rows: { repoRef: GitHubRepoRef | null }[],
  quietIntervalMs: number,
): number {
  let next = quietIntervalMs;
  for (const row of rows) {
    if (!row.repoRef) continue;
    const interval = tracker.getIntervalFor(`${row.repoRef.owner}/${row.repoRef.repo}`);
    if (interval < next) next = interval;
  }
  return next;
}

export function startGitHubPRPoller(app: FastifyInstance, tracker?: ActivityTracker): () => void {
  const activeIntervalMs = app.config.GITHUB_POLL_INTERVAL_ACTIVE * 1000;
  const quietIntervalMs = app.config.GITHUB_POLL_INTERVAL_QUIET * 1000;
  const staleThresholdMs = app.config.GITHUB_POLL_STALE_THRESHOLD * 1000;

  const activityTracker =
    tracker ??
    new ActivityTracker({
      activeIntervalMs,
      quietIntervalMs,
      staleThresholdMs,
    });

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let cleanupCalled = false;
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];

  async function resolveAllRepos(): Promise<{ repoRef: GitHubRepoRef | null }[]> {
    const rows = app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all();
    return Promise.all(
      rows.map(async (row) => ({
        repoRef:
          row.hostId === LOCAL_HOST_ID
            ? parseGitRemote(row.cwd)
            : await resolveRemoteRepoRef(app, row),
      })),
    );
  }

  async function pollOnce(repoRows: { repoRef: GitHubRepoRef | null }[]): Promise<void> {
    if (running) return;
    running = true;
    try {
      const token = getToken(app);
      if (!token) {
        app.log.debug("[github-pr-poller] no token configured, skipping");
        return;
      }

      for (const row of repoRows) {
        if (!row.repoRef) continue;
        const { owner, repo } = row.repoRef;
        const repoKey = `${owner}/${repo}`;

        try {
          const status = await getRepoPRsStatus(token, owner, repo);
          setRepoPRsStatus(owner, repo, status);
          activityTracker.recordPollResult(repoKey, repoHasActivity(status));
        } catch (err) {
          if (err instanceof GitHubApiError) {
            app.log.warn(
              { owner, repo, statusCode: err.statusCode },
              "[github-pr-poller] GitHub API error",
            );
          } else {
            app.log.error({ err, owner, repo }, "[github-pr-poller] unexpected error");
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, "[github-pr-poller] poll cycle failed");
    } finally {
      running = false;
    }
  }

  async function tick(): Promise<void> {
    if (cleanupCalled) return;
    const repoRows = await resolveAllRepos();
    if (cleanupCalled) return;

    await pollOnce(repoRows);
    if (cleanupCalled) return;

    const nextInterval = computeNextInterval(activityTracker, repoRows, quietIntervalMs);
    pollTimer = setTimeout(tick, nextInterval);
    pollTimer.unref();
  }

  // Staggered initial sweep.
  async function start(): Promise<void> {
    const rows = app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all();

    if (rows.length === 0) {
      pollTimer = setTimeout(tick, quietIntervalMs);
      pollTimer.unref();
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const t = setTimeout(async () => {
        if (cleanupCalled) return;
        try {
          const token = getToken(app);
          if (!token) return;
          const repoRef =
            row.hostId === LOCAL_HOST_ID
              ? parseGitRemote(row.cwd)
              : await resolveRemoteRepoRef(app, row);
          if (!repoRef) return;
          const repoKey = `${repoRef.owner}/${repoRef.repo}`;
          const status = await getRepoPRsStatus(token, repoRef.owner, repoRef.repo);
          setRepoPRsStatus(repoRef.owner, repoRef.repo, status);
          activityTracker.recordPollResult(repoKey, repoHasActivity(status));
        } catch (err) {
          app.log.warn(
            { err, hostId: row.hostId, cwd: row.cwd },
            "[github-pr-poller] initial fetch failed",
          );
        }
      }, i * 2_000);
      t.unref();
      timers.push(t);
    }

    const longestDelay = (rows.length - 1) * 2_000;
    const margin = Math.max(quietIntervalMs * 2, 10_000);
    const sweepTimer = setTimeout(() => {
      if (cleanupCalled) return;
      for (const t of timers) clearTimeout(t);
      tick();
    }, longestDelay + margin);
    sweepTimer.unref();
    pendingTimers.push(sweepTimer);
  }

  start();

  return () => {
    cleanupCalled = true;
    if (pollTimer) clearTimeout(pollTimer);
    for (const t of pendingTimers) clearTimeout(t);
  };
}
