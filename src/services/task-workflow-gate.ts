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
// This module is the enforcement, not GitHub. Only an App installation token
// is refused by GitHub for lacking `workflows`; the shared PAT/OAuth fallback
// (resolveGitHubToken) may carry the `workflow` scope and would push a workflow
// edit unchallenged. So anything this module cannot positively verify as free
// of workflow changes is `unverified` and waits, rather than reading as clear.
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
  /** Verified: nothing under `.github/workflows/` changed. */
  | { kind: "clear" }
  /** The changed files could not be read (a diff timeout, no base ref, an
   * unreachable host, an agent build that predates the gate). Never treated
   * as clear: the push waits and is retried, with no operator action. */
  | { kind: "unverified"; detail: string }
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

/** Start of every `unverified` detail, so a later hold can recognise (and
 * drop) a banner this gate wrote without touching other sync errors. */
export const WORKFLOW_UNVERIFIED_PREFIX =
  "Could not verify whether this branch changes .github/workflows/";

/** Why the changed files could not be read. */
type WorkflowFilesUnknown = "no-base" | "host";

/** Workflow files the task's branch changes against the repo's default
 * base, read fresh (never the 5 s diff-stat cache), or why they could not be
 * read. "Unknown" is deliberately distinct from `[]` (verified none). */
async function listWorkflowFiles(
  app: FastifyInstance,
  cwd: string,
  hostId: string,
): Promise<string[] | WorkflowFilesUnknown> {
  if (hostId === LOCAL_HOST_ID) {
    // No base ref -> no branch diff to inspect (`git diff HEAD` of a clean
    // tree is empty whatever the branch holds), so that is "unknown", not "none".
    const base = getDefaultBaseRef(cwd);
    if (base === null) return "no-base";
    const stats = await getDiffStats(cwd, base, { fresh: true });
    return stats?.workflowFiles ?? "host";
  }
  try {
    const { stats, baseResolved } = await getRemoteHostClient(app, hostId).resolveGitDiffStats(
      cwd,
      "AUTO",
      { fresh: true },
    );
    // Same rule as the local branch: an unresolvable base made the host diff
    // `HEAD`, whose EMPTY result must not read as "no workflow changes". A
    // non-empty list is a real workflow edit whatever the base, so it still
    // holds (and shows the Approve panel). The flag must be positively `true`
    // for an empty list to count: a host agent that predates it omits the key,
    // and that skew reads as unknown (retried, with "update the host agent").
    if (baseResolved !== true && !stats?.workflowFiles?.length) {
      return baseResolved === false ? "no-base" : "host";
    }
    return stats?.workflowFiles ?? "host";
  } catch {
    return "host";
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
 * An unreadable file list is `unverified`, never `clear`.
 */
export async function evaluateWorkflowGate(
  app: FastifyInstance,
  task: TaskRow,
  hostId: string,
): Promise<WorkflowGate> {
  if (!task.worktreePath) return { kind: "clear" };
  const files = await listWorkflowFiles(app, task.worktreePath, hostId);
  if (files === "no-base") {
    return {
      kind: "unverified",
      detail: `${WORKFLOW_UNVERIFIED_PREFIX} — the repository has no origin/main or origin/master ref to diff against (fetch the remote; retrying)`,
    };
  }
  if (files === "host") {
    return {
      kind: "unverified",
      detail: `${WORKFLOW_UNVERIFIED_PREFIX} — the diff could not be read on its host (retrying; update the host agent if this persists)`,
    };
  }
  if (files.length === 0) return { kind: "clear" };
  const sha = (await resolveHeadSha(app, task.worktreePath, hostId)) ?? "";
  if (sha !== "" && sha === task.workflowApprovedSha) return { kind: "approved", sha };
  return { kind: "held", change: { sha, files } };
}

/**
 * Records the hold on the task row so the board and drawer can show it.
 * Returns whether this is a NEW hold (a different head commit than the one
 * already recorded): the push is retried on every sweep tick, and only the
 * first sighting of a head is worth telling the operator about.
 */
export function recordWorkflowHold(
  app: FastifyInstance,
  taskId: number,
  change: WorkflowChange,
): boolean {
  const previous = app.db
    .select({ workflowChange: tasks.workflowChange })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  const isNew = parseWorkflowChange(previous?.workflowChange ?? null)?.sha !== change.sha;
  app.db
    .update(tasks)
    .set({ workflowChange: JSON.stringify(change), updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
  return isNew;
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
  if (gate.kind === "unverified") return { ok: false, reason: "unreadable" };
  if (gate.kind === "clear") {
    clearWorkflowHold(app, task);
    return { ok: false, reason: "nothing-held" };
  }
  if (gate.kind === "approved") {
    clearWorkflowHold(app, task);
    return { ok: true, sha: gate.sha };
  }
  const { change } = gate;
  if (change.sha === "") return { ok: false, reason: "unreadable", change };
  if (change.sha !== expectedSha) {
    // Deliberately not announced: this is the operator's own approval click
    // finding the branch moved, so they are already looking at it (the push
    // path, task-promote.ts's holdWorkflowChange, announces a new hold).
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
