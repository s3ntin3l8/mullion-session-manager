import type { GitHubPrPhase } from "../api/types.js";
import { PHASE_LABEL } from "./prPhase.js";

// What a PR needs next, read from its phase — the one labelled button in the
// PR detail's action bar (PrActionBar.tsx). A merge button that is merely
// disabled hides why; this says it.

export type NextStepKind =
  "merge" | "threads" | "handoff" | "checks" | "reReview" | "update" | "none";

export interface NextStep {
  kind: NextStepKind;
  label: string;
  /** A step the PR cannot take yet (draft, CI still running): shown, not clickable. */
  disabled: boolean;
}

export function nextStep(phase: GitHubPrPhase | undefined, unresolved: number): NextStep {
  switch (phase) {
    case "ready_to_merge":
      return { kind: "merge", label: "Squash & merge", disabled: false };
    case "threads_unresolved":
      return {
        kind: "threads",
        label:
          unresolved > 0
            ? `Resolve ${unresolved} conversation${unresolved === 1 ? "" : "s"}`
            : "Resolve conversations",
        disabled: false,
      };
    case "changes_requested":
      return { kind: "handoff", label: "Address changes", disabled: false };
    case "conflicts":
      return { kind: "handoff", label: "Fix conflicts", disabled: false };
    case "behind":
      return { kind: "update", label: "Update branch", disabled: false };
    case "ci_failing":
      return { kind: "checks", label: "Show failing checks", disabled: false };
    case "review_pending":
    case "reviewed":
      return { kind: "reReview", label: "Request re-review", disabled: false };
    default:
      return { kind: "none", label: PHASE_LABEL[phase ?? "unknown"], disabled: true };
  }
}
