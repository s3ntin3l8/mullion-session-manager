import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { gitEnv } from "../../src/services/git-env.js";
import {
  createWorktree,
  deriveTaskBranchName,
  removeWorktreeIfClean,
} from "../../src/services/git-worktree.js";
import { tasks } from "../../src/db/schema.js";

// The fixture the retry-side tests share: a real git repository, a real task
// project, and a `failed` task that still holds its preserved branch — the
// exact shape `retryTask` resumes from.
//
// It lives here rather than in either test file because both need it, and a
// copy that drifts is a copy that stops testing what it claims to: the
// preserved-branch shape IS the thing under test (a `failed` task whose branch
// survived its failure), so both files must reconstruct it identically.
//
// The `node-pty` / `node:child_process` mocks stay at the call sites (Vitest
// hoists a `vi.mock` factory above the imports, and the factory can only
// close over a binding that is initialized before it runs — see
// test/helpers/mock-pty.ts's header). This module imports
// src/services/git-worktree.js, which pulls in `node:child_process`, so a
// test file that uses it MUST import test/helpers/mock-spawn.js (and
// mock-pty.js) before it — the ordering is load-bearing, not cosmetic.

export function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

/** A throwaway git repository with one commit on `main` — the base ref a
 * task's worktree is cut from. */
export function createTaskGitRepo(prefix = "task-retry-fixture-repo-"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

/** A project whose cwd is the fixture repo — the task's project, so the
 * worktree operations below have somewhere real to run. */
export async function createTaskProject(
  app: FastifyInstance,
  cwd: string,
  name = "task-retry-fixture-p",
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name, cwd },
  });
  return res.json().id as number;
}

/**
 * Reconstructs the real →failed lifecycle shape: a worker claimed the task,
 * committed real work on `mullion/task-<id>`, then failed — the failure
 * cleanup removed the worktree DIRECTORY while deliberately leaving the branch
 * (and its commit) intact, which is exactly what makes a retry able to resume
 * it.
 *
 * `over` sets the columns that distinguish the cases a caller cares about:
 * `archivedAt` (the user hid the row — #1015 keeps that retryable) and
 * `supersededAt` (a project merge superseded this copy — #2292 refuses it).
 */
export async function insertFailedTaskWithPreservedBranch(
  app: FastifyInstance,
  projectId: number,
  cwd: string,
  issueNumber: number | null,
  over: {
    archivedAt?: Date | null;
    supersededAt?: Date | null;
    issueNumber?: number | null;
    failureReason?: string | null;
  } = {},
): Promise<typeof tasks.$inferSelect> {
  // Inserted first (as a throwaway "ready" row) purely to get a real task id:
  // branchName must match `mullion/task-<id>` exactly, the same closed
  // namespace resumeTaskWorktree/clearOrphanedTaskWorktree enforce, so it
  // can't be derived until the id exists.
  const [placeholder] = app.db
    .insert(tasks)
    .values({ projectId, issueNumber, title: "t", status: "ready" })
    .returning()
    .all();
  const branchName = deriveTaskBranchName(placeholder);

  const created = await createWorktree({ cwd, baseRef: "main", seed: branchName, branchName });
  if (!created?.path) throw new Error("test setup: failed to create worktree");
  fs.writeFileSync(path.join(created.path, "work.txt"), "real committed work");
  git(created.path, ["add", "-A"]);
  git(created.path, ["commit", "-m", "agent did real work", "--no-verify"]);
  const removed = await removeWorktreeIfClean(created.path, cwd);
  if (!removed.removed) throw new Error("test setup: failed to remove worktree");

  const [row] = app.db
    .update(tasks)
    .set({
      status: "failed",
      failureReason: over.failureReason ?? "budget exceeded after 120 minutes",
      completedAt: new Date(),
      worktreePath: created.path,
      branchName,
      sessionId: null,
      ...(over.issueNumber !== undefined ? { issueNumber: over.issueNumber } : {}),
      ...(over.archivedAt !== undefined ? { archivedAt: over.archivedAt } : {}),
      ...(over.supersededAt !== undefined ? { supersededAt: over.supersededAt } : {}),
    })
    .where(eq(tasks.id, placeholder.id))
    .returning()
    .all();
  return row;
}
