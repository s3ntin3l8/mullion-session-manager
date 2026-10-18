export type DotClass = "good" | "bad" | "pending" | "none";

const SKIPPED_CONCLUSIONS = new Set(["skipped", "cancelled", "neutral"]);

export function checkDotClass(status: string, conclusion: string | null): DotClass {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "good";
  if (conclusion != null && SKIPPED_CONCLUSIONS.has(conclusion)) return "none";
  return "bad";
}
