// Read-only code-scanning detail for a task blocked on a CodeQL annotation
// (#2998): the alert's rule and location, the flagged snippet at the alert's
// commit, and earlier dismissals of the same rule — what a human needs to
// recognise a false positive without leaving Mullion.
//
// Every call here is a GET made with the human account token the caller passes
// in (never a GitHub App token: an App has no `security_events` permission).
// The one write is `dismissCodeScanningAlert` (#2999), called only from the
// human-only dismiss route, with that same human token.

import { githubRequest } from "./github-request.js";
import { GitHubApiError } from "./github.js";
import type { GitHubRepoRef } from "./git-remote.js";

export interface CodeScanningAlert {
  rule: {
    id: string;
    description: string;
    severity: string | null;
    securitySeverity: string | null;
  };
  location: { path: string; startLine: number; endLine: number } | null;
  message: string | null;
  commitSha: string | null;
  state: string;
  htmlUrl: string;
}

export interface AlertSnippetLine {
  number: number;
  text: string;
  flagged: boolean;
}

export interface PriorDismissal {
  number: number;
  path: string | null;
  reason: string | null;
  comment: string | null;
  dismissedBy: string | null;
  url: string;
}

export interface PriorDismissals {
  dismissals: PriorDismissal[];
  /** Same-rule dismissals beyond the (capped) list, on other paths or past the cap. */
  otherPathCount: number;
}

export type CanDismiss = { ok: true } | { ok: false; reason: string };

const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX_LINES = 30;
const DISMISSALS_PER_PAGE = 100;
const DISMISSALS_MAX_PAGES = 5;
const DISMISSALS_MAX_RESULTS = 5;
const DISMISSALS_TTL_MS = 5 * 60_000;

interface RawAlert {
  number?: number;
  state?: string;
  html_url?: string;
  rule?: {
    id?: string;
    description?: string;
    severity?: string | null;
    security_severity_level?: string | null;
  };
  most_recent_instance?: {
    commit_sha?: string;
    message?: { text?: string };
    location?: { path?: string; start_line?: number; end_line?: number };
  };
  dismissed_by?: { login?: string } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
}

const alertPath = (n: number) => `/code-scanning/alerts/${encodeURIComponent(String(n))}`;

export async function fetchCodeScanningAlert(
  token: string,
  ref: GitHubRepoRef,
  n: number,
): Promise<CodeScanningAlert> {
  const a = await githubRequest<RawAlert>(token, ref.owner, ref.repo, "GET", alertPath(n));
  const inst = a.most_recent_instance;
  const loc = inst?.location;
  return {
    rule: {
      id: a.rule?.id ?? "",
      description: a.rule?.description ?? "",
      severity: a.rule?.severity ?? null,
      securitySeverity: a.rule?.security_severity_level ?? null,
    },
    location:
      loc?.path && typeof loc.start_line === "number"
        ? {
            path: loc.path,
            startLine: loc.start_line,
            endLine: typeof loc.end_line === "number" ? loc.end_line : loc.start_line,
          }
        : null,
    message: inst?.message?.text ?? null,
    commitSha: inst?.commit_sha ?? null,
    state: a.state ?? "unknown",
    htmlUrl: a.html_url ?? "",
  };
}

/**
 * The flagged lines plus 3 lines of context each side, capped at 30 lines
 * (the flagged range wins the budget; a longer one is cut at the cap), read
 * from the contents API at `sha`. Null when the file is not a readable text
 * file (directory, binary, too large for inline content).
 */
export async function fetchAlertSnippet(
  token: string,
  ref: GitHubRepoRef,
  path: string,
  sha: string,
  startLine: number,
  endLine: number,
): Promise<AlertSnippetLine[] | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = await githubRequest<{ content?: string; encoding?: string; type?: string }>(
    token,
    ref.owner,
    ref.repo,
    "GET",
    `/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`,
  );
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    return null;
  }
  const lines = Buffer.from(file.content, "base64").toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const flaggedEnd = Math.max(startLine, endLine);
  let from = Math.max(1, startLine - SNIPPET_CONTEXT);
  let to = Math.min(lines.length, flaggedEnd + SNIPPET_CONTEXT);
  if (to - from + 1 > SNIPPET_MAX_LINES) {
    // Keep the start of the flagged range in view; trim the tail first.
    from = Math.max(from, startLine - SNIPPET_CONTEXT);
    to = from + SNIPPET_MAX_LINES - 1;
  }
  const out: AlertSnippetLine[] = [];
  for (let i = from; i <= to; i++) {
    out.push({
      number: i,
      text: lines[i - 1]!.replace(/\r$/, ""),
      flagged: i >= startLine && i <= flaggedEnd,
    });
  }
  return out;
}

const dismissalsCache = new Map<string, { at: number; alerts: RawAlert[] }>();

/** Test seam: forget cached dismissed-alert pages. */
export function resetCodeScanningCache(): void {
  dismissalsCache.clear();
}

async function dismissedAlerts(token: string, ref: GitHubRepoRef): Promise<RawAlert[]> {
  const key = `${ref.owner}/${ref.repo}`.toLowerCase();
  const hit = dismissalsCache.get(key);
  if (hit && Date.now() - hit.at < DISMISSALS_TTL_MS) return hit.alerts;
  const all: RawAlert[] = [];
  for (let page = 1; page <= DISMISSALS_MAX_PAGES; page++) {
    const batch = await githubRequest<RawAlert[]>(
      token,
      ref.owner,
      ref.repo,
      "GET",
      `/code-scanning/alerts?state=dismissed&per_page=${DISMISSALS_PER_PAGE}&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < DISMISSALS_PER_PAGE) break;
  }
  dismissalsCache.set(key, { at: Date.now(), alerts: all });
  return all;
}

/**
 * Earlier dismissed alerts of the same rule (GitHub has no rule filter, so
 * this is client-side over at most 5 pages), same path first, at most 5.
 * `otherPathCount` is the same-rule dismissals not listed.
 */
export async function fetchPriorDismissals(
  token: string,
  ref: GitHubRepoRef,
  ruleId: string,
  path: string | null,
  excludeNumber?: number,
  /** Dismissals Mullion itself recorded (`code_scanning_dismissals`): a
   * dismissal on an unmerged PR branch, or one inside GitHub's list cache
   * window, still shows as prior art. GitHub's own entry wins on a number. */
  recorded: PriorDismissal[] = [],
): Promise<PriorDismissals> {
  const all = await dismissedAlerts(token, ref);
  const fromGitHub = all
    .filter((a) => a.rule?.id === ruleId && a.number !== excludeNumber)
    .map((a) => ({
      number: a.number ?? 0,
      path: a.most_recent_instance?.location?.path ?? null,
      reason: a.dismissed_reason ?? null,
      comment: a.dismissed_comment ?? null,
      dismissedBy: a.dismissed_by?.login ?? null,
      url: a.html_url ?? "",
    }));
  const seen = new Set(fromGitHub.map((d) => d.number));
  const same = [
    ...fromGitHub,
    ...recorded.filter((d) => d.number !== excludeNumber && !seen.has(d.number)),
  ];
  const onPath = same.filter((d) => path !== null && d.path === path);
  const rest = same.filter((d) => !(path !== null && d.path === path));
  const ordered = [...onPath, ...rest];
  return {
    dismissals: ordered.slice(0, DISMISSALS_MAX_RESULTS),
    otherPathCount: Math.max(0, ordered.length - DISMISSALS_MAX_RESULTS),
  };
}

export type DismissReason = "false positive" | "won't fix" | "used in tests";
export const DISMISS_REASONS: readonly DismissReason[] = [
  "false positive",
  "won't fix",
  "used in tests",
];
/** GitHub's limit on `dismissed_comment`. */
export const DISMISS_COMMENT_MAX = 280;

/**
 * Dismiss one alert. A write: pass the human account token only (never an App
 * token — an App has no `security_events` write, and a dismissal must be the
 * human's own act). Throws `GitHubWriteScopeError` on 403/404.
 */
export async function dismissCodeScanningAlert(
  token: string,
  ref: GitHubRepoRef,
  n: number,
  reason: DismissReason,
  comment: string,
): Promise<void> {
  await githubRequest(token, ref.owner, ref.repo, "PATCH", alertPath(n), {
    state: "dismissed",
    dismissed_reason: reason,
    dismissed_comment: comment,
  });
  // The cached dismissed-alert pages no longer include this one.
  dismissalsCache.delete(`${ref.owner}/${ref.repo}`.toLowerCase());
}

/**
 * Whether the connected human account can later dismiss alerts. Judged from
 * the account token only. A fine-grained PAT stores no scopes: unknown → ok.
 * `alertFetchError` is whatever the alert GET threw, if anything.
 */
export function computeCanDismiss(
  token: string | null,
  scopes: string[] | null,
  alertFetchError: unknown,
): CanDismiss {
  if (!token)
    return { ok: false, reason: "Connect a GitHub account in Settings to dismiss alerts." };
  if (
    scopes &&
    scopes.length > 0 &&
    !scopes.includes("repo") &&
    !scopes.includes("security_events")
  ) {
    return {
      ok: false,
      reason: `The connected token is missing the \`security_events\` (or \`repo\`) scope needed to dismiss alerts.`,
    };
  }
  if (
    alertFetchError instanceof GitHubApiError &&
    (alertFetchError.statusCode === 403 || alertFetchError.statusCode === 404)
  ) {
    return {
      ok: false,
      reason:
        "The connected token can't read code scanning alerts (needs Code scanning alerts: read and write).",
    };
  }
  return { ok: true };
}
