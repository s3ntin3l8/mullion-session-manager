// Read-side issue browsing for the right sidebar's Issues view: a filterable
// list and a single-issue detail (body + comments). Distinct from
// github.ts's getRepoStatus, which only needs a count and a short glance
// list — this one pages, filters and carries enough per item to choose what
// to work on next without opening github.com.
//
// Uses the "issues"-scope token (an App token without Issues access gets
// only PRs back from `/issues`, see github-app.ts's ISSUES_READ_PERMISSIONS).
// Bodies come back as GitHub-rendered HTML (`body_html`), so no markdown
// library is needed here; the frontend sanitizes before inserting it.

import { githubApiFetch, GitHubApiError } from "./github-fetch.js";
import { parseParentIssueUrl } from "./github.js";

const PAGE_SIZE = 50;
/** Most raw list pages a title search reads (1000 issues) before giving up and flagging `truncated`. */
const MAX_SEARCH_PAGES = 20;
const HTML_ACCEPT = "application/vnd.github.html+json";

export interface IssueLabel {
  name: string;
  /** Hex colour without the leading `#`, as GitHub returns it. */
  color: string;
}

export interface IssueListItem {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  labels: IssueLabel[];
  assignees: string[];
  commentCount: number;
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueListResult {
  issues: IssueListItem[];
  page: number;
  hasMore: boolean;
  /** A title search stopped at its scan cap, so older matches may exist beyond the results. */
  truncated?: boolean;
  /** Every label seen on the returned page, for the filter chips. */
  labels: IssueLabel[];
  /** How many open issues match, when the query asked for a full scan
   *  (`countMatches`). A lower bound when `truncated` is set. */
  total?: number;
}

export interface IssueComment {
  id: number;
  author: string | null;
  bodyHtml: string;
  createdAt: string;
  htmlUrl: string;
}

/** A sub-issue or parent, as the detail view's relationship card lists it. */
export interface IssueRef {
  number: number;
  title: string;
  state: "open" | "closed";
  /** `owner/repo`, set only when the issue lives in another repository than the one on screen. */
  repo?: string;
}

export interface IssueDetail extends IssueListItem {
  state: "open" | "closed";
  bodyHtml: string;
  comments: IssueComment[];
  /** Direct children (first 100); empty when the issue has none. */
  subIssues: IssueRef[];
  /** GitHub's cumulative `sub_issues_summary` (total children, completed ones). */
  subIssuesSummary: { total: number; completed: number } | null;
  /** The parent issue when this one is a sub-issue. */
  parent: IssueRef | null;
}

export type IssueSort = "updated" | "created" | "comments";

export interface IssueListQuery {
  /** Comma-separated labels; GitHub ANDs them. */
  labels?: string;
  /** A login, `*` (any assignee) or `none`. */
  assignee?: string;
  sort?: IssueSort;
  /** Case-insensitive substring match on the title, searched across the repo's open issues. */
  q?: string;
  page?: number;
  /** A filter GitHub can't apply (the Task Master origin, #2461): issues it
   *  rejects are skipped, scanning later pages for the requested page. */
  match?: (issue: IssueListItem) => boolean;
  /** Scan every page (up to the cap) so `total` counts all matches. */
  countMatches?: boolean;
}

interface RawLabel {
  name?: string;
  color?: string;
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<RawLabel | string>;
  assignees?: Array<{ login: string }> | null;
  comments?: number;
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  state?: string;
  body_html?: string | null;
  pull_request?: unknown;
  repository_url?: string | null;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total?: number; completed?: number } | null;
}

interface RawComment {
  id: number;
  user?: { login: string } | null;
  body_html?: string | null;
  created_at: string;
  html_url: string;
}

function toLabels(raw: RawIssue["labels"]): IssueLabel[] {
  const out: IssueLabel[] = [];
  for (const l of raw ?? []) {
    if (typeof l === "string") out.push({ name: l, color: "ededed" });
    else if (l.name) out.push({ name: l.name, color: l.color ?? "ededed" });
  }
  return out;
}

function toItem(raw: RawIssue): IssueListItem {
  return {
    number: raw.number,
    title: raw.title,
    htmlUrl: raw.html_url,
    author: raw.user?.login ?? null,
    labels: toLabels(raw.labels),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    commentCount: raw.comments ?? 0,
    milestone: raw.milestone?.title ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

async function getJson<T>(path: string, token: string, accept?: string): Promise<T> {
  const res = await githubApiFetch(path, {
    headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) },
  });
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API error for ${path} (HTTP ${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

/** `owner/repo` from a GitHub API repository or issue URL. */
function repoOfUrl(url: string | null | undefined): string | null {
  const m = /\/repos\/([^/]+\/[^/]+)/.exec(url ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

function toRef(
  raw: Pick<RawIssue, "number" | "title" | "state" | "repository_url">,
  currentRepo: string,
  repo = repoOfUrl(raw.repository_url),
): IssueRef {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === "closed" ? "closed" : "open",
    // A sibling repo's issue must not be opened as this project's issue of the same number.
    ...(repo && repo.toLowerCase() !== currentRepo.toLowerCase() ? { repo } : {}),
  };
}

/** The issue's children and parent. Best effort: a failed lookup only hides the card. */
async function getRelations(
  token: string,
  base: string,
  issue: RawIssue,
): Promise<Pick<IssueDetail, "subIssues" | "subIssuesSummary" | "parent">> {
  const total = issue.sub_issues_summary?.total ?? 0;
  const currentRepo = repoOfUrl(base) ?? "";
  // The parent may live in another repo of the same owner: fetch it from the
  // repo its URL names, not from this one.
  const parentRef = parseParentIssueUrl(issue.parent_issue_url);
  const [children, parent] = await Promise.all([
    total > 0
      ? getJson<RawIssue[]>(`${base}/sub_issues?per_page=100`, token).catch(() => [])
      : Promise.resolve([] as RawIssue[]),
    parentRef
      ? getJson<RawIssue>(`/repos/${parentRef.repo}/issues/${parentRef.number}`, token).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  return {
    subIssues: children.map((c) => toRef(c, currentRepo)),
    subIssuesSummary: issue.sub_issues_summary
      ? { total, completed: issue.sub_issues_summary.completed ?? 0 }
      : null,
    parent: parent && parentRef ? toRef(parent, currentRepo, parentRef.repo) : null,
  };
}

/** One issue by number, or null when it is missing, closed or a pull request. */
async function findOpenIssue(
  token: string,
  repoPath: string,
  number: number,
): Promise<RawIssue | null> {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  try {
    const issue = await getJson<RawIssue>(`${repoPath}/issues/${number}`, token);
    return issue.pull_request || issue.state === "closed" ? null : issue;
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 404) return null;
    throw err;
  }
}

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  query: IssueListQuery = {},
): Promise<IssueListResult> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const needle = query.q?.trim().toLowerCase();
  const base = new URLSearchParams({
    state: "open",
    per_page: String(PAGE_SIZE),
    sort: query.sort ?? "updated",
    direction: "desc",
  });
  if (query.labels) base.set("labels", query.labels);
  if (query.assignee) base.set("assignee", query.assignee);

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fetchRawPage = (n: number) => {
    const params = new URLSearchParams(base);
    params.set("page", String(n));
    return getJson<RawIssue[]>(`${repoPath}/issues?${params}`, token);
  };
  // `/issues` returns PRs too (they carry a `pull_request` field).
  const toIssues = (raw: RawIssue[]) => raw.filter((i) => !i.pull_request).map(toItem);

  let items: IssueListItem[];
  let labelSource: IssueListItem[];
  let hasMore: boolean;
  let truncated = false;

  const match = query.match;
  const keep = (i: IssueListItem) =>
    (!needle || i.title.toLowerCase().includes(needle)) && (!match || match(i));
  let total: number | undefined;

  if (!needle && !match) {
    const raw = await fetchRawPage(page);
    items = labelSource = toIssues(raw);
    // A full raw page (PRs included) may have another page behind it.
    hasMore = raw.length >= PAGE_SIZE;
  } else {
    // GitHub can't filter by title substring (or by Task Master origin) on the
    // list endpoint, so scan raw pages from the start (labels/assignee/sort
    // already applied) until the matches cover the requested page plus one
    // more — or, when counting, every page — the repo is exhausted, or the
    // scan cap is hit.
    const matches: IssueListItem[] = [];
    const scanned: IssueListItem[] = [];
    const wanted = page * PAGE_SIZE + 1;
    let exhausted = false;
    for (let n = 1; n <= MAX_SEARCH_PAGES && (query.countMatches || matches.length < wanted); n++) {
      const raw = await fetchRawPage(n);
      const issues = toIssues(raw);
      scanned.push(...issues);
      matches.push(...issues.filter(keep));
      if (raw.length < PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
    items = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    labelSource = scanned;
    hasMore = matches.length > page * PAGE_SIZE;
    // Out of scan budget with more raw pages unread: older matches may be missing.
    truncated = !hasMore && !exhausted;
    if (query.countMatches) {
      total = matches.length;
      // Counting reads past the page, so more pages can still be unread.
      truncated = !exhausted;
    }

    // `123` / `#123` is an issue number: look it up directly (page 1 only) so
    // it is found even when it is not among the scanned pages.
    const numberMatch = needle && page === 1 ? /^#?(\d+)$/.exec(needle) : null;
    const byNumber = numberMatch
      ? await findOpenIssue(token, repoPath, Number(numberMatch[1]))
      : null;
    const byNumberItem = byNumber ? toItem(byNumber) : null;
    if (
      byNumberItem &&
      (!match || match(byNumberItem)) &&
      !items.some((i) => i.number === byNumberItem.number)
    )
      items.unshift(byNumberItem);
  }

  const seen = new Map<string, IssueLabel>();
  for (const item of labelSource) {
    for (const l of item.labels) if (!seen.has(l.name)) seen.set(l.name, l);
  }

  return {
    issues: items,
    page,
    hasMore,
    ...(truncated ? { truncated } : {}),
    labels: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...(total !== undefined ? { total } : {}),
  };
}

/** GitHub's page size for an issue's comments (its maximum). */
const COMMENTS_PAGE_SIZE = 100;

export async function getIssueDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueDetail> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  // Page 1 is GitHub's default, so its URL stays the plain one.
  const commentsUrl = (page: number) =>
    `${base}/comments?per_page=${COMMENTS_PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`;
  const [issue, firstPage] = await Promise.all([
    getJson<RawIssue>(base, token, HTML_ACCEPT),
    getJson<RawComment[]>(commentsUrl(1), token, HTML_ACCEPT),
  ]);
  let comments = firstPage;
  // GitHub lists comments oldest first, so page 1 of a long thread is its
  // OLDEST hundred. The conversation is read newest first, so fetch the tail:
  // walk back from the last page until a hundred are collected. Walking (rather
  // than assuming the last page is full) also covers a last page that comes back
  // short or empty — a comment deleted between the issue GET and this fetch —
  // without ever mistaking page 1 for "the latest".
  const total = issue.comments ?? firstPage.length;
  if (total > COMMENTS_PAGE_SIZE) {
    const pages: RawComment[][] = [];
    let collected = 0;
    for (
      let page = Math.ceil(total / COMMENTS_PAGE_SIZE);
      page >= 1 && collected < COMMENTS_PAGE_SIZE;
      page--
    ) {
      const got =
        page === 1 ? firstPage : await getJson<RawComment[]>(commentsUrl(page), token, HTML_ACCEPT);
      pages.unshift(got);
      collected += got.length;
    }
    comments = pages.flat().slice(-COMMENTS_PAGE_SIZE);
  }
  if (issue.pull_request) {
    throw new GitHubApiError(`#${number} is a pull request, not an issue`, 404);
  }
  const relations = await getRelations(token, base, issue);
  return {
    ...toItem(issue),
    ...relations,
    state: issue.state === "closed" ? "closed" : "open",
    bodyHtml: issue.body_html ?? "",
    comments: comments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? null,
      bodyHtml: c.body_html ?? "",
      createdAt: c.created_at,
      htmlUrl: c.html_url,
    })),
  };
}
