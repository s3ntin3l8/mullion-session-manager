// One paginated walk over a GitHub REST list endpoint, shared by the four
// list reads in github-write.ts.
//
// Four call sites each hand-rolled the same loop with the same shape:
//
//   for (let page = 1; page <= MAX_PAGES; page += 1) {
//     const items = await githubRequest<...>(..., `?per_page=${PAGE_SIZE}&page=${page}`);
//     for (const item of items) { ... }
//     if (items.length < PAGE_SIZE) break;
//   }
//
// and each got the details slightly wrong in its own way — which is what made
// the duplication worth removing rather than just tidying:
//
//   - listIssueComments (github-write.ts) reads `/issues/{n}/comments`, whose
//     response is a BARE ARRAY of comments.
//
//   - listCommitCheckRuns (github-write.ts) reads
//     `/commits/{sha}/check-runs`, whose response is an ENVELOPE —
//     `{ check_runs: [...] }` — so its loop measures the envelope's inner
//     array (`data.check_runs ?? []`), not the response.
//
//   - listReviewMarkers' commit walk (github-write.ts) reads
//     `/pulls/{n}/commits` (also a bare array) but caps at
//     PR_COMMITS_MAX_PAGES = 3 pages rather than 10 — GitHub lists at most
//     250 commits of a PR, so three 100-item pages is the whole list.
//
//   - listPullRequestReviews (github-write.ts) reads `/pulls/{n}/reviews`
//     (a bare array).
//
// The two response shapes are the reason the loops drifted: a bare array IS
// the items, an envelope holds them under a key. `fetchAllPages` takes the
// shape as a parameter so both are one code path, and takes each site's own
// page cap and page size so no call site has to re-derive them.
//
// The stop condition is deliberately "this page held fewer items than the
// page size", NOT "the page was empty": GitHub returns a SHORT final page
// (fewer than `per_page` items) rather than an empty one, and treating a
// short page as the end of the list is what keeps the last page's items.
// Stopping on an empty page instead would fetch one extra request per read
// and, worse, silently drop the final page's items for any endpoint whose
// last page is short — which is all of them.

export interface FetchAllPagesOptions {
  /**
   * The most pages to read. A read that hits the cap stops there, even if
   * the last page was full — GitHub's own list endpoints are bounded
   * (`/pulls/{n}/commits` lists at most 250 commits), so the cap IS the end
   * of the list for those.
   */
  readonly maxPages: number;
  /**
   * The `per_page` size the endpoint was asked for. A page holding fewer
   * than this many items is the LAST page.
   */
  readonly pageSize: number;
}

/**
 * Reads every page of a paginated GitHub REST list endpoint and returns the
 * items in order.
 *
 * `fetchPage` reads ONE page and returns the raw response — a bare array of
 * the items, for the endpoints that answer that way. The walk stops at the
 * first page that held fewer items than `pageSize` (GitHub's short final
 * page) or after `maxPages` pages, whichever comes first.
 */
export async function fetchAllPages<TItem>(
  fetchPage: (page: number) => Promise<readonly TItem[]>,
  options: FetchAllPagesOptions,
): Promise<TItem[]>;

/**
 * Reads every page of a paginated GitHub REST list endpoint whose response
 * is an ENVELOPE — the items under `envelopeKey` (`{ check_runs: [...] }`) —
 * and returns the items in order.
 *
 * A response missing the key entirely contributes no items, which ends the
 * walk exactly as an empty page would.
 */
export async function fetchAllPages<TItem>(
  fetchPage: (
    page: number,
  ) => Promise<{ readonly [envelopeKey: string]: readonly TItem[] | undefined }>,
  options: FetchAllPagesOptions & { readonly envelopeKey: string },
): Promise<TItem[]>;

export async function fetchAllPages<TItem>(
  fetchPage: (page: number) => Promise<unknown>,
  options: FetchAllPagesOptions & { readonly envelopeKey?: string },
): Promise<TItem[]> {
  const { maxPages, pageSize, envelopeKey } = options;
  const out: TItem[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchPage(page);
    const items = envelopeKey
      ? ((response as Record<string, readonly TItem[] | undefined>)[envelopeKey] ?? [])
      : (response as readonly TItem[]);
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
}
