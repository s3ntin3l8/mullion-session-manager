// Shared GitHub REST write client (Phase 6 Task Master, 6.4/#217) — the
// first write capability beyond registerHook/unregisterHook
// (github-webhook.ts). One `githubRequest()` helper (owner/repo/method/
// path-suffix/optional JSON body), modeled on github-webhook.ts's
// registerHook shape: validateGitHubRepoRef() first, the standard header
// block, AbortSignal.timeout, error-body-into-message on failure.
// Deliberately THROWS on failure — unlike unregisterHook's
// `.catch(() => {})`, a dropped label or comment here would silently
// desync the local task row from the issue-of-record, which
// task-github-sync.ts's callers need to know about (even if they choose to
// treat it as best-effort themselves).
//
// validateGitHubRepoRef() runs INSIDE githubRequest itself, in the same
// function that builds the URL and calls fetch — not just in each public
// wrapper before calling in here. Every wrapper below already validated
// once too, so this looks redundant, but it isn't: CodeQL's
// js/request-forgery dataflow analysis doesn't reliably connect a
// sanitizer call to a tainted value across a function-call boundary when
// the fetch itself happens one level deeper (a real finding on this file's
// first version, not a false-positive dismissal) — github.ts's own
// functions all validate-and-fetch in the same function body for exactly
// this reason, and this file now matches that precedent.

import { GitHubApiError, validateGitHubRepoRef } from "./github.js";

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "mullion-session-manager";

/**
 * A write rejected with 403/404 almost always means the connected token
 * lacks the required scope, not a transient API error — device-flow tokens
 * carry OAuth `repo` (read+write) and just work, while every fine-grained
 * PAT provisioned per today's docs is read-only and 403s on the first
 * label/comment/close write. Distinct from GitHubApiError so callers (and
 * their logs) can tell "GitHub is down" from "this token can't do this,"
 * per docs/github-integration.md's scope table. Only raised for a
 * write-method (POST/PATCH/DELETE) request — see githubRequest's own
 * comment on why a 404 on a GET means something else entirely.
 */
export class GitHubWriteScopeError extends GitHubApiError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "GitHubWriteScopeError";
  }
}

async function githubRequest<T>(
  token: string,
  owner: string,
  repo: string,
  method: string,
  pathSuffix: string,
  body?: unknown,
): Promise<T> {
  validateGitHubRepoRef(owner, repo);
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${pathSuffix}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubApiError(
      `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    // A 404 on a write (label/comment/assignee/close/PR-create endpoints
    // all live under an issue/repo path a write implies exists) almost
    // always means "no write access" rather than "not found" — GitHub
    // returns 404, not 403, for a resource a token can't see at all. A GET
    // is different: a 404 there is a completely ordinary "this issue
    // doesn't exist" (or the repo doesn't), not a scope problem, so it's
    // left as a plain GitHubApiError instead.
    if (res.status === 403 || (res.status === 404 && method !== "GET")) {
      throw new GitHubWriteScopeError(
        `GitHub rejected this write (HTTP ${res.status}) for ${method} ${path} — the connected token likely lacks write access. See docs/github-integration.md for the required scopes. ${responseBody}`.trim(),
        res.status,
      );
    }
    throw new GitHubApiError(
      `GitHub API error (HTTP ${res.status}) for ${method} ${path}: ${responseBody}`,
      res.status,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function addLabels(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/issues/${issueNumber}/labels`, { labels });
}

/**
 * A 404 here means the label wasn't on the issue (or doesn't exist on the
 * repo at all) — already the desired end state, so it's swallowed as a
 * no-op rather than surfaced as a scope error or a write failure. Any
 * other failure (including a 403, which DOES indicate a real scope
 * problem — removing a label needs the same write access as adding one)
 * still throws.
 */
export async function removeLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await githubRequest(
      token,
      owner,
      repo,
      "DELETE",
      `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
  } catch (err) {
    if (err instanceof GitHubWriteScopeError && err.statusCode === 404) return;
    throw err;
  }
}

export async function createComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; htmlUrl: string }> {
  const result = await githubRequest<{ id: number; html_url: string }>(
    token,
    owner,
    repo,
    "POST",
    `/issues/${issueNumber}/comments`,
    { body },
  );
  return { id: result.id, htmlUrl: result.html_url };
}

export async function setAssignees(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  assignees: string[],
): Promise<void> {
  await githubRequest(token, owner, repo, "POST", `/issues/${issueNumber}/assignees`, {
    assignees,
  });
}

export async function closeIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await githubRequest(token, owner, repo, "PATCH", `/issues/${issueNumber}`, {
    state: "closed",
  });
}

/** Fetches the current open/closed state of a single issue — used by
 * task-github-sync.ts's read-back path to tell "closed on GitHub" apart
 * from "still open" for a task that dropped out of the watcher's labeled-
 * issues sweep. */
export async function getIssueState(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<"open" | "closed"> {
  const result = await githubRequest<{ state: "open" | "closed" }>(
    token,
    owner,
    repo,
    "GET",
    `/issues/${issueNumber}`,
  );
  return result.state;
}

export interface CreatePullRequestParams {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/** Used by 6.7's task -> PR promotion (createSessionRecord/git-push.ts's
 * caller) — included here now since it's the same write-client shape as
 * every other operation in this file, not because this PR creates PRs. */
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  params: CreatePullRequestParams,
): Promise<{ number: number; htmlUrl: string }> {
  const result = await githubRequest<{ number: number; html_url: string }>(
    token,
    owner,
    repo,
    "POST",
    `/pulls`,
    { title: params.title, head: params.head, base: params.base, body: params.body },
  );
  return { number: result.number, htmlUrl: result.html_url };
}
