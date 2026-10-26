// Why Task Master's automatic review loop stopped and is waiting on a human —
// the board card and the task drawer share this wording so they can't drift.
// `null`/"cap" is the original (and still most common) reason: the round cap.
export type NeedsHumanReason = "cap" | "no-progress" | "finding-persisted";

export function needsHumanText(reason: NeedsHumanReason | null | undefined): string {
  switch (reason) {
    case "no-progress":
      return "worker returned without a change";
    case "finding-persisted":
      return "same finding still open after two rounds";
    default:
      return "round cap reached";
  }
}
