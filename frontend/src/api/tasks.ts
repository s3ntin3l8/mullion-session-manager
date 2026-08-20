// Task Master CRUD + lifecycle transitions. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type { Task, Session } from "./types.js";
import type { TaskStatus } from "../../../src/shared/constants.js";

export const tasksApi = {
  // Phase 2.5 Task Master, Thin Slice (issue #219), extended by Phase 6's
  // task board (6.5/#218) with the optional filters GET /api/tasks now
  // accepts. Always 200s with [] when the feature is disabled or nothing's
  // been ingested yet (see ServerInfo's taskMasterEnabled) — the local board
  // itself works regardless (see the roadmap's Flag semantics decision).
  listTasks: (params?: { status?: TaskStatus; projectId?: number }) => {
    const q = new URLSearchParams();
    if (params?.status !== undefined) q.set("status", params.status);
    if (params?.projectId !== undefined) q.set("projectId", String(params.projectId));
    const qs = q.toString();
    return request<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },

  // Phase 6 (6.9/#233) — local-board creation, works with
  // MULLION_TASK_MASTER_ENABLED off. A task created here has no GitHub
  // issue link (issueNumber/htmlUrl stay null).
  createTask: (
    projectId: number,
    title: string,
    body?: string | null,
    opts?: { agent?: string | null; reviewAgent?: string | null },
  ) =>
    request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        title,
        body: body ?? undefined,
        agent: opts?.agent ?? undefined,
        reviewAgent: opts?.reviewAgent ?? undefined,
      }),
    }),

  // boardOrder is editable for any task; title/body only for a task with no
  // linked GitHub issue; status, agent, and reviewAgent only while the task
  // is still backlog/ready (see routes/tasks.ts's own doc comment —
  // claimed/in_progress/reviewing/done/failed require claim/approve/reject instead).
  updateTask: (
    id: number,
    patch: {
      title?: string;
      body?: string | null;
      status?: "backlog" | "ready";
      boardOrder?: number;
      agent?: string | null;
      reviewAgent?: string | null;
    },
  ) => request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteTask: (id: number) => request<void>(`/api/tasks/${id}`, { method: "DELETE" }),

  // Task-claim queueing (rate-limit-storm fix) — claiming a ready task now
  // unconditionally QUEUES it (status -> "claimed") and returns the task
  // row, not a spawned Session. Dispatch (creating the worktree, spawning
  // the agent) happens asynchronously once a concurrency slot is free —
  // watch the task's own status via refreshTasks()/`/ws/tasks` rather than
  // this response for when it actually starts.
  claimTask: (id: number, opts?: { agent?: string | null; reviewAgent?: string | null }) =>
    request<Task>(`/api/tasks/${id}/claim`, {
      method: "POST",
      body: opts ? JSON.stringify(opts) : undefined,
    }),

  // reviewing -> done: pushes the branch, opens a PR, closes the issue.
  approveTask: (id: number) => request<Task>(`/api/tasks/${id}/approve`, { method: "POST" }),

  // reviewing -> in_progress: posts optional feedback, re-seeds a fresh
  // session in the same worktree if the worker's own session already exited.
  rejectTask: (id: number, feedback?: string) =>
    request<Task>(`/api/tasks/${id}/reject`, {
      method: "POST",
      body: JSON.stringify(feedback ? { feedback } : {}),
    }),

  // #483 — failed -> claimed: resumes on the task's preserved
  // mullion/task-<id> branch (no work lost) rather than starting a fresh
  // one, spawning a new session there. Same response shape as claimTask.
  retryTask: (id: number, opts?: { agent?: string | null; reviewAgent?: string | null }) =>
    request<Session & { seedDelivered: boolean }>(`/api/tasks/${id}/retry`, {
      method: "POST",
      body: opts ? JSON.stringify(opts) : undefined,
    }),

  // #483 — reviewing -> failed: the other resolver of a reviewing task,
  // alongside approve/reject, for when the answer is "give up entirely"
  // rather than "try again."
  giveUpTask: (id: number, reason?: string) =>
    request<Task>(`/api/tasks/${id}/give-up`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
};
