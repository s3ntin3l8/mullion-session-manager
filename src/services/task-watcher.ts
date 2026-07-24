import type { FastifyInstance } from "fastify";
import { projects, tasks } from "../db/schema.js";
import { parseGitRemote } from "./git-remote.js";
import { getToken } from "./github-integration.js";
import { GitHubApiError, listLabeledIssues } from "./github.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

// Stagger initial fetches so N projects don't all hit GitHub at once — same
// shape as github-pr-poller.ts's own STARTUP_STAGGER_MS.
const STARTUP_STAGGER_MS = 2_000;

/**
 * Background poller for Phase 2.5's Thin Slice task watcher (issue #214).
 * Discovers open, `MULLION_TASK_LABEL`-labeled issues on every connected
 * **local-host** project's repo and records them as pending tasks —
 * insert-or-ignore per (projectId, issueNumber), so a repeat poll is a no-op
 * for issues it has already seen (the unique index on `tasks` is the de-dup
 * mechanism, not a last-seen cursor). Remote-hosted projects are skipped:
 * worktree creation + spawn on a remote agent is Phase 6's 6.8 worktree
 * lifecycle proxy, out of scope for the thin slice — see the roadmap's
 * Phase 2.5 design notes.
 *
 * Mirrors github-pr-poller.ts's shape closely (re-entrancy guard, staggered
 * initial sweep, `.unref()`'d timers, per-row errors logged and skipped so
 * one bad repo can't abort the sweep) — deliberately, since this is the same
 * "poll every connected project's GitHub repo on an interval" problem.
 */
export function startTaskWatcher(app: FastifyInstance): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function localProjectRows() {
    return app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all()
      .filter((row) => row.hostId === LOCAL_HOST_ID || !row.hostId);
  }

  async function syncProjectTasks(
    projectId: number,
    cwd: string,
    token: string,
    label: string,
  ): Promise<void> {
    const repoRef = parseGitRemote(cwd);
    if (!repoRef) return;

    try {
      const issues = await listLabeledIssues(token, repoRef.owner, repoRef.repo, label);
      for (const issue of issues) {
        app.db
          .insert(tasks)
          .values({
            projectId,
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body,
            htmlUrl: issue.htmlUrl,
          })
          .onConflictDoNothing({ target: [tasks.projectId, tasks.issueNumber] })
          .run();
      }
    } catch (err) {
      if (err instanceof GitHubApiError) {
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
          "[task-watcher] GitHub API error",
        );
      } else {
        app.log.error(
          { err, owner: repoRef.owner, repo: repoRef.repo },
          "[task-watcher] unexpected error",
        );
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const token = getToken(app);
      if (!token) {
        app.log.debug("[task-watcher] no GitHub token configured, skipping");
        return;
      }
      const label = app.config.MULLION_TASK_LABEL;
      const rows = localProjectRows();
      for (const row of rows) {
        await syncProjectTasks(row.id, row.cwd, token, label);
      }
    } catch (err) {
      app.log.error({ err }, "[task-watcher] poll cycle failed");
    } finally {
      running = false;
    }
  }

  const pollIntervalMs = app.config.MULLION_TASK_POLL_INTERVAL * 1000;
  const rows = localProjectRows();

  if (rows.length === 0) {
    interval = setInterval(pollOnce, pollIntervalMs);
    interval.unref();
    return () => {
      if (interval) clearInterval(interval);
    };
  }

  const initialTimers: ReturnType<typeof setTimeout>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = setTimeout(async () => {
      try {
        const token = getToken(app);
        if (!token) return;
        await syncProjectTasks(row.id, row.cwd, token, app.config.MULLION_TASK_LABEL);
      } catch (err) {
        app.log.warn({ err, projectId: row.id }, "[task-watcher] initial fetch failed");
      }
    }, i * STARTUP_STAGGER_MS);
    t.unref();
    initialTimers.push(t);
  }

  const longestDelay = (rows.length - 1) * STARTUP_STAGGER_MS;
  const margin = Math.max(pollIntervalMs * 2, 10_000);
  sweepTimer = setTimeout(() => {
    pollOnce();
    interval = setInterval(pollOnce, pollIntervalMs);
    interval.unref();
  }, longestDelay + margin);
  sweepTimer.unref();

  return () => {
    for (const t of initialTimers) clearTimeout(t);
    if (sweepTimer) clearTimeout(sweepTimer);
    if (interval) clearInterval(interval);
  };
}
