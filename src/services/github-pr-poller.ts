import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { parseGitRemote } from "./git-remote.js";
import { getToken } from "./github-integration.js";
import { GitHubApiError, getRepoPRsStatus, setRepoPRsStatus } from "./github.js";

const POLL_INTERVAL_MS = 60_000;
// Stagger initial fetches so N projects don't all hit GitHub at once.
const STARTUP_STAGGER_MS = 2_000;

export function startGitHubPRPoller(app: FastifyInstance): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function pollOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const token = getToken(app);
      if (!token) {
        app.log.debug("[github-pr-poller] no token configured, skipping");
        return;
      }

      const rows = app.db
        .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
        .from(projects)
        .where(eq(projects.hostId, "local"))
        .all();

      if (rows.length === 0) return;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const repoRef = parseGitRemote(row.cwd);
        if (!repoRef) continue;

        try {
          const status = await getRepoPRsStatus(token, repoRef.owner, repoRef.repo);
          setRepoPRsStatus(repoRef.owner, repoRef.repo, status);
        } catch (err) {
          if (err instanceof GitHubApiError) {
            app.log.warn(
              { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
              "[github-pr-poller] GitHub API error",
            );
          } else {
            app.log.error(
              { err, owner: repoRef.owner, repo: repoRef.repo },
              "[github-pr-poller] unexpected error",
            );
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, "[github-pr-poller] poll cycle failed");
    } finally {
      running = false;
    }
  }

  // Staggered initial sweep — schedule the recurring interval only after
  // every staggered fetch has completed, so the first interval tick can't
  // race with a still-running initial fetch (Hermes review, PR #223).
  const initialTimers: ReturnType<typeof setTimeout>[] = [];
  const rows = app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .where(eq(projects.hostId, "local"))
    .all();

  if (rows.length === 0) {
    interval = setInterval(pollOnce, POLL_INTERVAL_MS);
    interval.unref();
    return () => {
      if (interval) clearInterval(interval);
    };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const repoRef = parseGitRemote(row.cwd);
    if (!repoRef) continue;

    const t = setTimeout(async () => {
      try {
        const token = getToken(app);
        if (!token) return;
        const status = await getRepoPRsStatus(token, repoRef.owner, repoRef.repo);
        setRepoPRsStatus(repoRef.owner, repoRef.repo, status);
      } catch (err) {
        app.log.warn(
          { err, owner: repoRef.owner, repo: repoRef.repo },
          "[github-pr-poller] initial fetch failed",
        );
      }
    }, i * STARTUP_STAGGER_MS);
    t.unref();
    initialTimers.push(t);
  }

  // Schedule the recurring interval to start after the longest staggered
  // delay plus a generous margin for the slowest fetch to finish.
  const longestDelay = (rows.length - 1) * STARTUP_STAGGER_MS;
  const margin = Math.max(POLL_INTERVAL_MS * 2, 10_000);
  sweepTimer = setTimeout(() => {
    pollOnce();
    interval = setInterval(pollOnce, POLL_INTERVAL_MS);
    interval.unref();
  }, longestDelay + margin);
  sweepTimer.unref();

  return () => {
    for (const t of initialTimers) clearTimeout(t);
    if (sweepTimer) clearTimeout(sweepTimer);
    if (interval) clearInterval(interval);
  };
}
