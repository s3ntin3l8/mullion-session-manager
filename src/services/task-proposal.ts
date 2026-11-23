import crypto from "node:crypto";

// Tasks ingested from an issue filed by this install's own GitHub App bot are
// "proposed": a human must approve them before they can run (see
// task-watcher.ts's upsertIssueTask). Approval pins what the human saw.

export type ProposalState = "proposed" | "approved";

/** True while a task must not start: still waiting for Approve, or approved and
 * since edited (title/body no longer what the human saw). */
export function proposalBlocksRun(t: {
  proposalState: string | null;
  approvedBodySha: string | null;
  title: string;
  body: string | null;
}): boolean {
  // Fail closed: the column is free text, so anything but null (an ordinary
  // task) or an "approved" whose pin still matches must not run.
  if (t.proposalState === null) return false;
  if (t.proposalState === "approved") {
    return t.approvedBodySha !== proposalContentSha(t.title, t.body);
  }
  return true;
}

/** The pin: title and body are both what a worker is prompted with. */
export function proposalContentSha(title: string, body: string | null | undefined): string {
  return crypto
    .createHash("sha256")
    .update(`${title}\n\u0000\n${body ?? ""}`)
    .digest("hex");
}
