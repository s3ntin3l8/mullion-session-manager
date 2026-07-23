import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { parseGitRemote, type GitHubRepoRef } from "./git-remote.js";
import { getToken } from "./github-integration.js";
import { GitHubApiError, getRepoPRsStatus, setRepoPRsStatus } from "./github.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient, HostRequestError } from "./remote-host-client.js";

const POLL_INTERVAL_MS = 60_000;
// Stagger initial fetches so N projects don't all hit GitHub at once.
const STARTUP_STAGGER_MS = 2_000;

// Owner/repo resolution for a remote-hosted row (issue #222, follow-up to
// #102) — asks the owning agent, mirroring the /github route's remote-host
// handling. A host that's unreachable is swallowed here (logged + null)
// rather than thrown, so one bad host can't abort the rest of a poll sweep.
async function resolveRemoteRepoRef(
  app: FastifyInstance,
  row: { cwd: string; hostId: string },
): Promise<GitHubRepoRef | null> {
  try {
    return await getRemoteHostClient(app, row.hostId).resolveGitHubRepo(row.cwd);
  } catch (err) {
    // HostRequestError means the agent responded (it IS reachable) but
    // rejected the request — a distinct failure mode from a genuine
    // connectivity problem (HostUnreachableError), worth telling apart in
    // the log even though both are treated the same way here: skip this
    // row, don't abort the sweep (Hermes review, PR #244).
    const message =
      err instanceof HostRequestError
        ? "[github-pr-poller] agent rejected github-repo request, skipping row"
        : "[github-pr-poller] host unreachable, skipping row";
    app.log.warn({ hostId: row.hostId, err }, message);
    return null;
  }
}

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
        .all();

      if (rows.length === 0) return;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const repoRef =
          row.hostId === LOCAL_HOST_ID
            ? parseGitRemote(row.cwd)
            : await resolveRemoteRepoRef(app, row);
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
  //
  // Every row (local or remote) gets a staggered timer scheduled up front;
  // a remote row's repoRef can only be resolved inside its timer callback
  // (it needs an agent round-trip), unlike a local row's, which is still
  // resolved synchronously via parseGitRemote() the moment its timer fires.
  const initialTimers: ReturnType<typeof setTimeout>[] = [];
  const rows = app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
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

    const t = setTimeout(async () => {
      try {
        const token = getToken(app);
        if (!token) return;
        const repoRef =
          row.hostId === LOCAL_HOST_ID
            ? parseGitRemote(row.cwd)
            : await resolveRemoteRepoRef(app, row);
        if (!repoRef) return;
        const status = await getRepoPRsStatus(token, repoRef.owner, repoRef.repo);
        setRepoPRsStatus(repoRef.owner, repoRef.repo, status);
      } catch (err) {
        app.log.warn(
          { err, hostId: row.hostId, cwd: row.cwd },
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
