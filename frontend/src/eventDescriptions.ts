import type { NotificationEvent } from "./api.js";

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
// events stream also carries title_change (fires on every OSC title
// update), alt-screen status_change (fires on every TUI open/close), and
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
export function notifyKind(event: NotificationEvent): "attention" | "exited" | null {
  if (event.kind === "attention" && event.payload.attention === true) return "attention";
  if (event.kind === "status_change" && event.payload.reason === "exited") return "exited";
  if (event.kind === "review_gate" && event.payload.state === "waiting") return "attention";
  if (event.kind === "permission_request") return "attention";
  if (event.kind === "stop_failure") return "attention";
  if (event.kind === "tool_failure") return "attention";
  if (event.kind === "plan_ready") return "attention";
  // Rich statuses (issue: extend surfaced session statuses) — promote_request
  // was missing from this set entirely (issue #271 predates this list's most
  // recent update); elicitation only counts while it's actually pending
  // ("finished" doesn't need a fresh notification of its own).
  if (event.kind === "promote_request") return "attention";
  if (event.kind === "elicitation" && event.payload.state === "started") return "attention";
  if (event.kind === "question" && event.payload.state === "started") return "attention";
  // Issue #404 — only the initial "pending a decision" event (no `state`
  // yet) counts as a notification; the accepted/dismissed follow-up events
  // are routine history, same as review_gate's "waiting"-only check above.
  if (event.kind === "dev_server_detected" && event.payload.state === undefined) return "attention";
  return null;
}
