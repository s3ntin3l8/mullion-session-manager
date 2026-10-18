import type { GitHubPrPhase } from "../api/types.js";

export const PHASE_LABEL: Record<GitHubPrPhase, string> = {
  draft: "Draft",
  conflicts: "Conflicts",
  ci_failing: "CI failing",
  changes_requested: "Changes requested",
  review_pending: "Awaiting review",
  ci_pending: "CI running",
  ready_to_merge: "Ready to merge",
  unknown: "Status unknown",
};

/** Phases that want the user's attention first, most urgent first. */
const ATTENTION_ORDER: GitHubPrPhase[] = ["ci_failing", "changes_requested", "conflicts"];

export function phaseTone(phase: GitHubPrPhase): "bad" | "warn" | "good" | "dim" {
  if (phase === "ci_failing" || phase === "changes_requested" || phase === "conflicts") {
    return "bad";
  }
  if (phase === "review_pending" || phase === "ci_pending") return "warn";
  if (phase === "ready_to_merge") return "good";
  return "dim";
}

/** Needs-attention PRs first (in ATTENTION_ORDER), then most recently updated. */
export function sortPrsByAttention<
  T extends { prPhase?: GitHubPrPhase; updatedAt?: string | null; number: number },
>(prs: readonly T[]): T[] {
  const rank = (p: T) => {
    const i = p.prPhase ? ATTENTION_ORDER.indexOf(p.prPhase) : -1;
    return i === -1 ? ATTENTION_ORDER.length : i;
  };
  return [...prs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    // A PR with no updatedAt sorts as oldest.
    const ts = (p: T) => Date.parse(p.updatedAt ?? "") || 0;
    const t = ts(b) - ts(a);
    if (t !== 0) return t;
    return b.number - a.number;
  });
}
