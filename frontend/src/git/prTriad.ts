import type { GitHubPROrWithChecks } from "../api/types.js";
import type { TriadItem } from "../ui/sidebar/index.js";

/** CI · Review · Merge for the branch's PR, in the kit's one tone vocabulary. */
export function prTriad(pr: GitHubPROrWithChecks, onOpen: () => void): TriadItem[] {
  const ci: TriadItem =
    pr.ciStatus === "success"
      ? { key: "ci", tone: "success", label: "CI passing", short: "✓", title: "CI passing" }
      : pr.ciStatus === "failure"
        ? { key: "ci", tone: "danger", label: "CI failing", short: "✗", title: "CI failing" }
        : pr.ciStatus === "in_progress"
          ? { key: "ci", tone: "warn", label: "CI running", short: "…", title: "CI running" }
          : { key: "ci", tone: "neutral", label: "No CI", short: "–", title: "No CI results" };
  const review: TriadItem =
    pr.reviewDecision === "APPROVED"
      ? { key: "review", tone: "success", label: "Approved", short: "Approved", title: "Approved" }
      : pr.reviewDecision === "CHANGES_REQUESTED"
        ? {
            key: "review",
            tone: "danger",
            label: "Changes requested",
            short: "Changes",
            title: "Changes requested",
          }
        : pr.reviewDecision === "REVIEW_REQUIRED"
          ? {
              key: "review",
              tone: "warn",
              label: "Review required",
              short: "💬",
              title: "Review required",
            }
          : {
              key: "review",
              tone: "neutral",
              label: "No review",
              short: "💬",
              title: "No review yet",
            };
  const merge: TriadItem =
    pr.mergeable === "CONFLICTING"
      ? {
          key: "merge",
          tone: "danger",
          label: "Conflicts",
          short: "Conflicts",
          title: "Merge conflicts",
        }
      : pr.isDraft
        ? { key: "merge", tone: "neutral", label: "Draft", short: "Draft", title: "Draft" }
        : pr.prPhase === "ready_to_merge"
          ? {
              key: "merge",
              tone: "success",
              label: "Ready",
              short: "Ready",
              title: "Ready to merge",
            }
          : pr.mergeStateStatus === "BLOCKED"
            ? {
                key: "merge",
                tone: "warn",
                label: "Blocked",
                short: "Blocked",
                title: "Merge blocked",
              }
            : {
                key: "merge",
                tone: "neutral",
                label: "Unknown",
                short: "–",
                title: "Merge state unknown",
              };
  return [ci, review, merge].map((i) => ({ ...i, onClick: onOpen }));
}
