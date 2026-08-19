import type { NotificationEvent } from "./api/index.js";

// Issue #428 — mirrors src/services/background-tasks.ts's TERMINAL_STATUSES
// set. Duplicated rather than imported: this is a separate npm workspace
// with no access to backend modules (same posture as SessionStatus's own
// hand-mirrored union in api.ts). Only used here, for the timeline's raw
// hook-payload count — the authoritative outstanding count Sidebar Row 6
// renders comes from the backend's own filtered
// SessionInfo.outstandingBackgroundTasks, not this duplicate.
const TERMINAL_BACKGROUND_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
  "cancelled",
  "canceled",
  "error",
  "timed_out",
  "succeeded",
  "done",
]);

function countOutstandingBackgroundTasksInPayload(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((t) => {
    const status =
      t && typeof t === "object" && typeof (t as { status?: unknown }).status === "string"
        ? (t as { status: string }).status.trim().toLowerCase()
        : null;
    return status === null || !TERMINAL_BACKGROUND_TASK_STATUSES.has(status);
  }).length;
}

// Shared kind/payload interpretation for Phase 1's notification event model
// (issue #166) — the one place that turns a raw `NotificationEvent` into
// human text, an unread-worthiness classification, or both. Originally lived
// split across Sidebar.tsx (describeEvent/describeLatestEvent, issue #167)
// and PaneTab.tsx (notifyKind, issue #168); pulled out here for #169 so the
// notification panel can reuse the exact same rules instead of a third,
// possibly-drifting copy. Mirrors pty-manager.ts's emitEvent() call sites
// 1:1 (payload shapes there are the source of truth) — update this
// alongside any new kind/payload field.

// Single-event description: human text plus whether it should get the
// "attention" color treatment. Returns null when this specific event's
// kind/shape isn't one this has been taught about yet (a future payload
// change, or a kind this hasn't been taught).
//
// Parameter is `Pick<NotificationEvent, "kind" | "payload">`, not the full
// type — this function never reads `seq`/`sessionId`/`ts` (verified: grep
// this file). That's what lets frontend/src/eventHistory.ts's TimelineEvent
// (issue #213, roadmap 4.7 — sessionId widened to `number | null` for a
// persisted-history row) pass through here without a cast: TimelineEvent's
// kind/payload already match NotificationEvent's exactly, so only the
// fields this function actually needs have to line up.
export function describeEvent(
  event: Pick<NotificationEvent, "kind" | "payload">,
): { text: string; attention: boolean } | null {
  switch (event.kind) {
    case "attention": {
      if (event.payload.attention !== true) {
        // The state machine's own "clear" emit (attention-detect.ts) — no
        // longer needs attention, but still worth surfacing as the latest
        // event rather than reverting to "nothing to show".
        return { text: "No longer needs attention", attention: false };
      }
      switch (event.payload.signal) {
        case "bell":
          return { text: "Bell", attention: true };
        case "titleIdle":
          return { text: "Finished — needs input", attention: true };
        case "altScreenExit":
          return { text: "Exited full-screen — needs input", attention: true };
        case "silence":
          return { text: "Gone quiet — needs input", attention: true };
        case "notification":
          return { text: "Sent a notification", attention: true };
        case "hookNotification": {
          // Phase 2 (issue #176) — a hook `notification` message, unlike the
          // PTY-parsed OSC 9/777 signal above, carries real title/body text
          // (see pty-manager.ts's Session.emitHookEvent); show it when present.
          const title = typeof event.payload.title === "string" ? event.payload.title : null;
          const body = typeof event.payload.body === "string" ? event.payload.body : null;
          if (title && body) return { text: `${title} — ${body}`, attention: true };
          // `||`, not `??`: an empty-string title (falsy but non-null) must
          // also fall through to the generic message, not render as blank text.
          return { text: title || "Sent a notification", attention: true };
        }
        case "reviewGate": {
          // Phase 2 (issue #176) — the attention-flip half of a review_gate
          // "waiting" message; the "review_gate" case below describes the
          // paired event carrying the full gate state.
          const prompt = typeof event.payload.prompt === "string" ? event.payload.prompt : null;
          return {
            text: prompt ? `Waiting for review: ${prompt}` : "Waiting for review",
            attention: true,
          };
        }
        // Rich statuses (issue: extend surfaced session statuses) — these
        // four attention signal kinds existed since PR #300/#301 but this
        // switch had no dedicated case for any of them, so they all fell
        // through to the generic "Needs input" default below even though
        // each carries a more specific meaning (and, for
        // promoteRequest/permissionRequest/planReady, its own extras —
        // see Session.emitAttentionSignalWithExtras call sites in
        // pty-manager.ts for the payload shape each one carries).
        case "agentIdle":
          // The agent's own hook-confirmed "turn is over" signal — mirrors
          // sessionStatus.ts's "finished" status text.
          return { text: "Finished", attention: true };
        case "promoteRequest": {
          const summary = typeof event.payload.summary === "string" ? event.payload.summary : null;
          return {
            text: summary
              ? `Requested worktree promotion: ${summary}`
              : "Requested worktree promotion",
            attention: true,
          };
        }
        case "permissionRequest": {
          const summary = typeof event.payload.summary === "string" ? event.payload.summary : null;
          return {
            text: summary ? `Needs permission: ${summary}` : "Needs permission",
            attention: true,
          };
        }
        case "planReady": {
          const summary = typeof event.payload.summary === "string" ? event.payload.summary : null;
          return {
            text: summary ? `Plan ready: ${summary}` : "Plan ready for review",
            attention: true,
          };
        }
        case "elicitation": {
          const server = typeof event.payload.server === "string" ? event.payload.server : null;
          return {
            text: server ? `Needs input (MCP: ${server})` : "Needs input (MCP)",
            attention: true,
          };
        }
        // Making notifications relevant/scannable — this case was simply
        // missing: an opencode `question.asked` hook raises the `question`
        // attention signal (hook-handlers.ts) carrying a `header`, but this
        // switch had no case for it, so it silently fell through to the
        // generic "Needs input" default below. Mirrors `elicitation` just
        // above (same shape: an MCP-style "the agent needs a decision from
        // you" signal, just from opencode's own `question` tool instead of
        // an MCP server). Load-bearing for the severity/notifyKind cleanup
        // below, which now relies on the `attention` event (not the
        // `question` NotificationEvent kind) as `question`'s sole notifiable
        // representation — degrading to "Needs input" here would have been
        // the only visible text left for it.
        case "question": {
          const header = typeof event.payload.header === "string" ? event.payload.header : null;
          return {
            text: header ? `Needs answer: ${header}` : "Needs answer",
            attention: true,
          };
        }
        // Fix: sticky needs_input — stop_failure/tool_failure now raise
        // apiError/toolFailure instead of the generic hookNotification (see
        // src/services/hook-handlers.ts), so without these two cases the
        // feed would silently regress from "Tool failed: Bash — Exit code
        // 2…" to a bare "Needs input" via the default branch below. Same
        // `${title} — ${body}` formatting as hookNotification above, same
        // extras shape (Session.emitAttentionSignalWithExtras call sites).
        case "toolFailure":
        case "apiError": {
          const title = typeof event.payload.title === "string" ? event.payload.title : null;
          const body = typeof event.payload.body === "string" ? event.payload.body : null;
          if (title && body) return { text: `${title} — ${body}`, attention: true };
          return { text: title || "Needs input", attention: true };
        }
        default:
          // A future signal kind this hasn't been taught yet.
          return { text: "Needs input", attention: true };
      }
    }
    case "status_change": {
      if (event.payload.reason === "exited") return { text: "Exited", attention: false };
      if (event.payload.screen === "alt") {
        return { text: "Entered full-screen mode", attention: false };
      }
      if (event.payload.screen === "primary") {
        return { text: "Exited full-screen mode", attention: false };
      }
      // Phase 2 (issue #176) — a hook `progress` message maps to
      // status_change with a `phase` field (see pty-manager.ts's
      // Session.emitHookEvent); routine, not attention-worthy. `detail`
      // (issue #321 — opencode's retry backoff) is free-text phase context,
      // appended the same way permission/plan summaries are elsewhere in
      // this file.
      if (typeof event.payload.phase === "string") {
        // `?? ` (nullish coalescing) only skips null/undefined, not an
        // empty string — normalizing "" to null here up front is what lets
        // the fallback below actually take over for a message that reports
        // an empty `detail` alongside a non-empty `backgroundTasks` (issue
        // #428, Hermes review on PR #453).
        const detail =
          typeof event.payload.detail === "string" && event.payload.detail.length > 0
            ? event.payload.detail
            : null;
        // Issue #428 — a `progress`/"done" (Stop) message can carry
        // `backgroundTasks`; append its outstanding count the same way
        // `detail` is appended above, so "Agent: done" doesn't silently
        // look identical to a Stop that still has background work running.
        // Filtered to non-terminal entries (not the raw array length) to
        // match what Sidebar Row 6 actually shows.
        const outstandingCount = countOutstandingBackgroundTasksInPayload(
          event.payload.backgroundTasks,
        );
        const suffix =
          detail ??
          (outstandingCount > 0
            ? `${outstandingCount} background task${outstandingCount === 1 ? "" : "s"}`
            : null);
        return {
          text: suffix
            ? `Agent: ${event.payload.phase}: ${suffix}`
            : `Agent: ${event.payload.phase}`,
          attention: false,
        };
      }
      // Phase 5 (Track A) — a "subagent" hook maps to status_change with a
      // `subagentState` field (see pty-manager.ts's Session.emitHookEvent);
      // named distinctly from the stale-blocked-clear branch's own
      // `state: "subagentCount"` so the two don't collide on one key.
      // Routine, not attention-worthy — same posture as `phase` above.
      if (event.payload.subagentState === "started" || event.payload.subagentState === "finished") {
        const agentType =
          typeof event.payload.agentType === "string" ? event.payload.agentType : null;
        const verb = event.payload.subagentState === "started" ? "started" : "finished";
        return {
          text: agentType ? `Subagent ${verb}: ${agentType}` : `Subagent ${verb}`,
          attention: false,
        };
      }
      return null;
    }
    case "title_change":
      return typeof event.payload.title === "string"
        ? { text: event.payload.title, attention: false }
        : null;
    // Phase 2 (issue #176) — the two kinds sourced from the structured hook
    // channel rather than PTY parsing (see pty-manager.ts's
    // Session.emitHookEvent for the payload shapes these mirror).
    case "file_change": {
      const path = typeof event.payload.path === "string" ? event.payload.path : null;
      if (!path) return null;
      const verb =
        event.payload.action === "create"
          ? "Created"
          : event.payload.action === "delete"
            ? "Deleted"
            : "Changed";
      return { text: `${verb} ${path}`, attention: false };
    }
    case "review_gate": {
      const prompt = typeof event.payload.prompt === "string" ? event.payload.prompt : null;
      if (event.payload.state === "waiting") {
        return {
          text: prompt ? `Waiting for review: ${prompt}` : "Waiting for review",
          attention: true,
        };
      }
      if (event.payload.state === "approved") return { text: "Review approved", attention: false };
      if (event.payload.state === "denied") return { text: "Review denied", attention: false };
      return null;
    }
    case "permission_request": {
      const tool = typeof event.payload.tool === "string" ? event.payload.tool : null;
      const summary = typeof event.payload.summary === "string" ? event.payload.summary : null;
      if (tool && summary) return { text: `Needs permission: ${summary}`, attention: true };
      return { text: "Needs permission", attention: true };
    }
    case "stop_failure": {
      const error = typeof event.payload.error === "string" ? event.payload.error : null;
      return { text: error ? `API error: ${error}` : "API error", attention: true };
    }
    case "tool_failure": {
      const tool = typeof event.payload.tool === "string" ? event.payload.tool : null;
      const error = typeof event.payload.error === "string" ? event.payload.error : null;
      const parts = [tool, error].filter(Boolean);
      return {
        text: parts.length ? `Tool failed: ${parts.join(" — ")}` : "Tool failed",
        attention: true,
      };
    }
    case "session_end": {
      const reason = typeof event.payload.reason === "string" ? event.payload.reason : null;
      return { text: reason ? `Session ended: ${reason}` : "Session ended", attention: false };
    }
    case "plan_ready": {
      return { text: "Plan ready for review", attention: true };
    }
    // Rich statuses (issue: extend surfaced session statuses) — was missing
    // entirely: pty-manager.ts's Session.emitHookEvent has emitted a
    // dedicated "promote_request" NotificationEvent since issue #271, but
    // this switch never grew a case for it, so it silently described as
    // nothing (describeLatestEvent falls back to an earlier event, or null).
    case "promote_request": {
      const summary = typeof event.payload.summary === "string" ? event.payload.summary : null;
      return {
        text: summary ? `Requested worktree promotion: ${summary}` : "Requested worktree promotion",
        attention: true,
      };
    }
    case "elicitation": {
      const server = typeof event.payload.server === "string" ? event.payload.server : null;
      if (event.payload.state === "started") {
        return {
          text: server ? `Needs input (MCP: ${server})` : "Needs input (MCP)",
          attention: true,
        };
      }
      return { text: "MCP input resolved", attention: false };
    }
    // OpenCode v2 events: question, todo, session_diff.
    case "question": {
      if (event.payload.state === "started") {
        const header = typeof event.payload.header === "string" ? event.payload.header : null;
        return {
          text: header ? `Needs answer: ${header}` : "Needs answer",
          attention: true,
        };
      }
      return { text: "Question answered", attention: false };
    }
    case "todo": {
      const content = typeof event.payload.content === "string" ? event.payload.content : null;
      const status = typeof event.payload.status === "string" ? event.payload.status : null;
      if (content && status) return { text: `Todo: ${content} (${status})`, attention: false };
      return { text: "Todo updated", attention: false };
    }
    case "session_diff": {
      const files = event.payload.files;
      if (Array.isArray(files) && files.length > 0) {
        const changed = files.length === 1 ? files[0].file : `${files.length} files`;
        return { text: `Changed: ${changed}`, attention: false };
      }
      return { text: "Session diff", attention: false };
    }
    // Issue #404 — a background-detected dev server in a plain (non-dock)
    // session; see pty-manager.ts's Session.detectDevServerPort/
    // acceptDevServerPort/dismissDevServerPort for the three payload shapes
    // this mirrors (no `state` yet == pending; "accepted"/"dismissed" once
    // resolved).
    case "dev_server_detected": {
      const port = typeof event.payload.port === "string" ? event.payload.port : null;
      if (event.payload.state === "accepted") {
        return {
          text: port
            ? `Dev server on port ${port} wired to preview`
            : "Dev server wired to preview",
          attention: false,
        };
      }
      if (event.payload.state === "dismissed") {
        return {
          text: port ? `Dismissed dev server on port ${port}` : "Dismissed dev server detection",
          attention: false,
        };
      }
      return {
        text: port ? `Detected dev server on port ${port}` : "Detected a dev server",
        attention: true,
      };
    }
    default:
      return null;
  }
}

// Issue #167's per-session status line — turns the most recent describable
// NotificationEvent for a session into a short, human-readable string plus
// whether it should get the "attention" color treatment. Walks backward
// from the newest event rather than only looking at the very last one: a
// top event whose kind/shape describeEvent doesn't recognize (a future
// payload change, or a kind this hasn't been taught about) shouldn't blank
// the line when an earlier, still-relevant event (e.g. the last title
// change) can still describe it — last-known-good is more useful than
// nothing. Returns null only when NO buffered event describes (including
// the empty/undefined case), so SessionRow can render no line at all.
export function describeLatestEvent(
  events: NotificationEvent[] | undefined,
): { text: string; attention: boolean } | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const described = describeEvent(events[i]);
    if (described) return described;
  }
  return null;
}

// Which of a session's buffered NotificationEvents count as an actual
// "notification" rather than routine chatter, and which icon that gets.
// Deliberately narrower than "every event with a describeEvent result": the
// events stream also carries title_change (A1 — debounced at the source in
// pty-manager.ts, but still fires roughly every few seconds for an
// actively-working agent's TUI, e.g. spinner/elapsed-time title churn),
// alt-screen status_change (fires on every TUI open/close), and
// (Phase 2) file_change (fires on every reported edit) — all routine,
// high-frequency, and not what a user means by "notification". A hook
// `notification` message already counts via the existing "attention" kind
// check below (see pty-manager.ts's Session.emitHookEvent, which emits it
// under kind "attention" just like every PTY-parsed signal); `review_gate`
// in state "waiting" is the one Phase 2 addition that needs its own check
// here, since it's its own NotificationEvent kind, not folded into
// "attention". Used by PaneTab.tsx's unread tab badge (issue #168) and
// NotificationBell.tsx's event feed + unread bell count (issue #169) — both
// must agree on this set, or the panel and the tab badges it's meant to
// summarize could disagree.
//
// Making notifications relevant/scannable — shorter than it used to be.
// `permission_request`, `stop_failure`, `tool_failure`, `plan_ready`,
// `promote_request`, `elicitation` (started), and `question` (started) are
// gone: every one of those NotificationEvent kinds is always accompanied by
// a paired `attention` event carrying the same information (see
// src/services/hook-handlers.ts's raise sites), which the first check below
// already matches — keeping both meant this function (and everything built
// on it: the bell feed, the unread badge, desktop notifications) counted
// each one twice. `promote_request` was worse than redundant: its OTHER
// raise site (pty-manager.ts's Session.resolvePromote) fires with NO paired
// attention signal at all, carrying `{state: "accepted"|"declined"}` — a
// RESOLUTION record, not a request — so the old unconditional check here
// was firing a bogus notification every time a promote was resolved, not
// just when one was requested. Dropping the kind removes that for free.
//
// Parameter is `Pick<NotificationEvent, "kind" | "payload">`, not the full
// type — same reasoning as describeEvent's own doc comment above: this
// function never reads `seq`/`sessionId`/`ts`, which is what lets
// SessionTimeline.tsx's widened `TimelineEvent` (sessionId: number | null,
// for a persisted-history row whose session may since have been deleted)
// pass through here — and to notifySeverity/notifyLabel below, which share
// this same narrowing for the same reason — without a cast.
export function notifyKind(
  event: Pick<NotificationEvent, "kind" | "payload">,
): "attention" | "exited" | null {
  if (event.kind === "attention" && event.payload.attention === true) return "attention";
  if (event.kind === "status_change" && event.payload.reason === "exited") return "exited";
  if (event.kind === "review_gate" && event.payload.state === "waiting") return "attention";
  // Issue #404 — only the initial "pending a decision" event (no `state`
  // yet) counts as a notification; the accepted/dismissed follow-up events
  // are routine history, same as review_gate's "waiting"-only check above.
  // No paired `attention` signal exists for this kind (see
  // useAttentionNotifications.ts's own explicit skip), so it stays here.
  if (event.kind === "dev_server_detected" && event.payload.state === undefined) return "attention";
  return null;
}

// Making notifications relevant/scannable — a finer-grained classification
// than notifyKind's binary "attention"/"exited", used by NotificationBell.tsx
// (row icon/color) and SessionTimeline.tsx (row color + paired-row
// suppression), NOT by notifyKind's own consumers (PaneTab's tab badge,
// desktopNotify.ts) — those stay on the coarser attention/exited split
// deliberately, since a tab badge only has room for one bell-or-check
// distinction, not three tiers.
//
// - "blocked": the agent is explicitly waiting on a human DECISION —
//   mirrors attention-detect.ts's OUTPUT_IMMUNE_KINDS (a cosmetic repaint
//   must not look like resolution) plus hookNotification, which is
//   deliberately immune for the same reason without being one of the
//   per-state latches that set owns.
// - "error": turbulence the agent's own next turn typically resolves on its
//   own (attention-detect.ts's PENDING_OUTPUT_CANCELS-equivalent — the
//   agent's own next output chunk cancels these before they even confirm,
//   see attention-tracker.ts's ATTENTION_SETTLE_MS).
// - "done": informational — a turn ended, or the byte-parsed heuristics
//   (bell/title/silence/...), or the process exited. None of these are
//   "something is broken" or "something needs a decision".
export type NotifySeverity = "blocked" | "error" | "done";

const BLOCKED_SIGNALS = new Set([
  "permissionRequest",
  "planReady",
  "reviewGate",
  "promoteRequest",
  "elicitation",
  "question",
  "hookNotification",
]);

const ERROR_SIGNALS = new Set(["toolFailure", "apiError"]);

// Signal -> the specific NotificationEvent kind it's paired with, where one
// exists. SessionTimeline.tsx uses this to suppress the generic `attention`
// row when the specific-kind row (which carries the same information, via a
// different describeEvent branch) already covers it — see that component's
// own comment for why a text-based fold can't do this instead. `null`/absent
// means the signal has no paired kind at all (the byte-parsed signals, plus
// agentIdle, which is attention-only by construction).
export const SIGNAL_TO_EVENT_KIND: Partial<Record<string, NotificationEvent["kind"]>> = {
  reviewGate: "review_gate",
  promoteRequest: "promote_request",
  permissionRequest: "permission_request",
  planReady: "plan_ready",
  elicitation: "elicitation",
  question: "question",
  toolFailure: "tool_failure",
  apiError: "stop_failure",
};

/** Severity tier for a notify-worthy event, or null for anything
 * notifyKind() itself wouldn't count (routine chatter). Reads
 * `payload.signal` for `kind === "attention"` (the SAME field describeEvent's
 * own switch keys off of) rather than `event.kind`, so it stays correct
 * post-settle-window: the four deferred kinds (attention-tracker.ts's
 * ATTENTION_SETTLE_MS) now arrive ONLY as an `attention` event — their own
 * specific NotificationEvent kind (permission_request) is emitted alongside
 * it (or, for tool_failure/stop_failure, was already emitted immediately)
 * but this function doesn't need to special-case that: `notifyKind` already
 * classifies both as "attention", and SIGNAL_TO_EVENT_KIND above is what
 * lets the timeline avoid double-counting them. */
export function notifySeverity(
  event: Pick<NotificationEvent, "kind" | "payload">,
): NotifySeverity | null {
  if (notifyKind(event) === null) return null;
  // Neither has a `payload.signal` of its own — special-cased ahead of the
  // signal read below, which would otherwise fall through to "done" for
  // both (wrong: each represents a decision genuinely pending on the user,
  // not routine completion). `status_change`'s "exited" case has no such
  // special case: it correctly falls through to "done" via `signal === null`
  // below, same tier a `bell`/`silence`/etc. attention event gets.
  if (event.kind === "dev_server_detected" || event.kind === "review_gate") return "blocked";
  const signal = typeof event.payload.signal === "string" ? event.payload.signal : null;
  if (signal === null) return "done";
  if (BLOCKED_SIGNALS.has(signal)) return "blocked";
  if (ERROR_SIGNALS.has(signal)) return "error";
  return "done";
}

// Short kind label for the bell/timeline's pill — for an `attention` event,
// keyed by its SIGNAL (not its `kind`, which is always the generic
// "attention"), so a permission reads "Permission" not "Attention". Values
// deliberately match KIND_LABELS below where a signal has a paired
// NotificationEvent kind (SIGNAL_TO_EVENT_KIND), so a row doesn't read
// differently depending on whether it arrived as the specific-kind event or
// the paired attention event.
export const SIGNAL_LABELS: Record<string, string> = {
  bell: "Bell",
  notification: "Notification",
  titleIdle: "Idle",
  altScreenExit: "Screen",
  silence: "Silence",
  hookNotification: "Notification",
  reviewGate: "Review",
  agentIdle: "Finished",
  promoteRequest: "Promote",
  permissionRequest: "Permission",
  planReady: "Plan",
  elicitation: "Elicitation",
  question: "Question",
  toolFailure: "Tool",
  apiError: "API Error",
};

/** The kind pill's label for any notify-worthy event — an `attention` event
 * labels by its signal (SIGNAL_LABELS), everything else by its own kind
 * (KIND_LABELS). Falls back to "Notification" for a shape neither table
 * covers (a future signal/kind this hasn't been taught yet) rather than
 * rendering a blank pill. */
export function notifyLabel(event: Pick<NotificationEvent, "kind" | "payload">): string {
  if (event.kind === "attention") {
    const signal = typeof event.payload.signal === "string" ? event.payload.signal : null;
    return (signal !== null ? SIGNAL_LABELS[signal] : undefined) ?? "Notification";
  }
  return KIND_LABELS[event.kind] ?? "Notification";
}

// Moved from frontend/src/eventHistory.ts (making notifications relevant/
// scannable) so NotificationBell.tsx's kind pill and SessionTimeline.tsx's
// filter chips share one label vocabulary instead of two that could drift.
// Safe direction: eventHistory.ts already has no consumers importing FROM
// this module in a way that would cycle back here (it only imports
// NotificationEvent/StoredEventRow types from api/index.ts) — see that
// file's own re-export of these two for why its consumers don't need to
// change their import path.
export const KIND_LABELS: Record<NotificationEvent["kind"], string> = {
  attention: "Attention",
  status_change: "Status",
  title_change: "Title",
  file_change: "Files",
  review_gate: "Review",
  promote_request: "Promote",
  permission_request: "Permission",
  stop_failure: "Stop",
  tool_failure: "Tool",
  session_end: "Exit",
  plan_ready: "Plan",
  // Rich statuses (issue: extend surfaced session statuses).
  elicitation: "Elicitation",
  // OpenCode v2 events.
  question: "Question",
  todo: "Todo",
  session_diff: "Diff",
  // Issue #404.
  dev_server_detected: "Dev Server",
};

export const ALL_KINDS = Object.keys(KIND_LABELS) as NotificationEvent["kind"][];

export interface UnreadEventSummary {
  count: number;
  // Bell wins over check when both are present — attention is the
  // higher-priority signal (matches PaneTab's own status-badge priority).
  kind: "attention" | "exited" | null;
}

// Shared by PaneTab.tsx's own tab badge and App.tsx's mobile pane bar (issue
// #168 / mobile UI overhaul, PR #613 Hermes review) — the identical "events
// newer than the read cursor, minus anything already dismissed from the
// notification panel, that classify as notify-worthy" derivation, previously
// duplicated verbatim in both places. Inlines the `sessionId:seq` key format
// directly rather than importing store.ts's own eventKey, so this leaf util
// module doesn't pull store.ts's whole import graph into every consumer.
export function unreadEventSummary(
  sessionId: number,
  events: NotificationEvent[] | undefined,
  lastSeenSeq: number,
  dismissedEventKeys: Record<string, true>,
): UnreadEventSummary {
  const kinds = (events ?? [])
    .filter((e) => e.seq > lastSeenSeq && !dismissedEventKeys[`${sessionId}:${e.seq}`])
    .map(notifyKind)
    .filter((k): k is "attention" | "exited" => k !== null);
  return {
    count: kinds.length,
    kind: kinds.includes("attention") ? "attention" : kinds.length > 0 ? "exited" : null,
  };
}
