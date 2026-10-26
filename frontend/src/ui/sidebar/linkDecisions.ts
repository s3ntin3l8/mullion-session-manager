import type { Session, SessionSeverity } from "../../api/index.js";
import type { MullionLinkEntry, SessionLink } from "../../hooks/useMullionLinks.js";
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
  // An entry can hold several sessions (an issue-branch one plus its task's);
  // a live process beats an exited pane that merely sorts first.
  const first = entry?.sessions.find((l) => l.session.alive) ?? entry?.sessions[0];
  return first ? { kind: "open-existing", sessionId: first.session.id } : { kind: "start" };
}

/**
 * The linked sessions (children included) held at Mullion's review gate — the
 * session status, not a task state (#2019). Shared so a PR row and its detail
 * card agree on whether the gate is holding the PR.
 */
export function gatedSessions(links: readonly SessionLink[] | undefined): Session[] {
  const out: Session[] = [];
  const walk = (ls: readonly SessionLink[]) => {
    for (const l of ls) {
      if (l.session.sessionStatus === "awaiting_review_gate") out.push(l.session);
      walk(l.children);
    }
  };
  walk(links ?? []);
  return out;
}

/** Task status → the kit's tone; shared so every task chip agrees. */
export function taskTone(status: string): Tone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "reviewing":
      return "warn";
    case "claimed":
    case "in_progress":
      return "info";
    default:
      return "neutral";
  }
}
