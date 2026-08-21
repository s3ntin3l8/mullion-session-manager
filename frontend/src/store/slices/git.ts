import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import type { GitBranchesResult, GitHubPRsStatus } from "../../api/index.js";
import type { DashboardState, GitSlice } from "../types.js";

// Dedups overlapping refreshGitStatuses() calls — mirrors git-status.ts's own
// `inFlight` map on the backend. Without this, a tick whose fetches take
// longer than LIVE_REFRESH_INTERVAL_MS (many projects, a slow/unreachable
// remote host) could still be running when the next tick's call starts; the
// later call's `previous` snapshot (captured at ITS OWN start) would then be
// stale relative to whatever the earlier call's `set()` just wrote, and its
// own final `set()` — a wholesale map replacement — could stomp over that
// fresher write with a merge based on the stale snapshot (Hermes review, PR
// #164). Sharing one in-flight promise across overlapping callers, instead
// of each starting its own fetch batch, removes the race entirely rather
// than just narrowing it.
let gitStatusesRefreshInFlight: Promise<void> | null = null;
// Same dedup shape as gitStatusesRefreshInFlight above, for the diff-stats
// batch (issue #202) — a distinct endpoint/cache, so it needs its own guard
// rather than sharing that one.
let gitDiffStatsRefreshInFlight: Promise<void> | null = null;
// Same dedup shape again, for the slower-cadence branches/worktrees + PR
// list refresh (issue #202) — see refreshGitRefs's own doc comment for why
// this runs on a different cadence than the two above.
let gitRefsRefreshInFlight: Promise<void> | null = null;
// Hermes review, PR #680: the in-flight dedup above returns the CURRENTLY
// RUNNING promise for any call that arrives while one is active — fine when
// every call was unscoped (the running one already covers every project),
// but scoping refreshGitRefs to specific project ids means a scoped call
// that lands mid-flight has its own ids silently dropped if they weren't
// part of whatever's already running. Accumulates what arrived during the
// current run so it can be re-fired once that run settles, instead of lost.
// `scoped: false` means at least one queued call was unscoped — that one
// wins over anything scoped queued alongside it, since it already needs
// every project.
let gitRefsRequeue: { scoped: boolean; ids: Set<number> } | null = null;

export const createGitSlice: StateCreator<DashboardState, [], [], GitSlice> = (set, get) => ({
  gitStatuses: {},
  sessionGitStatuses: {},
  gitDiffStats: {},
  gitBranchesByProject: {},
  prsByProject: {},

  // Batch git-status fetch: replaces N parallel per-project requests with
  // a single request to GET /api/projects/git-statuses (which replaces N
  // `git status` shell-outs with one batch that still benefits from the
  // server-side 5s in-memory cache). Projects whose git status was
  // transiently unavailable (the per-project endpoint's 503-equivalent)
  // are omitted from the response, so the frontend preserves its
  // last-known-good for those — only the durable "not a repo" (the per-
  // project endpoint's 204-equivalent, returned as a null entry) clears
  // a previously-known status. If the entire batch request fails
  // (network error, whole-backend outage), all previous entries are kept.
  //
  // Also requests per-session status (issue #202) in the same batch —
  // scoped to visible (non-killed, terminal-kind) sessions, same filter
  // Sidebar.tsx itself applies — and merges it into `sessionGitStatuses`
  // with the identical last-known-good/pruning behavior as `gitStatuses`.
  refreshGitStatuses: () => {
    if (gitStatusesRefreshInFlight) return gitStatusesRefreshInFlight;

    const run = async () => {
      const projectIds = get().projects.map((p) => p.id);
      // Same "still active or exited, never killed" scope as Sidebar.tsx's
      // own session-row filter — deliberately NOT further narrowed by
      // hideEndedSessions, which is a display-only toggle a user can flip
      // back on without this data needing a fresh fetch first.
      const sessionIds = get()
        .sessions.filter((s) => s.kind === "terminal" && s.status !== "killed")
        .map((s) => s.id);
      if (projectIds.length === 0 && sessionIds.length === 0) {
        set({ gitStatuses: {}, sessionGitStatuses: {} });
        return;
      }

      try {
        const result = await api.getProjectGitStatuses(projectIds, sessionIds);
        set({
          gitStatuses: {
            ...Object.fromEntries(projectIds.map((id) => [id, get().gitStatuses[id] ?? null])),
            ...result.projects,
          },
          sessionGitStatuses: {
            ...Object.fromEntries(
              sessionIds.map((id) => [id, get().sessionGitStatuses[id] ?? null]),
            ),
            ...result.sessions,
          },
        });
      } catch (err) {
        console.warn("[GitPanel] refreshGitStatuses batch failed", err);
      }
    };

    gitStatusesRefreshInFlight = run().finally(() => {
      gitStatusesRefreshInFlight = null;
    });
    return gitStatusesRefreshInFlight;
  },

  // Batch diff-stats fetch (issue #202, greenfield) — same shape/dedup/
  // last-known-good pattern as refreshGitStatuses above, but its own
  // separate endpoint/cache and in-flight guard (gitDiffStatsRefreshInFlight).
  refreshGitDiffStats: () => {
    if (gitDiffStatsRefreshInFlight) return gitDiffStatsRefreshInFlight;

    const run = async () => {
      const sessionIds = get()
        .sessions.filter((s) => s.kind === "terminal" && s.status !== "killed")
        .map((s) => s.id);
      if (sessionIds.length === 0) {
        set({ gitDiffStats: {} });
        return;
      }

      try {
        const stats = await api.getSessionGitDiffStats(sessionIds);
        set({
          gitDiffStats: {
            ...Object.fromEntries(sessionIds.map((id) => [id, get().gitDiffStats[id] ?? null])),
            ...stats,
          },
        });
      } catch (err) {
        console.warn("[GitPanel] refreshGitDiffStats batch failed", err);
      }
    };

    gitDiffStatsRefreshInFlight = run().finally(() => {
      gitDiffStatsRefreshInFlight = null;
    });
    return gitDiffStatsRefreshInFlight;
  },

  // Branches + worktrees + open-PR list per project (issue #202) — unlike
  // the two batch endpoints above, there's no single batched route for
  // this (git-branches and github/prs are both per-project, existing
  // routes — see the plan's "no new schema/endpoint needed here" note), so
  // this fires one pair of requests per project, in parallel across
  // projects. Deliberately run on a slower cadence than the 4s git-status
  // tick (called from refreshProjects, plus a throttled call from
  // SessionsSlice's startLiveRefresh) — branch/worktree lists change rarely
  // (git-refs.ts's own on-demand-fetch reasoning) and the PR list already
  // rides its own 60s-ish server-side cache/poller, so refetching it every
  // 4s would just be wasted round trips for data that hasn't moved.
  //
  // `projectIds` (optional): scopes the refetch to just these projects
  // instead of every project, merging the result into the existing maps
  // rather than replacing them wholesale. github.ts's WS-event debounce
  // uses this — a project's own webhook activity only needs to refresh
  // THAT project's branches/PRs, not every other project's too. Before this
  // scoping existed, a single project's CI check-suite burst (each event
  // debounced 250ms, but a busy suite fires far more often than that)
  // refetched all N projects' git-branches + github/prs on every debounce
  // tick, which — production incident — blew through git-branches' 30/min
  // rate limit within seconds and left an unrelated dialog's own branches
  // fetch caught in the resulting 429 storm. Omitted (the `refreshProjects`
  // caller, and a fresh/deleted project) still does the full unscoped
  // fetch + replace, since that path also needs to prune projects that no
  // longer exist.
  refreshGitRefs: (projectIds) => {
    if (gitRefsRefreshInFlight) {
      // Queue this call's scope rather than dropping it — see
      // gitRefsRequeue's own doc comment above.
      if (projectIds === undefined) {
        gitRefsRequeue = { scoped: false, ids: new Set() };
      } else if (gitRefsRequeue?.scoped !== false) {
        const ids = gitRefsRequeue?.ids ?? new Set<number>();
        for (const id of projectIds) ids.add(id);
        gitRefsRequeue = { scoped: true, ids };
      }
      // Deliberately the CURRENTLY RUNNING promise, not one that resolves
      // once this call's own ids are actually fetched — same eventual-
      // consistency character the unscoped dedup already had. Every call
      // site here is fire-and-forget (`void get().refreshGitRefs(...)`),
      // so nothing depends on this awaiting its own scope.
      return gitRefsRefreshInFlight;
    }

    const run = async (scopeIds: number[] | undefined) => {
      const allProjects = get().projects;
      if (allProjects.length === 0) {
        set({ gitBranchesByProject: {}, prsByProject: {} });
        return;
      }
      const scoped = scopeIds !== undefined;
      const projectList = scoped ? allProjects.filter((p) => scopeIds.includes(p.id)) : allProjects;
      if (projectList.length === 0) return;

      const results = await Promise.allSettled(
        projectList.map(async (p) => {
          const [branches, prs] = await Promise.all([
            api.getProjectGitBranches(p.id).catch(() => undefined),
            api.getProjectGitHubPRs(p.id).catch(() => undefined),
          ]);
          return { id: p.id, branches, prs };
        }),
      );

      const gitBranchesByProject: Record<number, GitBranchesResult | undefined> = scoped
        ? { ...get().gitBranchesByProject }
        : {};
      const prsByProject: Record<number, GitHubPRsStatus | undefined> = scoped
        ? { ...get().prsByProject }
        : {};
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        gitBranchesByProject[result.value.id] = result.value.branches;
        prsByProject[result.value.id] = result.value.prs;
      }
      set({ gitBranchesByProject, prsByProject });
    };

    gitRefsRefreshInFlight = run(projectIds).finally(() => {
      gitRefsRefreshInFlight = null;
      if (gitRefsRequeue) {
        const queued = gitRefsRequeue;
        gitRefsRequeue = null;
        void get().refreshGitRefs(queued.scoped ? Array.from(queued.ids) : undefined);
      }
    });
    return gitRefsRefreshInFlight;
  },

  // Manual git fetch for a project — runs `git fetch origin` now.
  fetchProjectGit: async (projectId: number) => {
    await api.postProjectGitFetch(projectId);
  },

  // Issue #745 — Manual fast-forward git pull for a project.
  pullProjectGit: async (projectId: number) => {
    return await api.postProjectGitPull(projectId);
  },

  // Toggle auto-fetch for a project (null = inherit from global setting).
  toggleAutoFetch: async (projectId: number, value: boolean | null) => {
    await api.updateProject(projectId, { autoFetch: value });
    await get().refreshProjects();
  },
});
