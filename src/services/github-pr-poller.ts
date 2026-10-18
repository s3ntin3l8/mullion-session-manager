import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { parseGitRemote, type GitHubRepoRef } from "./git-remote.js";
import { resolveGitHubToken } from "./github-integration.js";
import {
  GitHubApiError,
  getPullRequestMergeState,
  getRepoPRsStatus,
  refreshDefaultBranchCi,
  setRepoPRsStatus,
} from "./github.js";
import { ActivityTracker } from "./github-activity-tracker.js";
import { enrichPrsWithReviewState } from "./github-pr-reviews.js";
import { diffPrSnapshots, snapshotPr, type PrChange, type PrSnapshot } from "./github-pr-phase.js";
import { derivePrEvents } from "./pr-session-events.js";
import { broadcastToProject } from "./github-ws-broadcast.js";
import { resolveGitHubPoll, toActivityIntervals } from "./runtime-config.js";
import { getStoredSettings } from "./settings.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient, HostRequestError } from "./remote-host-client.js";

const execFileAsync = promisify(execFile);

async function checkoutBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
      timeout: 3_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

interface PrMeta {
  number: number;
  headBranch: string;
  title: string;
  htmlUrl: string;
}

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
  // Env defaults, overridable from Settings → Integrations (see
  // runtime-config.ts). A later settings change retunes the tracker in place
  // via ActivityTracker.setIntervals (settings.ts's applySettingsPatch).
  const intervals = toActivityIntervals(resolveGitHubPoll(getStoredSettings(app.db), app));
  const quietIntervalMs = intervals.quietIntervalMs;

  const activityTracker = tracker ?? new ActivityTracker(intervals);
  app.githubActivityTracker = activityTracker;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let cleanupCalled = false;
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];

  // Last poll's per-PR snapshot for each repo, so a poll that changed
  // something (a review landed, CI flipped) can push the browser instead of
  // waiting for its next refetch. Process-local; the first poll of a repo has
  // no baseline and so never pushes.
  const lastSnapshots = new Map<string, Map<number, PrSnapshot>>();
  // The branch/title/url of each open PR at the last poll: a PR that vanished
  // from the open list has no live row left to read them from.
  const lastPrMeta = new Map<string, Map<number, PrMeta>>();

  async function resolveAllRepos(): Promise<
    { repoRef: GitHubRepoRef | null; projectId: number }[]
  > {
    const rows = app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all();
    return Promise.all(
      rows.map(async (row) => ({
        projectId: row.id,
        repoRef:
          row.hostId === LOCAL_HOST_ID
            ? parseGitRemote(row.cwd)
            : await resolveRemoteRepoRef(app, row),
      })),
    );
  }

  // One repo's refresh: open PRs + their CI, then the default branch's CI for
  // the right-sidebar badge. fetchActionsRuns (behind it) never throws —
  // Actions being off or a lookup failing degrades to "no signal" — so it
  // can't fail the PR half.
  async function refreshRepo(
    token: string,
    owner: string,
    repo: string,
    repoKey: string,
    // null = the initial per-project sweep: it may cover only one of several
    // projects sharing this repo, so it may seed a baseline but never push.
    projectIds: number[] | null,
  ): Promise<void> {
    const status = await getRepoPRsStatus(token, owner, repo);
    // Review state (GraphQL) is best-effort and never throws.
    await enrichPrsWithReviewState(token, owner, repo, status.prs, app.log);
    setRepoPRsStatus(owner, repo, status);
    const changes = pushPrChanges(repoKey, status.prs, projectIds);
    if (changes.length > 0 && projectIds) {
      // Notifications are a side channel: they must never cost the poll its
      // activity bookkeeping or the default-branch refresh below.
      // Not awaited either: merge lookups and git probes are I/O the poll
      // shouldn't wait on.
      emitSessionEvents(token, owner, repo, repoKey, projectIds, changes).catch((err) => {
        app.log.warn({ err, owner, repo }, "[github-pr-poller] session event emit failed");
      });
    }
    activityTracker.recordPollResult(repoKey, repoHasActivity(status));
    await refreshDefaultBranchCi(token, owner, repo);
  }

  // Previous metadata is returned alongside the changes' own so a vanished
  // PR can still be resolved to a branch; the maps are replaced every poll.
  function pushPrChanges(
    repoKey: string,
    prs: (Parameters<typeof snapshotPr>[0] & PrMeta)[],
    projectIds: number[] | null,
  ): PrChange[] {
    const next = prs.map(snapshotPr);
    const prev = lastSnapshots.get(repoKey);
    if (projectIds === null) {
      if (!prev) {
        lastSnapshots.set(repoKey, new Map(next.map((p) => [p.number, p])));
        lastPrMeta.set(repoKey, metaOf(prs));
      }
      return [];
    }
    lastSnapshots.set(repoKey, new Map(next.map((p) => [p.number, p])));
    const prevMeta = lastPrMeta.get(repoKey) ?? new Map<number, PrMeta>();
    const nextMeta = metaOf(prs);
    lastPrMeta.set(repoKey, new Map([...prevMeta, ...nextMeta]));
    if (!prev) return [];
    const changes = diffPrSnapshots(prev, next);
    if (changes.length === 0) return [];
    for (const projectId of projectIds) {
      const pid = String(projectId);
      broadcastToProject(pid, {
        type: "pr",
        action: "sync",
        projectId: pid,
        pr: { changed: changes.map((c) => c.number) },
      });
    }
    return changes;
  }

  function metaOf(prs: PrMeta[]): Map<number, PrMeta> {
    return new Map(
      prs.map((p) => [
        p.number,
        { number: p.number, headBranch: p.headBranch, title: p.title, htmlUrl: p.htmlUrl },
      ]),
    );
  }

  // PR transitions -> the owning session's event stream (bell/timeline,
  // events.subscribe). A session owns a PR when it is on its head branch or
  // is the Task Master task session for it. Best effort: a failed merge
  // lookup or a missing session just means no event.
  async function emitSessionEvents(
    token: string,
    owner: string,
    repo: string,
    repoKey: string,
    projectIds: number[],
    changes: PrChange[],
  ): Promise<void> {
    const metas = lastPrMeta.get(repoKey);
    // Per-PR work is independent (a closed PR costs a merge lookup), so run it
    // side by side; the caller doesn't await this at all.
    await Promise.all(
      changes.map(async (change) => {
        const meta = metas?.get(change.number);
        let merged = false;
        let title = meta?.title ?? "";
        let url = meta?.htmlUrl ?? "";
        if (change.kind === "closed") {
          const state = await getPullRequestMergeState(token, owner, repo, change.number);
          if (!state?.merged) return;
          merged = true;
          title = state.title || title;
          url = state.htmlUrl || url;
        }
        const events = derivePrEvents(change, { number: change.number, title, url }, merged);
        if (events.length === 0) return;
        for (const projectId of projectIds) {
          for (const id of await sessionsForPr(projectId, change.number, meta?.headBranch)) {
            const session = app.pty.get(id);
            for (const ev of events) session?.emitPrEvent(ev.kind, ev.payload);
          }
        }
      }),
    );
    // Closed PRs have had their one look at the carried-over metadata.
    for (const change of changes) if (change.kind === "closed") metas?.delete(change.number);
  }

  // The session row matches on its displayBranch, which prefers polled git
  // status over the hook-reported branch; a session that never sent a
  // git_branch hook is resolved here from its own checkout instead.
  async function sessionsForPr(
    projectId: number,
    number: number,
    headBranch?: string,
  ): Promise<string[]> {
    const ids = new Set<string>();
    if (headBranch) {
      for (const id of app.pty.sessionIdsOnBranch(projectId, headBranch)) ids.add(id);
      const unknown = app.pty.sessionsWithoutBranch(projectId);
      const resolved = await Promise.all(
        unknown.map(async (s) => ((await checkoutBranch(s.cwd)) === headBranch ? s.id : null)),
      );
      for (const id of resolved) if (id) ids.add(id);
    }
    const rows = app.db
      .select({ sessionId: tasks.sessionId })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.prNumber, number)))
      .all();
    for (const r of rows) if (r.sessionId !== null) ids.add(String(r.sessionId));
    return [...ids];
  }

  function projectIdsFor(
    repoRows: { repoRef: GitHubRepoRef | null; projectId: number }[],
    owner: string,
    repo: string,
  ): number[] {
    return repoRows
      .filter((r) => r.repoRef?.owner === owner && r.repoRef?.repo === repo)
      .map((r) => r.projectId);
  }

  async function pollOnce(
    repoRows: { repoRef: GitHubRepoRef | null; projectId: number }[],
  ): Promise<void> {
    if (running) return;
    running = true;
    try {
      // One refresh per repo per tick: several projects can share a repo, and
      // projectIdsFor() already fans the push out to all of them.
      const polled = new Set<string>();
      for (const row of repoRows) {
        if (!row.repoRef) continue;
        const { owner, repo } = row.repoRef;
        const repoKey = `${owner}/${repo}`;
        if (polled.has(repoKey)) continue;
        polled.add(repoKey);

        // #489 remaining scope — resolved per-repo, "read" scope (an App
        // installation token is scoped to a single repo, so there's no
        // longer one token to resolve for the whole poll). Falls back to
        // the shared PAT/OAuth token when no App covers this repo or none
        // is configured.
        const token = await resolveGitHubToken(app, row.repoRef, "read");
        if (!token) {
          app.log.debug({ owner, repo }, "[github-pr-poller] no GitHub token available, skipping");
          continue;
        }

        try {
          await refreshRepo(token, owner, repo, repoKey, projectIdsFor(repoRows, owner, repo));
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

    const nextInterval = computeNextInterval(
      activityTracker,
      repoRows,
      activityTracker.quietInterval,
    );
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
          const repoRef =
            row.hostId === LOCAL_HOST_ID
              ? parseGitRemote(row.cwd)
              : await resolveRemoteRepoRef(app, row);
          if (!repoRef) return;
          // #489 remaining scope — see pollOnce's own comment above.
          const token = await resolveGitHubToken(app, repoRef, "read");
          if (!token) return;
          const repoKey = `${repoRef.owner}/${repoRef.repo}`;
          await refreshRepo(token, repoRef.owner, repoRef.repo, repoKey, null);
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
    app.githubActivityTracker = undefined;
  };
}
