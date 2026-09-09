// Runtime VALUES (not type-only shapes — see src/shared/types.ts and
// src/shared/ws-protocol.ts for those) shared verbatim between the backend
// and the frontend. Same relocation pattern as those two files: each
// constant below used to be independently declared on both sides of the
// workspace boundary, kept in sync by hand with zero compiler enforcement;
// the physical declaration now lives here, and every former declarer
// re-exports it so no existing import path needed to change.
//
// Because these are runtime values, not types, every consumer's import of
// them (this file's own re-exporters included) must be a plain `import`,
// not `import type` — `@typescript-eslint/consistent-type-imports` only
// forces `import type` for imports used exclusively as types, so an import
// with a genuine runtime use (e.g. iterating TASK_STATUSES, or comparing
// against LOCAL_HOST_ID) is unaffected.

// ---------------------------------------------------------------------------
// db/schema.ts — TASK_STATUSES / TaskStatus
// ---------------------------------------------------------------------------
//
// Phase 6 Task Master (6.9/#233) — the full lifecycle status vocabulary.
// `backlog`/`ready` replace the thin slice's single "pending": `ready` is
// what drag-to-ready (interactive) and the watcher's auto-claim ingest
// (autonomous) both write, so it's the concurrency-cap-gated pickup point;
// `backlog` is the un-picked-up staging column (see task-state.ts for the
// legal transition table and the roadmap's Task Model & Task Board section
// for the backlog->ready->...->done column framing). Free text at the SQL
// level (db/schema.ts's tasks.status column) — this union is the
// TypeScript-side source of truth every backend route/service (and, via
// this file, every frontend consumer, e.g. frontend/src/tasksBoard.ts's own
// exhaustiveness check) imports rather than re-declaring.
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "reviewing",
  "done",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ---------------------------------------------------------------------------
// services/host-registry.ts — LOCAL_HOST_ID
// ---------------------------------------------------------------------------
//
// The stable identifier every `project.hostId` and session-backend lookup
// keys off for "this same process" (as opposed to a registered remote
// host's id, issue #26) — seeded by the migration as the only host id that
// resolves to the in-process PtyManager (session-backend.ts) rather than a
// RemoteHostClient.
export const LOCAL_HOST_ID = "local";

// ---------------------------------------------------------------------------
// services/pty-manager.ts / frontend/src/lib/terminalGridSize.ts —
// MAX_TERMINAL_COLS / MAX_TERMINAL_ROWS
// ---------------------------------------------------------------------------
//
// Dock monitor resize-runaway — opening the dock on a project with Docker
// Compose services could grow a dock terminal's grid without bound (observed
// live at ~35,140 cols / ~9,000 rows before the tab locked up): the dock's
// CSS deliberately lets a `.dock-monitor`'s content size propagate up to
// `.dock-body` (see empty-states.css's own comment on `.dock-stack-group`),
// which means a terminal's own rendered content can inflate the size of the
// very container the frontend's fitAddon measures it against next — resize
// bigger -> container measures bigger -> propose an even bigger resize ->
// repeat, with no external trigger needed. pty-manager.ts's own
// MIN_TERMINAL_COLS/ROWS had no upper counterpart, so nothing stopped a
// client-supplied size — corrupted by that loop, or by any other client —
// from reaching the pty unbounded.
//
// Genuinely shared (unlike MIN_TERMINAL_COLS/ROWS, which the frontend only
// ever learns at runtime via the GeometryMessage echo, never at build time):
// the frontend clamps proactively, before ever sending a resize
// (frontend/src/TerminalPane.tsx's applyClampedFit()), specifically so a
// runaway proposal never leaves the tab in the first place; the backend
// clamp (this same value, via pty-manager.ts's clampTerminalSize()) is the
// actual last line of defense against any client, this one included.
//
// Sized with deliberate headroom above any realistic display — a monospace
// cell is roughly 6px wide / 12px tall at the lowest configurable font size
// (settings.ts floors fontSize at 10px), so even an extreme span of three
// stacked/tiled 4K displays (≈11,520px wide or ≈6,480px tall) proposes at
// most ~1,920 cols / ~540 rows, well under these — while staying a
// deliberate, consistent ~9x below the observed runaway's magnitude on both
// axes. Generous, not an absolute guarantee for every conceivable future
// display configuration: if a setup somehow does exceed this, the terminal
// renders at the ceiling rather than growing further — the same graceful-
// degradation posture MIN_TERMINAL_COLS/ROWS's own floor already has.
export const MAX_TERMINAL_COLS = 4000;
export const MAX_TERMINAL_ROWS = 1000;

// ---------------------------------------------------------------------------
// routes/projects.ts's stackSessionName() / frontend/src/dock/dockHelpers.ts —
// DOCKER_STACK_SESSION_NAME_PREFIX
// ---------------------------------------------------------------------------
//
// Dock log-streaming resize fix (symptom 3) — a stack-wide action
// (restart/apply/pull-and-restart/rebuild-and-restart/stop) spawns a
// `kind: "dock"` session named `${DOCKER_STACK_SESSION_NAME_PREFIX}
// <composeProject>`, `nameLocked: true` (startStackSession, routes/
// projects.ts). That name is a stable, recoverable identity for "is a stack
// action currently running against this compose project" — but the
// frontend's own record of it (Dock.tsx's `ephemeralControls`) was
// component-local `useState`, populated only from the POST response that
// started it, so a workspace switch (which unmounts DockColumn) lost track
// of a still-running action even though the backend session survived
// untouched. Genuinely shared, not hand-synced, so the frontend's own
// reconstruction of an ephemeral control from a live session list can
// recognize this prefix without duplicating the string.
export const DOCKER_STACK_SESSION_NAME_PREFIX = "docker-stack:";
