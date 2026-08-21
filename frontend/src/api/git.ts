// Plain git (not GitHub) status/branches/worktrees/diffs, per-project and
// per-session. Split out of the former flat frontend/src/api.ts (PR 22 of
// the refactoring roadmap).
import { request } from "./client.js";
import type {
  GitBranchesResult,
  DeleteBranchResult,
  RemoveWorktreeResult,
  GitStatusesBatchResult,
  GitFileDiffResponse,
  GitPullResult,
} from "./types.js";
import type { GitStatus, GitDiffStats } from "../../../src/shared/types.js";

export const gitApi = {
  // undefined for the 204 "not applicable" response (see src/shared/types.ts's
  // GitStatus). `opts.fresh` (issue #433, Hermes review on PR #506) bypasses the
  // backend's ~5s git-status cache — pass it only for an explicit user
  // "Fetch" action (SourceControlSection, GitPanel), never the 4s
  // live-refresh poll, which should keep benefiting from that cache.
  getProjectGitStatus: (projectId: number, opts: { fresh?: boolean } = {}) =>
    request<GitStatus | undefined>(
      `/api/projects/${projectId}/git-status${opts.fresh ? "?fresh=1" : ""}`,
    ),

  // Batch git-status for the sidebar's live-refresh loop: replaces N
  // parallel per-project requests with a single request. Returns
  // `{ projects, sessions }` (see ./types.ts's GitStatusesBatchResult); entries
  // whose git status was transiently unavailable (503-equivalent on the
  // per-project endpoint) are simply omitted from their map, letting the
  // caller keep last-known-good for those. Null means "durably not a git
  // repo" (the per-project endpoint's 204 case). `sessionIds` (issue #202)
  // additionally requests per-session (worktree-aware) status.
  getProjectGitStatuses: (ids: number[], sessionIds: number[] = []) => {
    // Built manually (not URLSearchParams) so ids stay comma-joined as
    // plain "1,2,3" — URLSearchParams percent-encodes the comma, which the
    // backend's own parseIdListParam splits on either way, but keeping the
    // querystring shape identical to the rest of the api/ tree's `ids=`
    // params (this method's own sibling batch calls, ./projects.ts's
    // discoverProjects, etc.) avoids a one-off encoding just for this route.
    const parts: string[] = [];
    if (ids.length > 0) parts.push(`ids=${ids.join(",")}`);
    if (sessionIds.length > 0) parts.push(`sessionIds=${sessionIds.join(",")}`);
    return request<GitStatusesBatchResult>(
      `/api/projects/git-statuses${parts.length > 0 ? `?${parts.join("&")}` : ""}`,
    );
  },

  // undefined for the 204 "not applicable" response (see ./types.ts's
  // GitBranchesResult). `detail` (issue #442) requests the opt-in isMerged enrichment —
  // defaults to off so store.ts's refreshGitRefs call site (the 60s
  // background poll) stays literally unchanged and keeps paying for
  // exactly the one for-each-ref spawn it always has.
  getProjectGitBranches: (projectId: number, detail?: boolean) =>
    request<GitBranchesResult | undefined>(
      `/api/projects/${projectId}/git-branches${detail ? "?detail=1" : ""}`,
    ),

  // Manual git fetch trigger — runs `git fetch origin` for this project now.
  postProjectGitFetch: (projectId: number) =>
    request<{ success: boolean; error?: string }>(`/api/projects/${projectId}/git-fetch`, {
      method: "POST",
    }),

  // Issue #745 — Manual fast-forward git pull trigger (`git merge --ff-only @{u}`).
  postProjectGitPull: (projectId: number) =>
    request<GitPullResult>(`/api/projects/${projectId}/git-pull`, {
      method: "POST",
    }),

  // Issue #442 — GitPanel manual branch deletion. `deleted: false` with a
  // `reason` is a normal 200 response (a git-level refusal), not a thrown
  // ApiError — only a genuine HTTP error (4xx/5xx) throws.
  deleteProjectGitBranch: (projectId: number, name: string, force?: boolean) =>
    request<DeleteBranchResult>(`/api/projects/${projectId}/git-branch-delete`, {
      method: "POST",
      body: JSON.stringify({ name, force }),
    }),

  // Issue #442 — GitPanel manual worktree removal. Same "refusal is a 200,
  // not a throw" shape as deleteProjectGitBranch above.
  removeProjectGitWorktree: (projectId: number, worktreePath: string, force?: boolean) =>
    request<RemoveWorktreeResult>(`/api/projects/${projectId}/git-worktree-remove`, {
      method: "POST",
      body: JSON.stringify({ worktreePath, force }),
    }),

  // Issue #442 — GitPanel "Prune stale" button (`git worktree prune` only —
  // never removes a worktree that still exists on disk).
  pruneProjectGitWorktrees: (projectId: number) =>
    request<{ pruned: boolean }>(`/api/projects/${projectId}/git-worktree-prune`, {
      method: "POST",
    }),

  // Batch diff stats (issue #202, greenfield) — same batching motivation and
  // shape as getProjectGitStatuses's sessionIds above, but session-only
  // (diff stats are inherently per-cwd, and every session has an effective
  // cwd whether or not it's a distinct worktree). A missing entry means
  // "transiently unavailable"; `null` means "not a repo, or nothing to diff
  // yet" (unborn HEAD).
  getSessionGitDiffStats: (sessionIds: number[]): Promise<Record<string, GitDiffStats | null>> => {
    if (sessionIds.length === 0) return Promise.resolve({});
    return request<Record<string, GitDiffStats | null>>(
      `/api/projects/git-diff-stats?sessionIds=${sessionIds.join(",")}&base=AUTO`,
    );
  },

  // Per-file unified diff (issue #262, follow-up to #177) — fetches the raw
  // patch for a single file in the session's working tree. Called on-demand
  // when the user clicks a file-change chip in the sidebar.
  getSessionGitFileDiff: (sessionId: number, path: string): Promise<GitFileDiffResponse> =>
    request<GitFileDiffResponse>(
      `/api/projects/git-file-diff?sessionId=${sessionId}&path=${encodeURIComponent(path)}&base=AUTO`,
    ),

  // Same endpoint, keyed by project instead of session (issue #433's Source
  // Control sidebar section, which has no session to anchor to).
  getProjectGitFileDiff: (projectId: number, path: string): Promise<GitFileDiffResponse> =>
    request<GitFileDiffResponse>(
      `/api/projects/git-file-diff?projectId=${projectId}&path=${encodeURIComponent(path)}&base=AUTO`,
    ),
};
