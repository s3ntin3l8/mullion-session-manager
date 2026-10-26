import { api } from "../api/index.js";
import type {
  GitHubIssueLabel,
  GitHubIssueSort,
  GitHubIssuesResponse,
  GitHubJob,
  GitHubPRsStatus,
  GitHubPrDetail,
  GitHubStatus,
  GitHubIssueDetail,
  RelayReviewState,
} from "../api/types.js";

// The GitHub client cache's keys and fetchers, shared by the store slice
// (prefetch) and the hooks (hooks/useGitHubData.ts) so both sides of a
// prefetch -> first paint hand-off agree on the exact key. Every key starts
// with `${projectId}:` — invalidating a project is a prefix match.

/** The Issues view's persisted filter + paging + chip state, per project. */
export interface GithubIssueUi {
  labels: string[];
  unassigned: boolean;
  sort: GitHubIssueSort;
  /** The raw search box text; the debounced copy is the component's. */
  query: string;
  /** Paging resets when the filter key changes (derived, not stored). */
  pageState: { key: string; page: number };
  /** Labels seen across every fetched page, so a selected chip never vanishes. */
  knownLabels: GitHubIssueLabel[];
  /** From the list response, so the detail view needn't fetch a page for it. */
  taskMaster: { enabled: boolean; label: string } | null;
}

export const DEFAULT_ISSUE_UI: GithubIssueUi = {
  labels: [],
  unassigned: false,
  sort: "updated",
  query: "",
  pageState: { key: "", page: 1 },
  knownLabels: [],
  taskMaster: null,
};

export const statusKey = (projectId: number) => `${projectId}:status`;
export const prsKey = (projectId: number) => `${projectId}:prs`;
export const prDetailKey = (projectId: number, n: number) => `${projectId}:pr:${n}`;
export const prReviewKey = (projectId: number, n: number) => `${projectId}:prReview:${n}`;
export const runJobsKey = (projectId: number, runId: number) => `${projectId}:jobs:${runId}`;
export const issueKey = (projectId: number, n: number) => `${projectId}:issue:${n}`;
export const issuesKey = (projectId: number, filterKey: string, page: number) =>
  `${projectId}:issues:${filterKey}:${page}`;

export function issueFilterKey(
  ui: Pick<GithubIssueUi, "labels" | "unassigned" | "sort">,
  debouncedQuery: string,
): string {
  return JSON.stringify([ui.labels, ui.unassigned, ui.sort, debouncedQuery]);
}

// A 204 ("not applicable") is `undefined` on the wire; normalised to null so
// "still loading" (no cache entry) and "nothing there" stay distinguishable.
export const fetchStatus = (projectId: number): Promise<GitHubStatus | null> =>
  api.getProjectGitHub(projectId).then((s) => s ?? null);
export const fetchPrs = (projectId: number): Promise<GitHubPRsStatus | null> =>
  api.getProjectGitHubPRs(projectId).then((s) => s ?? null);
export const fetchPrDetail = (projectId: number, n: number): Promise<GitHubPrDetail> =>
  api.getProjectPr(projectId, n);
// A failed relay lookup is not the PR's failure — it just renders no block.
export const fetchPrReview = (projectId: number, n: number): Promise<RelayReviewState | null> =>
  api.getProjectPrReview(projectId, n).catch(() => null);
export const fetchRunJobs = (projectId: number, runId: number): Promise<GitHubJob[]> =>
  api.getGitHubRunJobs(projectId, runId);
export const fetchIssue = (projectId: number, n: number): Promise<GitHubIssueDetail> =>
  api.getProjectIssue(projectId, n);
export const fetchIssuesPage = (
  projectId: number,
  ui: Pick<GithubIssueUi, "labels" | "unassigned" | "sort">,
  debouncedQuery: string,
  page: number,
): Promise<GitHubIssuesResponse> =>
  api.getProjectIssues(projectId, {
    labels: ui.labels,
    assignee: ui.unassigned ? "none" : undefined,
    sort: ui.sort,
    q: debouncedQuery || undefined,
    page,
  });
