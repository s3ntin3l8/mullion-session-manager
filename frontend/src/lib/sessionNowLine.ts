// Sidebar declutter — replaces SessionRow's old always-on `eventLine` (the
// latest describable NotificationEvent, however stale or content-free) with
// one line that picks the single most relevant thing to say about a session
// RIGHT NOW: what's blocking it, what it's working on, or — once idle — what
// it just said. History (subagents, files, git) moves behind the row's
// details toggle; see Sidebar.tsx's SessionRow and session-row/Details.tsx.
import type { NotificationEvent, Session } from "../api/index.js";
import { describeEvent, latestFileContext, latestTitleContext } from "../eventDescriptions.js";
import { formatRelativeAge } from "../relativeTime.js";
import {
  formatStatusLabel,
  STATUS_PRESENTATION,
  type StatusPresentation,
} from "../sessionStatus.js";

export interface NowLine {
  tone: "attention" | "working" | "idle";
  text: string;
  suffix: string | null;
}

// Tones whose severity is "the agent is blocked, failed, or waiting on a
// byte-heuristic guess" (session-status.ts's SEVERITY_BY_STATUS: blocked/
// failed/waiting) — deliberately NOT "finished" (severity "done"): a
// completed turn isn't something blocking the user's attention the same way,
// and gets the idle-tone "said" treatment in rule 3 below instead. Matching
// against STATUS_PRESENTATION's own tone vocabulary (not re-deriving a
// boolean from sessionStatusAttentionRequired, which lumps "done" in with
// these) is what keeps this in sync with Sidebar.tsx's dot/label rendering
// for free.
const ATTENTION_TONES = new Set<StatusPresentation["tone"]>([
  "error",
  "permission",
  "plan",
  "attention",
]);

// The in-progress (or, absent one, pending) todo — sourced from the session's
// live `currentTodo` field (pty-manager.ts), not the event stream: the todo
// that started a long-running task can fall out of the events ring buffer
// (100 server-side/200 client-side, mostly title_change churn) while the
// task is still running, so re-deriving it from events the way
// eventDescriptions.ts's sessionContextMap does for the notification panel
// would go stale exactly when it matters most. Falls back to the last file
// touched when there's no todo at all.
function runningContext(session: Session, events: readonly NotificationEvent[]): string | null {
  if (session.currentTodo) return `▸ ${session.currentTodo.content}`;
  return latestFileContext(events);
}

function stripLeadingGlyph(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+\s*/u, "");
}

// The newest event describeEvent reports as attention-worthy — a backward
// scan filtered to attention:true only, unlike a plain "last describable
// event, of any kind" scan: a routine file_change/tool_done event newer
// than the actual attention signal would otherwise mask it.
function newestAttentionEvent(
  events: readonly NotificationEvent[],
): { text: string; generic?: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const described = describeEvent(events[i]);
    if (described?.attention) return described;
  }
  return null;
}

// Strips markdown noise a closing assistant message often opens with (a
// "## Summary" heading, a list marker, a code fence) so the now-line's idle
// quote reads as prose, not markup — same intent as this file's own
// stripLeadingGlyph for a terminal title, applied to a much chattier source.
function firstMeaningfulLine(message: string | null): string | null {
  if (!message) return null;
  let inFence = false;
  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) continue;
    const cleaned = line.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*]|\d+\.)\s+/, "");
    if (cleaned.length > 0) return cleaned;
  }
  return null;
}

/**
 * Derives SessionRow's single folded-state "now" line. Pure and presentation-
 * only — reads session/events fields, never mutates or re-derives status.
 * `label` is the row's own display title (SessionRow's `title`), used the
 * same way eventDescriptions.ts's sessionContextMap already does: to skip a
 * terminal title that just repeats it.
 */
export function deriveNowLine(
  session: Session,
  events: NotificationEvent[] | undefined,
  label: string | null,
): NowLine | null {
  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  const evts = events ?? [];

  if (presentation.tone === "exited") return null;

  if (ATTENTION_TONES.has(presentation.tone)) {
    const described = newestAttentionEvent(evts);
    let text: string;
    if (described) {
      const context = described.generic ? runningContext(session, evts) : null;
      text = context ?? described.text;
    } else {
      text = formatStatusLabel(presentation, session.sessionStatusDetail);
    }
    return { tone: "attention", text: `⚠ ${text}`, suffix: null };
  }

  if (presentation.tone === "working") {
    const agentCount = session.subagentCount;
    const bgCount = session.outstandingBackgroundTasks.length;
    const suffixParts: string[] = [];
    if (agentCount > 0) suffixParts.push(`${agentCount} agent${agentCount === 1 ? "" : "s"}`);
    if (bgCount > 0) suffixParts.push(`${bgCount} bg`);
    const suffix = suffixParts.length > 0 ? suffixParts.join(" · ") : null;

    const context = runningContext(session, evts);
    if (context) return { tone: "working", text: context, suffix };
    if (agentCount > 0) {
      return {
        tone: "working",
        text: `◐ ${agentCount} agent${agentCount === 1 ? "" : "s"} running`,
        suffix: bgCount > 0 ? `${bgCount} bg` : null,
      };
    }
    // Terminal title is never used for a hooked session — Claude's own title
    // is just the session name plus a spinner glyph, which would only echo
    // the row's own title back. A hookless session (codex/agy without hook
    // support, or an unwrapped shell command) has no richer signal at all,
    // so the title is the best available — stripped of its leading glyph and
    // skipped if it's just the row's own label, same guard
    // eventDescriptions.ts's sessionContextMap applies for its own title
    // fallback.
    if (session.hookEmits.length === 0) {
      const title = latestTitleContext(evts, label);
      if (title) return { tone: "working", text: stripLeadingGlyph(title), suffix };
    }
    return null;
  }

  // Remaining tones: "finished" and "idle" — the agent's turn is over.
  const said = firstMeaningfulLine(session.lastAssistantMessage);
  if (said) {
    const endedAt = session.lastTurnEndedAt ?? session.lastActivityAt;
    return { tone: "idle", text: `"${said}"`, suffix: endedAt ? formatRelativeAge(endedAt) : null };
  }
  const context = runningContext(session, evts);
  if (context) return { tone: "idle", text: context, suffix: null };
  return null;
}
