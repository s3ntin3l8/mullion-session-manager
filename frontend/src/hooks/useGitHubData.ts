import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitHubIssueDetail,
  GitHubIssuesResponse,
  GitHubJob,
  GitHubPRsStatus,
  GitHubPrDetail,
  GitHubStatus,
  RelayReviewState,
} from "../api/types.js";
import { useDashboardStore } from "../store/index.js";
import {
  DEFAULT_ISSUE_UI,
  fetchIssue,
  fetchIssuesPage,
  fetchPrDetail,
  fetchPrReview,
  fetchPrs,
  fetchRunJobs,
  fetchStatus,
  issueFilterKey,
  issueKey,
  issuesKey,
  prDetailKey,
  prReviewKey,
  prsKey,
  runJobsKey,
  statusKey,
  type GithubIssueUi,
} from "../store/githubResources.js";

// The GitHub views' client data layer (issue #1970): every read goes through
// the store's keyed stale-while-revalidate cache, so a view that mounts with
// cached data paints it immediately and revalidates behind it, and a hover
// prefetch and the view's own mount fetch share one request.

export interface GithubResource<T> {
  /** The cached value; `undefined` until the first response (or failure). */
  data: T | undefined;
  /** The last fetch's error, if it failed (data may still hold older results). */
  error: string | null;
  /** No data and no error yet. */
  loading: boolean;
  /** Force a refetch (bypassing freshness). */
  refresh: () => Promise<void>;
}

function useGithubResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { enabled = true, trigger = 0 }: { enabled?: boolean; trigger?: number } = {},
): GithubResource<T> {
  const entry = useDashboardStore((s) => (key ? s.githubCache[key] : undefined));
  const githubFetch = useDashboardStore((s) => s.githubFetch);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!key || !enabled) return;
    githubFetch(key, () => fetcherRef.current()).catch(() => undefined);
  }, [key, enabled, trigger, githubFetch]);

  const refresh = useCallback(async () => {
    if (!key) return;
    await githubFetch(key, () => fetcherRef.current(), true).catch(() => undefined);
  }, [key, githubFetch]);

  const data = entry?.data as T | undefined;
  const error = entry?.error ?? null;
  return { data, error, loading: data === undefined && error === null, refresh };
}

const useProjectTrigger = (projectId: number) =>
  useDashboardStore((s) => s.prsRefreshTriggerByProject[projectId] ?? 0);

/** `undefined` while loading, `null` when unavailable (204 or a failed fetch). */
export function useGitHubStatus(projectId: number): GitHubStatus | null | undefined {
  const r = useGithubResource(statusKey(projectId), () => fetchStatus(projectId), {
    trigger: useProjectTrigger(projectId),
  });
  return r.data !== undefined ? r.data : r.error ? null : undefined;
}

/**
 * The PR list: the store's live `prsByProject` (kept fresh by the WS) wins
 * over the cached fetch, so a panel opened with PRs in the store never waits.
 */
export function usePrList(projectId: number): GitHubPRsStatus | null | undefined {
  const storePrs = useDashboardStore((s) => s.prsByProject[projectId]);
  // The store's list wins below, so don't spend a request on one we'd discard.
  const r = useGithubResource(prsKey(projectId), () => fetchPrs(projectId), {
    enabled: !storePrs,
    trigger: useProjectTrigger(projectId),
  });
  if (storePrs) return storePrs;
  return r.data !== undefined ? r.data : r.error ? null : undefined;
}

export function usePrDetail(projectId: number, number: number) {
  const trigger = useProjectTrigger(projectId);
  const pr = useGithubResource<GitHubPrDetail>(
    prDetailKey(projectId, number),
    () => fetchPrDetail(projectId, number),
    { trigger },
  );
  const review = useGithubResource<RelayReviewState | null>(
    prReviewKey(projectId, number),
    () => fetchPrReview(projectId, number),
    { trigger },
  );
  const { refresh: refreshPr } = pr;
  const { refresh: refreshReview } = review;
  const refresh = useCallback(async () => {
    await Promise.all([refreshPr(), refreshReview()]);
  }, [refreshPr, refreshReview]);
  return { pr: pr.data, error: pr.error, review: review.data ?? null, refresh };
}

/** CI jobs per run id; `null` = that run's fetch failed, `undefined` = not loaded. */
export function useRunJobs(
  projectId: number,
  runIds: number[],
  enabled: boolean,
): Record<number, GitHubJob[] | null | undefined> {
  const cache = useDashboardStore((s) => s.githubCache);
  const githubFetch = useDashboardStore((s) => s.githubFetch);
  const trigger = useProjectTrigger(projectId);
  const idsKey = runIds.join(",");
  useEffect(() => {
    if (!enabled) return;
    for (const id of idsKey ? idsKey.split(",").map(Number) : []) {
      githubFetch(runJobsKey(projectId, id), () => fetchRunJobs(projectId, id)).catch(
        () => undefined,
      );
    }
  }, [projectId, idsKey, enabled, trigger, githubFetch]);
  return useMemo(() => {
    const out: Record<number, GitHubJob[] | null | undefined> = {};
    for (const id of runIds) {
      const e = cache[runJobsKey(projectId, id)];
      out[id] = e?.data !== undefined ? (e.data as GitHubJob[]) : e?.error ? null : undefined;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey covers runIds
  }, [cache, projectId, idsKey]);
}

export function useIssue(projectId: number, number: number): GithubResource<GitHubIssueDetail> {
  return useGithubResource(issueKey(projectId, number), () => fetchIssue(projectId, number), {
    trigger: useProjectTrigger(projectId),
  });
}

export interface IssuesResult {
  ui: GithubIssueUi;
  filterKey: string;
  page: number;
  /** Pages 1..page merged; the previous filter's results while a new one loads. */
  data: GitHubIssuesResponse | null;
  error: string | null;
  loading: boolean;
}

/**
 * The issues list for the persisted filters. Each page is its own cache
 * entry (so a prefetched page 1 is reused), merged here; paging and filters
 * live in the store, so drilling into an issue and back keeps them.
 */
export function useIssues(
  projectId: number,
  debouncedQuery: string,
  enabled: boolean,
): IssuesResult {
  const ui = useDashboardStore((s) => s.githubIssueUiByProject[projectId]) ?? DEFAULT_ISSUE_UI;
  const cache = useDashboardStore((s) => s.githubCache);
  const githubFetch = useDashboardStore((s) => s.githubFetch);
  const trigger = useProjectTrigger(projectId);
  const filterKey = issueFilterKey(ui, debouncedQuery);
  const page = ui.pageState.key === filterKey ? ui.pageState.page : 1;
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  });

  useEffect(() => {
    if (!enabled) return;
    for (let p = 1; p <= page; p++) {
      githubFetch(issuesKey(projectId, filterKey, p), () =>
        fetchIssuesPage(projectId, uiRef.current, debouncedQuery, p),
      ).catch(() => undefined);
    }
  }, [projectId, filterKey, page, enabled, trigger, debouncedQuery, githubFetch]);

  const merged = useMemo(() => {
    const pages: GitHubIssuesResponse[] = [];
    let error: string | null = null;
    for (let p = 1; p <= page; p++) {
      const e = cache[issuesKey(projectId, filterKey, p)];
      if (e?.data) pages.push(e.data as GitHubIssuesResponse);
      else {
        error = e?.error ?? null;
        break;
      }
    }
    const loaded = pages.length === page;
    const data: GitHubIssuesResponse | null = pages.length
      ? {
          ...pages[pages.length - 1],
          issues: pages.flatMap((r) => r.issues),
          labels: pages[0].labels,
        }
      : null;
    return { data, error, loaded };
  }, [cache, projectId, filterKey, page]);

  // Keep the previous filter's results on screen while the new ones load
  // (same as before the cache): only replace once there is something to show.
  const [lastData, setLastData] = useState<GitHubIssuesResponse | null>(null);
  if (merged.data && merged.data !== lastData) setLastData(merged.data);
  return {
    ui,
    filterKey,
    page,
    data: merged.data ?? lastData,
    error: merged.error,
    loading: enabled && !merged.error && !merged.loaded,
  };
}
