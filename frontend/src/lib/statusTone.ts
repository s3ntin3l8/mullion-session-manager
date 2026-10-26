import type { GitHubCiStatus, GitHubPrPhase } from "../api/types.js";

/** The one status vocabulary; each maps to the `--status-<tone>-*` tokens. */
export type Tone = "success" | "danger" | "warn" | "info" | "neutral" | "merged";

export const TONES: readonly Tone[] = ["success", "danger", "warn", "info", "neutral", "merged"];

const SKIPPED_CONCLUSIONS = new Set(["skipped", "cancelled", "neutral"]);

export type ToneInput =
  /** A PR's lifecycle phase. */
  | { phase: GitHubPrPhase }
  /** The aggregate CI read; `null`/`undefined` = no Actions data. */
  | { ci: GitHubCiStatus | null | undefined }
  /** One check run / job / workflow run. */
  | { status: string; conclusion: string | null };

/** Single source of truth for "what colour is this state". */
export function statusTone(input: ToneInput): Tone {
  if ("phase" in input) {
    switch (input.phase) {
      case "ci_failing":
      case "changes_requested":
      case "conflicts":
        return "danger";
      case "review_pending":
      case "ci_pending":
        return "warn";
      case "ready_to_merge":
        return "success";
      default:
        return "neutral";
    }
  }
  if ("ci" in input) {
    if (input.ci === "success") return "success";
    if (input.ci === "failure") return "danger";
    if (input.ci === "in_progress") return "warn";
    return "neutral";
  }
  if (input.status !== "completed") return "warn";
  if (input.conclusion === "success") return "success";
  if (input.conclusion != null && SKIPPED_CONCLUSIONS.has(input.conclusion)) return "neutral";
  return "danger";
}

/**
 * Legacy `.github-panel-ci-dot` class names. Panels still style these until
 * B2-B5 move them onto `StatusChip`; the mapping lives here so there is one
 * tone decision and only a spelling layer on top of it.
 */
export type LegacyDotClass = "good" | "bad" | "pending" | "none";
export function legacyDotClass(tone: Tone): LegacyDotClass {
  switch (tone) {
    case "success":
      return "good";
    case "danger":
      return "bad";
    case "warn":
      return "pending";
    default:
      return "none";
  }
}

/** Legacy `.gh-phase-pill` class names (see {@link legacyDotClass}). */
export function legacyPillClass(tone: Tone): "bad" | "warn" | "good" | "dim" {
  switch (tone) {
    case "success":
      return "good";
    case "danger":
      return "bad";
    case "warn":
      return "warn";
    default:
      return "dim";
  }
}

/** The words for a check/run state: its conclusion once finished, else its status. */
export function runStatusText(status: string, conclusion: string | null): string {
  return status === "completed" ? (conclusion ?? "unknown") : status;
}
