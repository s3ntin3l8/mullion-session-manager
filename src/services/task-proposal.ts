import crypto from "node:crypto";

// Tasks ingested from an issue filed by this install's own GitHub App bot are
// "proposed": a human must approve them before they can run (see
// task-watcher.ts's upsertIssueTask). Approval pins what the human saw.

export type ProposalState = "proposed" | "approved";

/** The pin: title and body are both what a worker is prompted with. */
export function proposalContentSha(title: string, body: string | null | undefined): string {
  return crypto
    .createHash("sha256")
    .update(`${title}\n\u0000\n${body ?? ""}`)
    .digest("hex");
}
