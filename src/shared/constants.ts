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
