import type { SessionSeverity } from "../../api/index.js";
import type { MullionLinkEntry } from "../../hooks/useMullionLinks.js";
import type { Tone } from "../../lib/statusTone.js";

/** Severity → the sidebar kit's one tone vocabulary (dot colour). */
export function severityTone(severity: SessionSeverity): Tone {
  switch (severity) {
    case "failed":
      return "danger";
    case "blocked":
    case "waiting":
      return "warn";
    case "busy":
      return "info";
    case "done":
      return "success";
    case "gone":
    case "dormant":
      return "neutral";
  }
}

export type SessionAction = { kind: "open-existing"; sessionId: number } | { kind: "start" };
/** One decision for "Open session" / "Hand off": reuse a live session, else start. */
export function decideSessionAction(entry: MullionLinkEntry | undefined): SessionAction {
  const first = entry?.sessions[0];
  return first ? { kind: "open-existing", sessionId: first.session.id } : { kind: "start" };
}
