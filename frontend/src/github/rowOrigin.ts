import type { GitHubIssueListItem, GitHubPROrWithChecks } from "../api/types.js";
import { isTaskBranch, type MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { splitTaskSessions } from "../ui/sidebar/linkDecisions.js";
import { ATTENTION_ORDER } from "./prPhase.js";

/** Who is working a PR or issue: a Task Master task, a hand-started session, or nobody.
 *  The filter treats everything that is not `"tm"` as Manual (see `matchesOrigin`); the
 *  `"manual"`/`"none"` split only decides whether the row gets a left-edge marker. */
export type RowOrigin = "tm" | "manual" | "none";
export type OriginFilterValue = "all" | "tm" | "manual";

const manualCount = (link: MullionLinkEntry | undefined) =>
  splitTaskSessions(link?.sessions ?? [], link?.task ?? null).rest.length;

export function prOrigin(pr: GitHubPROrWithChecks, link: MullionLinkEntry | undefined): RowOrigin {
  // A `mullion/task-*` branch is Task Master's even when its task row is gone.
  if (link?.task || pr.taskId != null || isTaskBranch(pr.headBranch)) return "tm";
  return manualCount(link) > 0 ? "manual" : "none";
}

export function issueOrigin(
  issue: GitHubIssueListItem,
  link: MullionLinkEntry | undefined,
): RowOrigin {
  if (link?.task || issue.taskStatus) return "tm";
  return manualCount(link) > 0 ? "manual" : "none";
}

/** "Manual" means "not Task Master's" — a human's PR or issue stays under it
 *  whether or not a hand-started session is live on it right now (`"none"`). */
export function matchesOrigin(filter: OriginFilterValue, origin: RowOrigin): boolean {
  if (filter === "all") return true;
  if (filter === "manual") return origin !== "tm";
  return filter === origin;
}

/** The row's left-edge marker: blue for Task Master, grey for a manual session. */
export function originClass(origin: RowOrigin): string {
  return origin === "none" ? "" : `sb-row--${origin}`;
}

/** A PR that wants the user (failing CI, changes requested, conflicts, ...). */
export function needsAttention(pr: Pick<GitHubPROrWithChecks, "prPhase">): boolean {
  return pr.prPhase != null && ATTENTION_ORDER.includes(pr.prPhase);
}
