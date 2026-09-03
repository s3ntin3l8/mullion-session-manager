// #939/#1016 — resolves everything a worker's prompt gets beyond a task's
// own title+body: comments on its own issue, a parent tracking issue's own
// spec+comments (if any), and sibling sub-issues Mullion already knows
// about locally. Before this, a worker saw literally `${title}\n\n${body}`
// and nothing else (task-prompt.ts's taskSpec) — invisible to it were any
// clarification/correction left as a comment, and, for a child of a
// tracking epic, the epic's own spec and the discussion that shaped it
// (epic #939's own body: "see each issue's comments for results" on six
// spikes a worker on any one stream would otherwise never see).
//
// Fetching lives here, deliberately NOT in task-prompt.ts — that module's
// own header doc comment states its purity invariant ("no Fastify/DB
// dependency… what makes the wording directly unit-testable"). This module
// resolves the DATA; task-prompt.ts only renders it.
//
// Fail-open throughout, by design: this is advisory prompt text, not a
// claim gate, unlike task-dependencies.ts's dependencyCount (which
// fail-closes an unresolved value to "blocked"). Any failure anywhere in
// `resolveTaskIssueContext` below propagates as a rejected promise;
// `resolveTaskIssueContextSafe` is what every call site actually calls —
// it catches, logs one warning, and returns `null`, so a GitHub hiccup
// (rate limit, network blip, a private/deleted parent) degrades a spawn to
// today's plain title+body prompt rather than blocking it.
import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import { resolveRepoRef } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { getIssue, listIssueComments } from "./github.js";
import type { TaskPromptComment, TaskPromptParent, TaskPromptSibling } from "./task-prompt.js";

// Fetch-side cap, independent of task-prompt.ts's own MAX_RENDERED_COMMENTS
// render-side cap — this one bounds the GitHub request itself (a `per_page`
// query param), the render one bounds what a caller handing this module's
// output straight to a prompt builder ends up showing. Kept in sync
// informally (both currently 10); a future divergence is fine; this cap is
// what protects the API call, not the prompt.
const MAX_FETCHED_COMMENTS = 10;

export interface TaskIssueContext {
  comments: TaskPromptComment[];
  parent: TaskPromptParent | null;
  siblings: TaskPromptSibling[];
}

/** The subset of a `tasks` row + its `projects` row that resolution needs —
 * structural, like task-prompt.ts's own `TaskPromptTask`, so a caller can
 * pass a real DB row without reshaping it. */
export interface TaskIssueContextInput {
  id: number;
  projectId: number;
  issueNumber: number | null;
  parentIssueNumber: number | null;
  parentIssueRepo: string | null;
}

export interface TaskIssueContextProject {
  cwd: string;
  hostId: string;
}

/**
 * Resolves the full context for one task. Throws on any failure — callers
 * should use `resolveTaskIssueContextSafe` below instead, unless they have
 * their own reason to handle a failure differently (none do today).
 */
export async function resolveTaskIssueContext(
  app: FastifyInstance,
  task: TaskIssueContextInput,
  project: TaskIssueContextProject,
): Promise<TaskIssueContext | null> {
  if (task.issueNumber === null) return null;

  const repoRef = await resolveRepoRef(app, project);
  if (!repoRef) return null;

  // "write" (the default scope) — deliberately, not "read": READ_PERMISSIONS
  // (github-app.ts) carries no `issues` permission at all, only
  // actions/metadata/pull_requests, so a "read"-scoped App token 403s on an
  // issue-comments GET. task-watcher.ts's own ingest read (listLabeledIssues)
  // hits the same constraint and resolves the same way — see that file's own
  // token resolution for the precedent.
  const token = await resolveGitHubToken(app, repoRef);
  if (!token) return null;

  const comments = await listIssueComments(
    token,
    repoRef.owner,
    repoRef.repo,
    task.issueNumber,
    MAX_FETCHED_COMMENTS,
  );

  let parent: TaskPromptParent | null = null;
  if (task.parentIssueNumber !== null && task.parentIssueRepo !== null) {
    // parentIssueRepo is `"owner/repo"` (#701's own doc comment, schema.ts) —
    // a parent can live in a different repo than the child's own project.
    const slashIndex = task.parentIssueRepo.indexOf("/");
    const parentOwner = slashIndex > 0 ? task.parentIssueRepo.slice(0, slashIndex) : null;
    const parentRepo = slashIndex > 0 ? task.parentIssueRepo.slice(slashIndex + 1) : null;
    if (parentOwner && parentRepo) {
      const [parentIssue, parentComments] = await Promise.all([
        getIssue(token, parentOwner, parentRepo, task.parentIssueNumber),
        listIssueComments(
          token,
          parentOwner,
          parentRepo,
          task.parentIssueNumber,
          MAX_FETCHED_COMMENTS,
        ),
      ]);
      parent = {
        number: task.parentIssueNumber,
        repo: task.parentIssueRepo,
        title: parentIssue.title,
        body: parentIssue.body,
        comments: parentComments,
      };
    }
  }

  // Siblings — the local DB only, zero GitHub calls, same relation
  // TaskDetail.tsx's own Hierarchy section already uses (matched on BOTH
  // parentIssueNumber and parentIssueRepo, scoped to this project — a
  // same-number-different-repo parent is a real, distinct case #701
  // explicitly designed for, not a coincidence to collapse).
  const siblings =
    task.parentIssueNumber !== null && task.parentIssueRepo !== null
      ? app.db
          .select({ issueNumber: tasks.issueNumber, title: tasks.title, status: tasks.status })
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, task.projectId),
              eq(tasks.parentIssueNumber, task.parentIssueNumber),
              eq(tasks.parentIssueRepo, task.parentIssueRepo),
              ne(tasks.id, task.id),
              isNotNull(tasks.issueNumber),
            ),
          )
          .all()
          .map((row) => ({ issueNumber: row.issueNumber!, title: row.title, status: row.status }))
      : [];

  return { comments, parent, siblings };
}

/**
 * The fail-open wrapper every actual spawn site calls. A caught failure
 * logs one warning and returns `null` — task-prompt.ts's builders all treat
 * `undefined`/absent context fields identically to "there was nothing to
 * add," so a `null` here simply means the spawned prompt looks exactly like
 * it did before this feature existed.
 */
export async function resolveTaskIssueContextSafe(
  app: FastifyInstance,
  task: TaskIssueContextInput,
  project: TaskIssueContextProject,
): Promise<TaskIssueContext | null> {
  try {
    return await resolveTaskIssueContext(app, task, project);
  } catch (err) {
    app.log.warn(
      { err, taskId: task.id, issueNumber: task.issueNumber },
      "[task-issue-context] could not resolve extra issue context for this spawn — proceeding with the plain prompt",
    );
    return null;
  }
}
