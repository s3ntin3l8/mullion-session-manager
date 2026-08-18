// Type-only WebSocket protocol shapes shared verbatim between the backend
// and the frontend, following the same relocation pattern src/shared/types.ts
// established (see that file's own header for the full rationale). Each
// shape below used to be independently declared — or, worse, left as a bare
// untyped literal — on one or both sides of a given socket; the physical
// declaration now lives here, with every former declarer doing
// `export type { X } from "../shared/ws-protocol.js"` (or the frontend's
// equivalent relative import) so no existing import path needed to change.
//
// This file has no runtime dependency on `TaskStatus` (task-events.ts) or
// any other shared VALUE — see src/shared/constants.ts for the runtime
// (non-type-only) counterpart to this file.

// ---------------------------------------------------------------------------
// routes/terminal.ts — TerminalWSMessage (ResizeMessage | ExitedMessage)
// ---------------------------------------------------------------------------
//
// The full set of JSON control frames that cross /ws/terminal (and the
// internal /internal/ws/attach it proxies to for a remote host, and the
// per-session control-socket relay) in EITHER direction. Everything else
// that crosses this socket is raw binary (browser->PTY keystrokes,
// PTY->browser output) and is deliberately NOT part of this union — see
// routes/terminal.ts's `socket.on("message", ...)` handler, which branches
// on `isBinary` before ever attempting to JSON.parse.
//
// Verified by reading the whole handler (not just grepping for "type:")
// that these three are the only JSON frame shapes that exist on this socket:
// ResizeMessage flows browser->server only (TerminalPane.tsx's
// sendResizeIfOpen), ExitedMessage and GeometryMessage flow server->browser
// only (`session.onExit`'s handler and the post-clamp geometry echo in
// attachSocketToSession, respectively).

export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export interface ExitedMessage {
  type: "exited";
}

// pty-manager.ts's Session floors cols/rows at MIN_TERMINAL_COLS/ROWS
// (currently 40x10) — a client-requested size below that (a small split, or
// dockview's own 300x300 default floating-group size) is silently clamped
// server-side, so a ResizeMessage's cols/rows can never be trusted as the
// terminal's actual applied geometry. This is the server's echo of what was
// actually applied, sent once on attach and again after every resize() call
// — see attachSocketToSession's own comment for why. The frontend uses it to
// keep xterm's own grid (and its "pane too small" hint) in sync with the PTY
// it's actually attached to, rather than the size it asked for.
export interface GeometryMessage {
  type: "geometry";
  cols: number;
  rows: number;
}

export type TerminalWSMessage = ResizeMessage | ExitedMessage | GeometryMessage;

// ---------------------------------------------------------------------------
// services/github-ws-broadcast.ts — GitHubWSEvent
// ---------------------------------------------------------------------------
//
// The backend's /ws/github push-event shape, a 5-arm discriminated union.
// Every arm carries `projectId: string`, which is what lets a consumer that
// only cares "did something happen for project X" (frontend/src/store.ts's
// connectGitHubWS) read `.projectId` off the union directly, without a
// `type`-narrowing switch first — TypeScript allows reading a field common
// to every arm of a union without narrowing.

export type GitHubWSEvent =
  | {
      type: "pr";
      action: "opened" | "closed" | "sync";
      projectId: string;
      pr: Record<string, unknown>;
      ci?: Record<string, unknown>[];
    }
  | {
      type: "issue";
      action: "opened" | "closed";
      projectId: string;
      counts: { open: number; closed: number };
    }
  | {
      type: "ci";
      action: "completed" | "started";
      projectId: string;
      run: Record<string, unknown>;
      jobs?: Record<string, unknown>[];
    }
  | { type: "release"; action: "published"; projectId: string; release: Record<string, unknown> }
  | { type: "push"; projectId: string; branch: string; sha: string };

// ---------------------------------------------------------------------------
// services/task-events.ts — TaskEvent
// ---------------------------------------------------------------------------
//
// The backend's /ws/tasks push-event shape. #490a — "ingested" (a
// freshly-labeled/opened issue becoming a task) is a second kind alongside
// the original "transition" — a discriminated union rather than making
// `from`/`to`
// optional on one shape, since a transition frame keeps both required. The
// frontend's own hand-written type guard (tasksClient.ts's
// `isTaskWireMessage`) used to hardcode `kind === "transition" || kind ===
// "ingested"` as a literal list with a comment warning it "must never lag
// the backend that produces the wider set" — it now derives its accepted
// kinds from this union's own `kind` member type instead, so a future
// backend addition becomes a `tsc` error in the frontend guard rather than a
// silent gap. `TaskStatus` (the `from`/`to` field type) is intentionally
// NOT re-exported from here — it's a runtime value (`TASK_STATUSES`), not a
// type-only shape, so it lives in src/shared/constants.ts instead.

import type { TaskStatus } from "./constants.js";

export type TaskEvent =
  | {
      taskId: number;
      projectId: number;
      kind: "transition";
      from: TaskStatus;
      to: TaskStatus;
      ts: number;
    }
  | { taskId: number; projectId: number; kind: "ingested"; ts: number }
  // #667 — a task's resolved dependency state changed (task-dependencies.ts's
  // refreshTaskBlockers, called from the auto-claim sweep or a webhook
  // push). Same "doorbell, not a data channel" shape as the other two kinds
  // — the frontend reacts with a debounced refetch, not payload patching.
  | { taskId: number; projectId: number; kind: "blockers"; ts: number }
  // #701 — a task's parent-issue title was just filled in by
  // task-watcher.ts's fillParentIssueTitles (a one-shot cache-fill, not a
  // recurring refresh — see that function's own doc comment). Without this,
  // a filled title is invisible to a user already looking at the board
  // until some unrelated event happens to trigger a refetch.
  | { taskId: number; projectId: number; kind: "hierarchy"; ts: number };
