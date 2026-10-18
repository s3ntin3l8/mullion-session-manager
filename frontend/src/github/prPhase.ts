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
export const ATTENTION_ORDER: GitHubPrPhase[] = ["ci_failing", "changes_requested", "conflicts"];

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

/** The short glyph + words a compact surface (session row) shows for a PR. */
export function phaseChip(
  phase: GitHubPrPhase | undefined,
  unresolvedThreads: number | null | undefined,
): { glyph: string; text: string } | null {
  const threads = unresolvedThreads && unresolvedThreads > 0 ? ` 💬${unresolvedThreads}` : "";
  switch (phase) {
    case "ci_failing":
      return { glyph: "✗", text: `CI${threads}` };
    case "changes_requested":
      return { glyph: "✎", text: `changes${threads}` };
    case "conflicts":
      return { glyph: "⚠", text: `conflicts${threads}` };
    case "ready_to_merge":
      return { glyph: "✓", text: `ready${threads}` };
    case "draft":
      return { glyph: "", text: `draft${threads}` };
    default:
      return threads ? { glyph: "", text: threads.trim() } : null;
  }
}

/** Open PRs that want the user, by phase — what the right-rail badge counts. */
export function attentionSummary(prs: readonly { prPhase?: GitHubPrPhase }[]): {
  total: number;
  byPhase: Partial<Record<GitHubPrPhase, number>>;
} {
  const byPhase: Partial<Record<GitHubPrPhase, number>> = {};
  let total = 0;
  for (const pr of prs) {
    if (pr.prPhase && ATTENTION_ORDER.includes(pr.prPhase)) {
      byPhase[pr.prPhase] = (byPhase[pr.prPhase] ?? 0) + 1;
      total += 1;
    }
  }
  return { total, byPhase };
}
