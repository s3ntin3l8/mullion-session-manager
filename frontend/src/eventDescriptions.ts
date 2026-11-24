import type { NotificationEvent } from "./api/index.js";
// The store's own dismissal-key format, imported rather than re-spelled: a
// second copy is how the tab badge drifted to a two-part key (#1427, #3458).
import { eventKey } from "./store/helpers.js";

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

// Code review (issue #903) — one canonical `file_change.action` -> verb
// table, read by both describeEvent's own "file_change" case (a standalone
// timeline sentence: "Changed src/x.ts") and sessionContextMap's (an inline
// fragment following a kind pill: "edited src/x.ts"). Each site needs its
// own casing, not the same string, so this can't just be a single shared
// text template — but a NEW `action` value (there are only "create"/
// "delete" today, defaulting to modify) only ever needs adding HERE, not
// independently to two hand-written ternaries that can silently drift out
// of wording sync with each other.
// Graphify review (issue #903) — a plain object literal here would be a
// classic prototype-pollution-via-bracket-lookup footgun: `action` is
// untrusted `unknown` at this point, and `FILE_CHANGE_VERBS["toString"]` (or
// "constructor"/"hasOwnProperty"/...) on a plain `{}` resolves to the
// INHERITED Object.prototype member — truthy, so the `||` fallback would
// never fire — rather than `undefined`. The caller would then read
// `.titleCase`/`.lower` off that function and silently render
// "undefined src/x.ts". hook-protocol.ts's validateFileChange constrains
// `action` to exactly "modify"|"create"|"delete" on the wire today, but the
// frontend has no way to enforce that guarantee holds for a persisted older
// event or a version-skewed remote host — same posture as
// firstChangedFileName's own doc comment just above. A `Map` has no
// prototype-chain lookup surface for `.get()`, so this class of bug is
// structurally impossible here rather than merely avoided by validation
// elsewhere.
const FILE_CHANGE_VERBS = new Map<string, { titleCase: string; lower: string }>([
  ["create", { titleCase: "Created", lower: "created" }],
  ["delete", { titleCase: "Deleted", lower: "deleted" }],
]);
const DEFAULT_FILE_CHANGE_VERB = { titleCase: "Changed", lower: "edited" };

function fileChangeVerb(action: unknown): { titleCase: string; lower: string } {
  if (typeof action !== "string") return DEFAULT_FILE_CHANGE_VERB;
  return FILE_CHANGE_VERBS.get(action) ?? DEFAULT_FILE_CHANGE_VERB;
}

// Graphify review (issue #903) — a `session_diff` NotificationEvent's
// `files[0]` is read defensively here even though the wire-level validator
// (src/services/hook-protocol.ts's validateSessionDiff) already guarantees
// every entry is a non-null object with a non-empty string `.file`: that
// guarantee holds for THIS backend's own validation today, but the frontend
// has no way to enforce it stays true across a version-skewed remote host or
// a persisted event replayed from an older backend build — every other field
// read in this file already treats `payload` as untrusted
// (`typeof x === "string"` guards throughout), and an unguarded
// `files[0].file` was the one place that didn't. Returns null (falls back to
// the plain-count text) rather than throwing on a malformed entry.
function firstChangedFileName(files: unknown[]): string | null {
  const first = files[0];
  if (
    first &&
    typeof first === "object" &&
    typeof (first as { file?: unknown }).file === "string"
  ) {
    return (first as { file: string }).file;
  }
  return null;
}

// Shared kind/payload interpretation for Phase 1's notification event model
// (issue #166) — the one place that turns a raw `NotificationEvent` into
// human text, an unread-worthiness classification, or both. Originally lived
// split across Sidebar.tsx (describeEvent, issue #167 — that file's own
// describeLatestEvent has since been removed, superseded by
// lib/sessionNowLine.ts's deriveNowLine) and PaneTab.tsx (notifyKind, issue
// #168); pulled out here for #169 so the
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
// The pr_* kinds (github-pr-poller.ts -> pr-session-events.ts) share one
// payload shape: number + title, plus `decision` / `added` where relevant.
function describePrEvent(event: Pick<NotificationEvent, "kind" | "payload">): {
  text: string;
  attention: boolean;
} {
  const n = typeof event.payload.number === "number" ? `#${event.payload.number}` : "PR";
  switch (event.kind) {
    case "pr_ci_failed":
      return { text: `${n}: CI failed`, attention: true };
    case "pr_ci_passed":
      return { text: `${n}: CI passed`, attention: false };
    case "pr_conflicts":
      return { text: `${n}: has merge conflicts`, attention: true };
    case "pr_merged":
      return { text: `${n} was merged`, attention: false };
    case "pr_new_comments": {
      const added = typeof event.payload.added === "number" ? event.payload.added : 0;
      return {
        text:
          added > 0
            ? `${n}: ${added} new comment${added === 1 ? "" : "s"}`
            : `${n}: new review threads`,
        attention: false,
      };
    }
    case "pr_review_submitted": {
      const changes = event.payload.decision === "CHANGES_REQUESTED";
      return {
        text: changes ? `${n}: changes requested` : `${n}: approved`,
        attention: changes,
      };
    }
    // A pr_* kind added to describeEvent's case list but not handled above
    // reads as a generic update rather than as someone else's wording.
    default:
      return { text: `${n}: updated`, attention: false };
  }
}

export function describeEvent(
  event: Pick<NotificationEvent, "kind" | "payload">,
): { text: string; attention: boolean; generic?: boolean } | null {
  switch (event.kind) {
    case "attention": {
      if (event.payload.attention !== true) {
        // The state machine's own "clear" emit (attention-detect.ts) — no
        // longer needs attention, but still worth surfacing as the latest
        // event rather than reverting to "nothing to show".
        return { text: "No longer needs attention", attention: false };
      }
      switch (event.payload.signal) {
        // Issue #903 — `generic: true` on every one of these marks the row
        // as content-free: the text says nothing about THIS session beyond
        // "something happened", which is exactly what NotificationBell.tsx's
        // sessionContextMap exists to fill in with what the session was
        // actually doing. A row whose own text already carries real content
        // (a permission summary, a question header, a plan summary, ...)
        // must never get `generic: true` — substituting context there would
        // LOSE information, not add it.
        case "bell":
          return { text: "Bell", attention: true, generic: true };
        case "titleIdle":
          return { text: "Finished — needs input", attention: true, generic: true };
        case "altScreenExit":
          return { text: "Exited full-screen — needs input", attention: true, generic: true };
        case "silence": {
          // Issue #1228 — the backend attaches this only for a hookless,
          // non-alt-screen session (pty-manager.ts's Session.tick(), gated
          // on !hooksActive && !inAltScreen) — a hooked agent session's
          // silence row keeps relying on sessionContextMap's richer
          // todo/file-change/diff context below instead, so the two
          // mechanisms never compete for the same row. Same
          // typeof-narrowing idiom as hookNotification's title/body read
          // just below, and the same `generic` rule this file's own header
          // comment states: real content must never carry `generic: true`,
          // or sessionContextMap would overwrite it.
          const context = typeof event.payload.context === "string" ? event.payload.context : null;
          if (context) return { text: `Gone quiet — ${context}`, attention: true };
          return { text: "Gone quiet — needs input", attention: true, generic: true };
        }
        case "notification":
          // The PTY-parsed OSC 9/777 signal — distinct from the hook-driven
          // "hookNotification" case below, and just as content-free (no
          // title/body ever reaches this one).
          return { text: "Sent a notification", attention: true, generic: true };
        case "hookNotification": {
          // Phase 2 (issue #176) — a hook `notification` message, unlike the
          // PTY-parsed OSC 9/777 signal above, carries real title/body text
          // (see pty-manager.ts's Session.emitHookEvent); show it when present.
          const title = typeof event.payload.title === "string" ? event.payload.title : null;
          const body = typeof event.payload.body === "string" ? event.payload.body : null;
          if (title && body) return { text: `${title} — ${body}`, attention: true };
          // Code review (issue #903) — a body-only message (empty/missing
          // title) is real content too, same as title-only; hook-protocol.ts's
          // validateNotification accepts an empty-string title with a
          // populated body, so this is a real wire state, not just a
          // type-level curiosity. `title || body` alone previously discarded
          // the body silently, which — once this case ALSO got `generic: true`
          // below for the true empty case — would have let sessionContextMap
          // substitute unrelated text over the top of a real message.
          if (title) return { text: title, attention: true };
          if (body) return { text: body, attention: true };
          // Neither title nor body — genuinely content-free.
          return { text: "Sent a notification", attention: true, generic: true };
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
          // sessionStatus.ts's "finished" status text. `generic: true` (#903)
          // — "Finished" alone says nothing about what finished.
          return { text: "Finished", attention: true, generic: true };
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
      if (event.payload.reason === "worker-not-started" && typeof event.payload.note === "string") {
        return { text: event.payload.note, attention: true };
      }
      if (event.payload.reason === "exited") return { text: "Exited", attention: false };
      if (event.payload.screen === "alt") {
        return { text: "Entered full-screen mode", attention: false };
      }
      if (event.payload.screen === "primary") {
        return { text: "Exited full-screen mode", attention: false };
      }
      // Issue #1735 — a turn a MACHINE injected is worth naming on the
      // timeline: it is not a human's turn, and it is exactly the thing that
      // used to trip the worker's turn-end latch MID-LOOP (advancing the
      // task to "reviewing" while the worker was still writing). The source
      // rides on the `status_change` the turn-start hook emits.
      //
      // `user` falls through to the `phase` branch below, which already
      // renders "Agent: generating" — the human case needs no extra words.
      const promptSource =
        typeof event.payload.promptSource === "string" ? event.payload.promptSource : null;
      if (promptSource !== null && promptSource !== "user") {
        const label = TURN_SOURCE_LABELS[promptSource] ?? promptSource;
        return { text: `Turn started: ${label}`, attention: false };
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
        // Issue #1230 — the agent's own last turn-ending message (Claude
        // Code's Stop hook always carried this; codex's Stop hook does too,
        // just wasn't forwarded until this issue). Lowest-priority fallback:
        // `detail` and the background-task count above are both more
        // specific, deliberately-set context for a particular phase, and a
        // "done" message won't usually carry more than one of the three.
        const lastAssistantMessage =
          typeof event.payload.lastAssistantMessage === "string" &&
          event.payload.lastAssistantMessage.length > 0
            ? event.payload.lastAssistantMessage
            : null;
        const suffix =
          detail ??
          (outstandingCount > 0
            ? `${outstandingCount} background task${outstandingCount === 1 ? "" : "s"}`
            : null) ??
          lastAssistantMessage;
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
      const verb = fileChangeVerb(event.payload.action).titleCase;
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
      // Issue #840/#844 — distinct from "denied": nobody ever answered (a
      // timeout, a dropped connection, a duplicate concurrent gate, or a
      // restart while this was pending), so the agent fell through to its
      // own native prompt rather than being denied. Don't collapse this back
      // into "Review denied" — that reads as a decision that was never made.
      if (event.payload.state === "lapsed")
        return { text: "No answer — agent decided at its own prompt", attention: false };
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
    // this switch never grew a case for it, so this returned null for it,
    // silently describing it as nothing.
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
        const changed =
          files.length === 1 ? (firstChangedFileName(files) ?? "1 file") : `${files.length} files`;
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
    case "pr_ci_failed":
    case "pr_ci_passed":
    case "pr_review_submitted":
    case "pr_new_comments":
    case "pr_merged":
    case "pr_conflicts":
      return describePrEvent(event);
    case "message_sent": {
      const to = typeof event.payload.to === "number" ? ` to session ${event.payload.to}` : "";
      const status = typeof event.payload.status === "string" ? `: ${event.payload.status}` : "";
      return { text: `Message${to}${status}`, attention: false };
    }
    case "message_received": {
      const from =
        typeof event.payload.from === "number" ? ` from session ${event.payload.from}` : "";
      return { text: `Message${from} delivered`, attention: false };
    }
    default:
      return null;
  }
}

// Sidebar now-line (frontend/src/lib/sessionNowLine.ts) — "what file did this
// session touch most recently", independent of sessionContextMap below: the
// now-line's own todo context comes straight off the session's live
// `currentTodo` field (pty-manager.ts — immune to this same event buffer's
// eviction, unlike the per-seq todo tracking sessionContextMap does), so it
// only ever needs THIS piece, not the fuller todo/title priority chain.
// Standalone (not built by slicing sessionContextMap's map) since that map is
// keyed per-seq for a different consumer (NotificationBell's per-row
// substitution) — this only ever needs the value after the LAST event.
export function latestFileContext(events: readonly NotificationEvent[]): string | null {
  let lastFileChange: string | null = null;
  let lastSessionDiff: string | null = null;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    if (event.kind === "file_change") {
      const path = typeof event.payload.path === "string" ? event.payload.path : null;
      if (!path) continue;
      const verb = fileChangeVerb(event.payload.action).lower;
      lastFileChange = `${verb} ${path}`;
    } else if (event.kind === "session_diff") {
      const files = event.payload.files;
      if (!Array.isArray(files) || files.length === 0) continue;
      const changed =
        files.length === 1 ? (firstChangedFileName(files) ?? "1 file") : `${files.length} files`;
      lastSessionDiff = `changed ${changed}`;
    }
  }
  return lastFileChange ?? lastSessionDiff;
}

// Sidebar now-line — same "skip a title that just repeats the session's own
// label" guard as sessionContextMap's own title_change case below, but
// standalone (see latestFileContext's own comment for why): only reached for
// a hookless session (frontend/src/lib/sessionNowLine.ts gates on
// `hookEmits.length === 0`), where the terminal title is often the only
// signal available at all.
export function latestTitleContext(
  events: readonly NotificationEvent[],
  sessionLabel: string | null,
): string | null {
  let lastTitle: string | null = null;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    if (event.kind !== "title_change") continue;
    const title = typeof event.payload.title === "string" ? event.payload.title : null;
    if (title && title !== sessionLabel) lastTitle = title;
  }
  return lastTitle;
}

// Issue #903 — "what was this session actually doing" for a `generic: true`
// row (see describeEvent's cases above): a `silence`/`titleIdle`/`bell`/
// `agentIdle`/content-free-`hookNotification` row's own text says nothing
// about the session beyond "something happened". Priority, first non-empty
// wins: the in-progress todo, else the last file changed, else the last
// session diff, else the terminal title (skipped when it just repeats the
// session's own name/command — the weakest source, and often all a hookless
// session has).
//
// Returns a MAP keyed by event seq, built in ONE forward pass over the
// session's own events, not a per-row backward scan — NotificationBell.tsx's
// buildFeedItems already re-runs on every store tick while the panel is
// open, and a scan per row would be O(rows × events) on every one of those
// ticks (same posture as this file's own countUnread/buildFeedItems split
// and dev-server-detect.ts's "perf audit finding B8(1)"). Each entry is the
// context that was true immediately BEFORE that seq's own event — a `todo`/
// `file_change`/`session_diff`/`title_change` event updates the running
// context for events AFTER it, never for itself.
//
// Todo tracking has no stable per-item id: NotificationEvent's `todo`
// payload carries none. Setting the tracked in-progress/pending todo is
// content-based (the last content seen at that status) — good enough for a
// display nicety, not exact if two distinct todos ever share literal text.
// CLEARING it on a terminal (completed/cancelled) update is deliberately
// content-AGNOSTIC (see that branch's own comment): an unconditional clear
// on any terminal update, not a content match, because the backend's own
// completion fallback (forwarder-core.mjs, when a TodoWrite call ends with
// every item terminal) can't necessarily name the SAME item this map is
// tracking either.
export function sessionContextMap(
  events: readonly NotificationEvent[],
  sessionLabel?: string | null,
): Map<number, string> {
  const map = new Map<number, string>();
  let inProgressTodo: string | null = null;
  let anyTodo: string | null = null;
  let lastFileChange: string | null = null;
  let lastSessionDiff: string | null = null;
  let lastTitle: string | null = null;

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    const context =
      (inProgressTodo ?? anyTodo) !== null
        ? `▸ ${inProgressTodo ?? anyTodo}`
        : (lastFileChange ?? lastSessionDiff ?? lastTitle);
    if (context) map.set(event.seq, context);

    switch (event.kind) {
      case "todo": {
        const content = typeof event.payload.content === "string" ? event.payload.content : null;
        const status = typeof event.payload.status === "string" ? event.payload.status : null;
        if (!content) break;
        if (status === "in_progress" || status === "pending") {
          anyTodo = content;
          if (status === "in_progress") inProgressTodo = content;
          else if (content === inProgressTodo) inProgressTodo = null;
        } else {
          // Hermes review (issue #903), then Graphify review — a terminal
          // status (completed/cancelled) is a completion signal, not new
          // context to display. Originally cleared only the slot whose
          // CONTENT matched this event's own — but the backend's own
          // completion fallback (forwarder-core.mjs's TodoWrite mapper,
          // when every remaining todo is terminal) picks the LAST entry in
          // the list, which is not necessarily the SAME item this map is
          // currently tracking as in-progress. A content-matched clear
          // then silently misses: whatever WAS tracked stays stuck
          // forever, exactly the staleness Hermes originally flagged, just
          // one level removed. Content has no stable identity here anyway
          // (this file's own doc comment already accepts that limitation)
          // — an unconditional clear on ANY terminal update is the
          // robust choice: no todo context beats stale/wrong todo context.
          inProgressTodo = null;
          anyTodo = null;
        }
        break;
      }
      case "file_change": {
        const path = typeof event.payload.path === "string" ? event.payload.path : null;
        if (!path) break;
        const verb = fileChangeVerb(event.payload.action).lower;
        lastFileChange = `${verb} ${path}`;
        break;
      }
      case "session_diff": {
        const files = event.payload.files;
        if (!Array.isArray(files) || files.length === 0) break;
        const changed =
          files.length === 1 ? (firstChangedFileName(files) ?? "1 file") : `${files.length} files`;
        lastSessionDiff = `changed ${changed}`;
        break;
      }
      case "title_change": {
        const title = typeof event.payload.title === "string" ? event.payload.title : null;
        if (title && title !== sessionLabel) lastTitle = title;
        break;
      }
      default:
        break;
    }
  }
  return map;
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
  // PR transitions that want the user: red CI, new conflicts, requested
  // changes. The good-news kinds stay timeline-only.
  if (event.kind === "pr_ci_failed" || event.kind === "pr_conflicts") return "attention";
  if (event.kind === "pr_review_submitted" && event.payload.decision === "CHANGES_REQUESTED") {
    return "attention";
  }
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

// Fix: SessionTimeline "Only attention" hid the very rows it means to
// surface — suppressPairedAttentionRows keeps the SPECIFIC-kind row (e.g.
// `permission_request`) and drops its paired `attention` sibling, but
// notifyKind only ever recognizes `kind === "attention"` (plus a few
// special cases), so every surviving specific-kind row fell through to
// severity null → filtered out by "Only attention" and rendered with no
// severity stripe at all, indistinguishable from routine chatter. This
// classifies those specific kinds directly. Per-kind, not a flat allow-list,
// because three of them (elicitation/question/promote_request) reuse the
// SAME kind for their own resolution record — with no paired attention
// then — which must NOT count (promote_request's resolution-only bogus-
// notification history is exactly why notifyKind itself never recognized
// this kind at all; see SIGNAL_TO_EVENT_KIND's own comment above).
// permission_request/plan_ready/tool_failure/stop_failure have no such
// resolution-reuses-the-kind case (hook-handlers.ts emits each exactly once,
// at request time — resolution clears state without re-emitting), so they're
// unconditional.
function specificKindSeverity(
  event: Pick<NotificationEvent, "kind" | "payload">,
): NotifySeverity | null {
  switch (event.kind) {
    case "permission_request":
    case "plan_ready":
      return "blocked";
    case "tool_failure":
    case "stop_failure":
      return "error";
    case "elicitation":
    case "question":
      return event.payload.state === "started" ? "blocked" : null;
    case "promote_request":
      return event.payload.state === undefined ? "blocked" : null;
    // Red PR news is "error" (the agent's next push usually resolves it);
    // the rest is informational and handled by notifyKind returning null.
    case "pr_ci_failed":
    case "pr_conflicts":
      return "error";
    case "pr_review_submitted":
      return event.payload.decision === "CHANGES_REQUESTED" ? "error" : null;
    default:
      return null;
  }
}

/** Severity tier for a notify-worthy event, or null for anything neither
 * notifyKind() nor specificKindSeverity() above would count (routine
 * chatter). Reads `payload.signal` for `kind === "attention"` (the SAME
 * field describeEvent's own switch keys off of) rather than `event.kind`. */
export function notifySeverity(
  event: Pick<NotificationEvent, "kind" | "payload">,
): NotifySeverity | null {
  const bySpecificKind = specificKindSeverity(event);
  if (bySpecificKind !== null) return bySpecificKind;
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
  // PR transitions from the GitHub poller.
  pr_ci_failed: "PR CI",
  pr_ci_passed: "PR CI",
  pr_review_submitted: "PR Review",
  pr_new_comments: "PR Comments",
  pr_merged: "PR Merged",
  pr_conflicts: "PR Conflicts",
  // Issue #2270 — a message one session sent another.
  message_sent: "Message Sent",
  message_received: "Message",
};

export const ALL_KINDS = Object.keys(KIND_LABELS) as NotificationEvent["kind"][];

/**
 * Issue #1735 — how a machine-injected turn reads on the timeline.
 *
 * The values are Claude Code's own `UserPromptSubmit` `source` field (see
 * src/services/hook-protocol.ts's turnSourceEndsTurn for the rule that
 * decides whether such a turn counts as a turn END). `user` is absent on
 * purpose: a human's turn is the ordinary case and renders as the usual
 * "Agent: generating".
 */
const TURN_SOURCE_LABELS: Record<string, string> = {
  sdk: "non-interactive",
  system: "system",
  loop_wakeup: "loop wakeup",
  schedule_wakeup: "scheduled",
  poll_event: "poll",
};

export interface UnreadEventSummary {
  count: number;
  // Bell wins over check when both are present — attention is the
  // higher-priority signal (matches PaneTab's own status-badge priority).
  kind: "attention" | "exited" | null;
}

// Shared by PaneTab.tsx's own tab badge and MobileSessionBar.tsx (issue
// #168 / mobile UI overhaul, PR #613 Hermes review) — the identical "events
// newer than the read cursor, minus anything already dismissed from the
// notification panel, that classify as notify-worthy" derivation, previously
// duplicated verbatim in both places. The dismissal key comes from
// store/helpers.ts's eventKey (a light module, not the store itself): an
// inlined copy kept the pre-#1427 two-part format and never matched.
export function unreadEventSummary(
  sessionId: number,
  events: NotificationEvent[] | undefined,
  lastSeenSeq: number,
  dismissedEventKeys: Record<string, true>,
): UnreadEventSummary {
  const kinds = (events ?? [])
    .filter((e) => e.seq > lastSeenSeq && !dismissedEventKeys[eventKey(sessionId, e.seq, e.ts)])
    .map(notifyKind)
    .filter((k): k is "attention" | "exited" => k !== null);
  return {
    count: kinds.length,
    kind: kinds.includes("attention") ? "attention" : kinds.length > 0 ? "exited" : null,
  };
}

// Phone surfaces (session picker rows/badge, and the phone notifications
// sheet to come) count unread through this, not unreadEventSummary directly:
// a muted session contributes nothing, matching the desktop bell's own
// countUnread — the old phone switcher badge ignored mute, so the two
// disagreed. Explicit primitives, same shape as unreadEventSummary.
export function sessionUnreadCount(
  sessionId: number,
  events: NotificationEvent[] | undefined,
  lastSeenSeq: number,
  dismissedEventKeys: Record<string, true>,
  muted: boolean,
): number {
  if (muted) return 0;
  return unreadEventSummary(sessionId, events, lastSeenSeq, dismissedEventKeys).count;
}

// "This session needs you" for the phone session picker's pinned section:
// the polled `attention` boolean or an unread attention-kind event. The bell
// no longer reads this (#3458): its "Needs you" is sessionOpenDecisions
// below, decisions only, keyed off the session's live latches. The picker
// keeps the broader rule on purpose: it navigates to a session, and a
// finished turn is a reason to go look. True when the session is flagged `attention`
// OR has an unread, undismissed attention-kind event (a pending gate,
// attention, dev-server offer — NOT a plain exit). A muted session never
// needs you: mute is the user saying "don't bother me about this one".
export function sessionNeedsYou(
  session: { id: number; attention: boolean },
  events: NotificationEvent[] | undefined,
  lastSeenSeq: number,
  dismissedEventKeys: Record<string, true>,
  muted: boolean,
): boolean {
  if (muted) return false;
  if (session.attention) return true;
  return (
    unreadEventSummary(session.id, events, lastSeenSeq, dismissedEventKeys).kind === "attention"
  );
}

// ---------------------------------------------------------------------------
// The notification bell's classification (#3458, design note
// docs/design/notification-bell/note.md, "Every notification type").
//
// The bell lists only what waits on a human decision. Every event is one of:
// - "decision": a permission, plan, question, elicitation, review gate,
//   promote request, dev-server offer, or an unpaired generic notification.
// - "failed": the agent stopped on an API error, the process exited non-zero,
//   or a manual session's PR went red (CI, conflicts).
// - "verdict": a review decision landed on a PR.
// - "grouped": informative, worth a glance, never counted ("Finished", an exit
//   with code zero or none). Shown under "Earlier, no decision needed".
// - "dropped": not in the bell at all; it stays in the session's timeline.
//
// Pure per-event: whether a decision is still OPEN is a property of the
// session's live state, decided by sessionOpenDecisions below.
// notifyKind/notifySeverity above are unchanged: the pane tab badge,
// desktop notifications and the timeline keep their own rules.
export type BellClass = "decision" | "failed" | "verdict" | "grouped" | "dropped";

export function bellClass(event: Pick<NotificationEvent, "kind" | "payload">): BellClass {
  const kind = event.kind;
  switch (kind) {
    case "attention": {
      if (event.payload.attention !== true) return "dropped";
      const signal = typeof event.payload.signal === "string" ? event.payload.signal : null;
      // Claude Code's generic Notification hook: listed when no specific ask
      // covers it (sessionOpenDecisions pairs it on time).
      if (signal === "hookNotification") return "decision";
      if (signal === "agentIdle") return "grouped";
      // Every other signal is either the twin of a specific kind that every
      // raise site in hook-handlers.ts emits alongside it (permissionRequest,
      // planReady, question, elicitation, reviewGate, promoteRequest,
      // apiError -> stop_failure), a tool failure the agent's next turn
      // usually resolves, or a byte-parsed guess (bell, silence, title idle,
      // ...) that cannot say what the decision is.
      return "dropped";
    }
    case "permission_request":
    case "plan_ready":
      return "decision";
    case "question":
    case "elicitation":
      // The kind is reused for the resolution record (`state: "finished"`).
      return event.payload.state === "started" ? "decision" : "dropped";
    case "review_gate":
      return event.payload.state === "waiting" ? "decision" : "dropped";
    case "promote_request":
      // The resolution record carries `state: "accepted" | "declined"`.
      return event.payload.state === undefined ? "decision" : "dropped";
    case "dev_server_detected":
      // Kept, against the note's first draft: this row's "Use this port" is
      // the only place a plain session's detected dev server can be wired
      // up (docs/dock.md), so it is an open offer, not news.
      return event.payload.state === undefined ? "decision" : "dropped";
    case "stop_failure":
      return "failed";
    case "session_end": {
      const code = event.payload.exitCode;
      return typeof code === "number" && code !== 0 ? "failed" : "dropped";
    }
    case "status_change":
      return event.payload.reason === "exited" ? "grouped" : "dropped";
    case "pr_ci_failed":
    case "pr_conflicts":
      return "failed";
    case "pr_review_submitted":
      return event.payload.decision === "CHANGES_REQUESTED" || event.payload.decision === "APPROVED"
        ? "verdict"
        : "dropped";
    case "tool_failure":
    case "title_change":
    case "file_change":
    case "todo":
    case "session_diff":
    case "pr_ci_passed":
    case "pr_new_comments":
    case "pr_merged":
    case "message_sent":
    case "message_received":
      return "dropped";
    default: {
      // A new kind must be classified here before it compiles.
      const unclassified: never = kind;
      return unclassified;
    }
  }
}

/** The bell's row label for a class: what the status filter and the row's
 * pill call it. A decision keeps its kind's own label (notifyLabel). */
export type OpenDecisionClass = Exclude<BellClass, "grouped" | "dropped">;

export interface OpenDecision {
  event: NotificationEvent;
  cls: OpenDecisionClass;
}

/** The session fields sessionOpenDecisions reads: its live decision latches. */
export type DecisionLatches = Pick<
  {
    id: number;
    alive: boolean;
    attention: boolean;
    attentionKind: string | null;
    permissionState: "idle" | "pending";
    planState: "idle" | "pending";
    elicitationState: "idle" | "pending";
    questionState?: "idle" | "pending";
    permissionAt?: number | null;
    planAt?: number | null;
    elicitationAt?: number | null;
    questionAt?: number | null;
    promoteAt?: number | null;
    promoteState: "idle" | "pending" | "accepted" | "declined";
    errorState: "idle" | "api_error" | "tool_failure";
    gates: ReadonlyArray<{ gateId: string }>;
    pendingDevServerPort: string | null;
  },
  | "id"
  | "alive"
  | "attention"
  | "attentionKind"
  | "permissionState"
  | "planState"
  | "elicitationState"
  | "questionState"
  | "permissionAt"
  | "planAt"
  | "elicitationAt"
  | "questionAt"
  | "promoteAt"
  | "promoteState"
  | "errorState"
  | "gates"
  | "pendingDevServerPort"
>;

// Slack for comparing an event's timestamp with its latch's raise time: both
// come from the same backend clock, the event at or after the raise.
const LATCH_EVENT_SLACK_MS = 1_000;

// The same window SessionTimeline.tsx pairs a generic attention row with its
// specific sibling in.
const HOOK_NOTIFICATION_PAIR_WINDOW_MS = 5_000;

const SPECIFIC_ASK_KINDS = new Set<NotificationEvent["kind"]>([
  "permission_request",
  "plan_ready",
  "question",
  "elicitation",
  "review_gate",
  "promote_request",
]);

function prNumber(event: NotificationEvent): number | null {
  return typeof event.payload.number === "number" ? event.payload.number : null;
}

/**
 * The session's decisions that are still open, newest first (#3458).
 *
 * Needs-you is state, not a cursor: most decision events record the request
 * and nothing records the answer (a permission_request has no "resolved"
 * event), so whether a row is still open comes from the session's own live
 * latches, which the backend clears when the decision is answered however it
 * was answered (in the terminal, from the bell, a timeout). A latch holds one
 * request, so for a latched kind only its newest event is open. Viewing the
 * bell never closes a decision; only its state clearing, or Dismiss, does.
 *
 * - review_gate: its own gate still in `gates`.
 * - permission_request / plan_ready / elicitation / promote_request: the
 *   kind's latch is pending, and (for the kinds that record a resolution)
 *   no later event of the kind.
 * - question: its own latch (`questionState`), and no later question event
 *   resolved it. Without the latch (an older backend), while the session's
 *   confirmed attention is a question: attention keeps only the newest of two
 *   specific asks, so a question with a plan raised after it would hide.
 * - unpaired hookNotification: while it is the confirmed attention kind, and
 *   no specific ask landed within 5s of it (Claude Code fires its generic
 *   notification beside a permission; the specific row carries the content).
 * - dev_server_detected: while the session's pending port is this one.
 * - stop_failure: while `errorState` is "api_error" (any progress clears it).
 * - session_end non-zero: while the process is not alive.
 * - PR rows (manual sessions only; a task's PR is the Tasks section's): red
 *   CI until a later pass, failure or merge of the same PR; conflicts and a
 *   review verdict until a later one of the same kind or a merge (the poller
 *   emits no "conflicts resolved", so Dismiss closes that row otherwise).
 *
 * A muted session has no open decisions (mute is "don't bother me").
 * Cheap enough for the badge's every-tick path: two linear passes, no sort.
 */
export function sessionOpenDecisions(
  session: DecisionLatches,
  events: readonly NotificationEvent[] | undefined,
  dismissedEventKeys: Record<string, true>,
  muted: boolean,
  taskOwned = false,
): OpenDecision[] {
  if (muted || !events || events.length === 0) return [];
  // Requests only: a resolution record (a question's "finished", a resolved
  // gate) reuses its kind, and must not hide an unrelated notification.
  const specificAskTs: number[] = [];
  for (const e of events) {
    if (SPECIFIC_ASK_KINDS.has(e.kind) && bellClass(e) === "decision") specificAskTs.push(e.ts);
  }
  // A latch is raised before its event is emitted (a permission settles for
  // up to 2s first, and is never emitted if auto-approved meanwhile), so the
  // newest event of a kind can belong to an earlier, answered raise. Only an
  // event emitted for the current raise counts; without the timestamp (an
  // older backend) the newest one does.
  const sinceRaise = (e: NotificationEvent, at: number | null | undefined) =>
    at === null || at === undefined || e.ts >= at - LATCH_EVENT_SLACK_MS;

  const out: OpenDecision[] = [];
  const laterKinds = new Set<string>();
  // Per PR number: what a later event already settled.
  const prSettled = new Map<number, { ci: boolean; conflicts: boolean; review: boolean }>();
  // addEvent keeps each session's buffer ascending by seq: walk newest first.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const cls = bellClass(e);
    const signalKey =
      e.kind === "attention" && typeof e.payload.signal === "string"
        ? `attention:${e.payload.signal}`
        : e.kind;
    const pr = e.kind.startsWith("pr_") ? prNumber(e) : null;
    const settled =
      pr === null ? null : (prSettled.get(pr) ?? { ci: false, conflicts: false, review: false });

    let open = false;
    if (cls !== "grouped" && cls !== "dropped") {
      switch (e.kind) {
        case "review_gate": {
          const gateId = typeof e.payload.gateId === "string" ? e.payload.gateId : null;
          open =
            gateId !== null
              ? session.gates.some((g) => g.gateId === gateId)
              : !laterKinds.has("review_gate:legacy") && session.gates.length > 0;
          break;
        }
        case "permission_request":
          open =
            !laterKinds.has(e.kind) &&
            session.permissionState === "pending" &&
            sinceRaise(e, session.permissionAt);
          break;
        case "plan_ready":
          open =
            !laterKinds.has(e.kind) &&
            session.planState === "pending" &&
            sinceRaise(e, session.planAt);
          break;
        case "elicitation":
          open =
            !laterKinds.has(e.kind) &&
            session.elicitationState === "pending" &&
            sinceRaise(e, session.elicitationAt);
          break;
        case "promote_request":
          open =
            !laterKinds.has(e.kind) &&
            session.promoteState === "pending" &&
            sinceRaise(e, session.promoteAt);
          break;
        case "question":
          // Its own latch when the session carries one; otherwise (an older
          // backend) while the question is the confirmed attention.
          open =
            !laterKinds.has(e.kind) &&
            (session.questionState !== undefined
              ? session.questionState === "pending" && sinceRaise(e, session.questionAt)
              : session.attention && session.attentionKind === "question");
          break;
        case "attention":
          open =
            !laterKinds.has(signalKey) &&
            session.attention &&
            session.attentionKind === "hookNotification" &&
            !specificAskTs.some((ts) => Math.abs(ts - e.ts) <= HOOK_NOTIFICATION_PAIR_WINDOW_MS);
          break;
        case "dev_server_detected":
          open =
            typeof e.payload.port === "string" && session.pendingDevServerPort === e.payload.port;
          break;
        case "stop_failure":
          open = !laterKinds.has(e.kind) && session.errorState === "api_error";
          break;
        case "session_end":
          open = !laterKinds.has(e.kind) && !session.alive;
          break;
        case "pr_ci_failed":
          open = !taskOwned && settled !== null && !settled.ci;
          break;
        case "pr_conflicts":
          open = !taskOwned && settled !== null && !settled.conflicts;
          break;
        case "pr_review_submitted":
          open = !taskOwned && settled !== null && !settled.review;
          break;
        default:
          open = false;
      }
    }
    if (open && !dismissedEventKeys[eventKey(session.id, e.seq, e.ts)]) {
      out.push({ event: e, cls: cls as OpenDecisionClass });
    }

    // Record what this event settles for the older ones still to come.
    laterKinds.add(signalKey);
    if (e.kind === "review_gate" && typeof e.payload.gateId !== "string") {
      laterKinds.add("review_gate:legacy");
    }
    if (pr !== null && settled !== null) {
      if (e.kind === "pr_ci_failed" || e.kind === "pr_ci_passed" || e.kind === "pr_merged") {
        settled.ci = true;
      }
      if (e.kind === "pr_conflicts" || e.kind === "pr_merged") settled.conflicts = true;
      if (e.kind === "pr_review_submitted" || e.kind === "pr_merged") settled.review = true;
      prSettled.set(pr, settled);
    }
  }
  return out;
}

/** One session's informative events for the bell's "Earlier, no decision
 * needed" group (#3460): never counted anywhere. */
export interface GroupedSummary {
  finished: boolean;
  exited: boolean;
  /** Every grouped, undismissed event, newest first (Dismiss takes them all). */
  seqs: number[];
  newestTs: number;
  /** Any of them past the session's read cursor. */
  unread: boolean;
}

export function sessionGroupedSummary(
  sessionId: number,
  events: readonly NotificationEvent[] | undefined,
  lastSeenSeq: number,
  dismissedEventKeys: Record<string, true>,
  /** A failed exit is already a Failed row: do not also say "exited". */
  failedExit: boolean,
): GroupedSummary | null {
  if (!events) return null;
  let summary: GroupedSummary | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (bellClass(e) !== "grouped") continue;
    if (dismissedEventKeys[eventKey(sessionId, e.seq, e.ts)]) continue;
    const isExit = e.kind === "status_change";
    if (isExit && failedExit) continue;
    summary ??= { finished: false, exited: false, seqs: [], newestTs: e.ts, unread: false };
    if (isExit) summary.exited = true;
    else summary.finished = true;
    summary.seqs.push(e.seq);
    if (e.seq > lastSeenSeq) summary.unread = true;
  }
  return summary;
}
