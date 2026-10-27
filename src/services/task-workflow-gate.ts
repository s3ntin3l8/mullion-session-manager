// Workflow-change approval gate for Task Master pushes.
//
// A task branch that edits `.github/workflows/` can change what CI runs with
// repository secrets, so it is not pushed under the GitHub App's ordinary
// token (which never carries `workflows: write` — github-app.ts's
// WRITE_PERMISSIONS). Instead the push is HELD until an operator approves
// the specific head commit, and only then is a one-off elevated token minted
// (github-integration.ts's resolveWorkflowWriteToken). Any commit after the
// approval changes the head and voids it.
//
// The enforcement is two-layered on purpose. This module decides whether to
// hold and whether an approval covers the current head; GitHub itself is the
// backstop: with no `workflows` scope in the token it rejects a push that
// touches the directory, so a host this module cannot read (an agent build
// that predates the gate) fails closed at the remote instead of slipping a
// workflow edit through.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import { getDiffStats, getDefaultBaseRef } from "./git-diff.js";
import { resolveCommitSha } from "./git-refs.js";
import { resolveHostGitLog } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

type TaskRow = typeof tasks.$inferSelect;

/** What `tasks.workflowChange` holds while a push waits on the operator. */
export interface WorkflowChange {
  sha: string;
  files: string[];
}

export type WorkflowGate =
  /** Nothing under `.github/workflows/` changed (or this host cannot say). */
  | { kind: "clear" }
  /** The operator approved exactly this head commit. */
  | { kind: "approved"; sha: string }
  /** Workflow files changed and no approval covers the current head. */
  | { kind: "held"; change: WorkflowChange };

export function parseWorkflowChange(raw: string | null): WorkflowChange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WorkflowChange>;
    if (typeof v.sha === "string" && Array.isArray(v.files)) {
      return { sha: v.sha, files: v.files.filter((f): f is string => typeof f === "string") };
    }
  } catch {
    // fall through — a corrupt value reads as "nothing waiting"
  }
  return null;
}

/** Workflow files the task's branch changes against the repo's default
 * base, read fresh (never the 5 s diff-stat cache), or `null` when this host
 * cannot answer — unreachable, or an agent build that predates the gate. */
async function listWorkflowFiles(
  app: FastifyInstance,
  cwd: string,
  hostId: string,
): Promise<string[] | null> {
  if (hostId === LOCAL_HOST_ID) {
    const stats = await getDiffStats(cwd, getDefaultBaseRef(cwd) ?? undefined, { fresh: true });
    return stats?.workflowFiles ?? null;
  }
  try {
    const { stats } = await getRemoteHostClient(app, hostId).resolveGitDiffStats(cwd, "AUTO", {
      fresh: true,
    });
    return stats?.workflowFiles ?? null;
  } catch {
    return null;
  }
}

/** The worktree's current head commit on whichever host owns it. */
async function resolveHeadSha(
  app: FastifyInstance,
  cwd: string,
  hostId: string,
): Promise<string | null> {
  if (hostId === LOCAL_HOST_ID) return resolveCommitSha(cwd, "HEAD");
  const result = await resolveHostGitLog(app, hostId, cwd, { skip: 0, limit: 1, scope: "head" });
  if (!result.ok || result.value.forbidden) return null;
  return result.value.value?.[0]?.sha ?? null;
}

/**
 * Decides whether this task's branch may be pushed with the ordinary token.
 * An undeterminable head SHA with workflow changes present is `held` with an
 * empty sha: nothing can match it, so it can never be approved by accident.
 */
export async function evaluateWorkflowGate(
  app: FastifyInstance,
  task: TaskRow,
  hostId: string,
): Promise<WorkflowGate> {
  if (!task.worktreePath) return { kind: "clear" };
  const files = await listWorkflowFiles(app, task.worktreePath, hostId);
  if (files === null || files.length === 0) return { kind: "clear" };
  const sha = (await resolveHeadSha(app, task.worktreePath, hostId)) ?? "";
  if (sha !== "" && sha === task.workflowApprovedSha) return { kind: "approved", sha };
  return { kind: "held", change: { sha, files } };
}

/** Records the hold on the task row so the board and drawer can show it. */
export function recordWorkflowHold(
  app: FastifyInstance,
  taskId: number,
  change: WorkflowChange,
): void {
  app.db
    .update(tasks)
    .set({ workflowChange: JSON.stringify(change), updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

/** Drops a hold that no longer applies (the workflow edit was removed). */
export function clearWorkflowHold(app: FastifyInstance, task: TaskRow): void {
  if (!task.workflowChange) return;
  app.db
    .update(tasks)
    .set({ workflowChange: null, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .run();
}

export type ApproveWorkflowResult =
  | { ok: true; sha: string }
  | { ok: false; reason: "nothing-held" | "stale" | "unreadable"; change?: WorkflowChange };

/**
 * Approves the held change. The operator saw the file list for `change.sha`;
 * if the branch has moved on since, the approval is refused (`stale`) with the
 * fresh change recorded, so a commit made between viewing and clicking can
 * never ride along on an approval given for different content.
 */
export async function approveWorkflowChange(
  app: FastifyInstance,
  task: TaskRow,
  hostId: string,
  expectedSha: string,
): Promise<ApproveWorkflowResult> {
  const held = parseWorkflowChange(task.workflowChange);
  if (!held) return { ok: false, reason: "nothing-held" };
  const gate = await evaluateWorkflowGate(app, task, hostId);
  if (gate.kind === "clear") {
    clearWorkflowHold(app, task);
    return { ok: false, reason: "nothing-held" };
  }
  if (gate.kind === "approved") return { ok: true, sha: gate.sha };
  const { change } = gate;
  if (change.sha === "") return { ok: false, reason: "unreadable", change };
  if (change.sha !== expectedSha) {
    recordWorkflowHold(app, task.id, change);
    return { ok: false, reason: "stale", change };
  }
  app.db
    .update(tasks)
    .set({ workflowApprovedSha: change.sha, workflowChange: null, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .run();
  return { ok: true, sha: change.sha };
}
