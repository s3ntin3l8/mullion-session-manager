import type { GitHubIssueListItem, GitHubPROrWithChecks } from "../api/types.js";
import type { MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { splitTaskSessions } from "../ui/sidebar/linkDecisions.js";
import { ATTENTION_ORDER } from "./prPhase.js";

/** Who is working a PR or issue: a Task Master task, a hand-started session, or nobody. */
export type RowOrigin = "tm" | "manual" | "none";
export type OriginFilterValue = "all" | "tm" | "manual";

const manualCount = (link: MullionLinkEntry | undefined) =>
  splitTaskSessions(link?.sessions ?? [], link?.task ?? null).rest.length;

export function prOrigin(pr: GitHubPROrWithChecks, link: MullionLinkEntry | undefined): RowOrigin {
  if (link?.task || pr.taskId != null) return "tm";
  return manualCount(link) > 0 ? "manual" : "none";
}

export function issueOrigin(
  issue: GitHubIssueListItem,
  link: MullionLinkEntry | undefined,
): RowOrigin {
  if (link?.task || issue.taskStatus) return "tm";
  return manualCount(link) > 0 ? "manual" : "none";
}

export function matchesOrigin(filter: OriginFilterValue, origin: RowOrigin): boolean {
  return filter === "all" || filter === origin;
}

/** The row's left-edge marker: blue for Task Master, grey for a manual session. */
export function originClass(origin: RowOrigin): string {
  return origin === "none" ? "" : `sb-row--${origin}`;
}

/** A PR that wants the user (failing CI, changes requested, conflicts, ...). */
export function needsAttention(pr: Pick<GitHubPROrWithChecks, "prPhase">): boolean {
  return pr.prPhase != null && ATTENTION_ORDER.includes(pr.prPhase);
}
