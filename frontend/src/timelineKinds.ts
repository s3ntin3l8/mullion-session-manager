import type { NotificationEvent } from "./api/index.js";
import { ALL_KINDS } from "./eventDescriptions.js";

export type TimelineKind = NotificationEvent["kind"];

// Making notifications relevant/scannable — title_change (86% of every row
// this app has ever persisted) and file_change (another 2%) are opt-out of
// the DEFAULT filter, not removed as options: a session actively spamming
// title updates used to be the first thing a freshly-opened timeline showed,
// burying any actual signal under routine chatter. Both stay one click away
// in the Custom popover. This set IS the "Important" preset.
export const IMPORTANT_KINDS: readonly TimelineKind[] = ALL_KINDS.filter(
  (kind) => kind !== "title_change" && kind !== "file_change",
);

// The Custom popover's grouping (docs/design/task-master/mockup.html, view
// "5 · Timeline filters"). Every member of ALL_KINDS belongs to exactly one
// group — timelineKinds.test.ts enumerates ALL_KINDS against this table so a
// kind added to eventDescriptions.ts cannot silently miss the popover.
export const KIND_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  kinds: readonly TimelineKind[];
}> = [
  {
    id: "agent",
    label: "Agent",
    kinds: [
      "attention",
      "status_change",
      "tool_failure",
      "plan_ready",
      "question",
      "todo",
      "permission_request",
    ],
  },
  {
    id: "session",
    label: "Session",
    kinds: [
      "title_change",
      "file_change",
      "stop_failure",
      "session_end",
      "message_sent",
      "message_received",
    ],
  },
  {
    id: "git",
    label: "Git & PR",
    kinds: [
      "pr_ci_failed",
      "pr_ci_passed",
      "pr_review_submitted",
      "pr_new_comments",
      "pr_merged",
      "pr_conflicts",
      "session_diff",
    ],
  },
  {
    id: "review",
    label: "Review & promote",
    kinds: ["review_gate", "promote_request", "elicitation", "dev_server_detected"],
  },
];

// pr_ci_failed and pr_ci_passed share one KIND_LABELS entry ("PR CI"), which
// is fine for a pill on a row but gives the two popover options the same name.
export const KIND_OPTION_LABELS: Partial<Record<TimelineKind, string>> = {
  pr_ci_failed: "PR CI failed",
  pr_ci_passed: "PR CI passed",
};

export type TimelinePreset = "important" | "all" | "custom";

function sameKinds(a: ReadonlySet<TimelineKind>, b: readonly TimelineKind[]): boolean {
  return a.size === b.length && b.every((kind) => a.has(kind));
}

/** Which preset a kind selection amounts to. There is no stored preset: a
 * selection that is neither the Important nor the All set IS Custom, which is
 * also what an old persisted selection (written before the presets existed)
 * becomes on first load. */
export function timelinePreset(active: ReadonlySet<TimelineKind>): TimelinePreset {
  if (sameKinds(active, IMPORTANT_KINDS)) return "important";
  if (sameKinds(active, ALL_KINDS)) return "all";
  return "custom";
}

// The timeline renders on two surfaces whose filter choices persist
// independently: a session's own timeline panel and a Task Master task's
// detail (worker + reviewer timelines).
export type TimelineSurface = "session" | "task";
