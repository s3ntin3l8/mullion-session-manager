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

const PAGE_SIZE = 50;
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
  /** Every label seen on the returned page, for the filter chips. */
  labels: IssueLabel[];
}

export interface IssueComment {
  id: number;
  author: string | null;
  bodyHtml: string;
  createdAt: string;
  htmlUrl: string;
}

export interface IssueDetail extends IssueListItem {
  state: "open" | "closed";
  bodyHtml: string;
  comments: IssueComment[];
}

export type IssueSort = "updated" | "created" | "comments";

export interface IssueListQuery {
  /** Comma-separated labels; GitHub ANDs them. */
  labels?: string;
  /** A login, `*` (any assignee) or `none`. */
  assignee?: string;
  sort?: IssueSort;
  /** Case-insensitive substring match on the title, applied to the fetched page. */
  q?: string;
  page?: number;
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

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  query: IssueListQuery = {},
): Promise<IssueListResult> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const params = new URLSearchParams({
    state: "open",
    per_page: String(PAGE_SIZE),
    page: String(page),
    sort: query.sort ?? "updated",
    direction: "desc",
  });
  if (query.labels) params.set("labels", query.labels);
  if (query.assignee) params.set("assignee", query.assignee);

  const raw = await getJson<RawIssue[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`,
    token,
  );
  // `/issues` returns PRs too (they carry a `pull_request` field).
  const rawIssues = raw.filter((i) => !i.pull_request);
  const needle = query.q?.trim().toLowerCase();
  const pageItems = rawIssues.map(toItem);
  const items = pageItems.filter((i) => !needle || i.title.toLowerCase().includes(needle));

  const seen = new Map<string, IssueLabel>();
  for (const item of pageItems) {
    for (const l of item.labels) if (!seen.has(l.name)) seen.set(l.name, l);
  }

  return {
    issues: items,
    page,
    // A full raw page (PRs included) may have another page behind it.
    hasMore: raw.length >= PAGE_SIZE,
    labels: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function getIssueDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueDetail> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  const [issue, comments] = await Promise.all([
    getJson<RawIssue>(base, token, HTML_ACCEPT),
    getJson<RawComment[]>(`${base}/comments?per_page=100`, token, HTML_ACCEPT),
  ]);
  if (issue.pull_request) {
    throw new GitHubApiError(`#${number} is a pull request, not an issue`, 404);
  }
  return {
    ...toItem(issue),
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
