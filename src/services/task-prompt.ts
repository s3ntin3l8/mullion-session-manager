/**
 * Task Master prompt construction — the single place every spawned Task
 * Master agent's initial prompt is built.
 *
 * Before this module the four spawn sites (`task-claim.ts`'s claim and
 * retry, `task-reconciler.ts`'s review agent, `routes/tasks.ts`'s reject
 * re-seed) each assembled their own inline template literal, and the worker
 * ones were literally `${task.title}\n\n${task.body}` — the issue text and
 * nothing else. That left the agent to guess a completion contract it
 * cannot see from inside the worktree, and several of the rules are
 * counter-intuitive enough that guessing reliably goes wrong:
 *
 * - Ending the turn IS the completion signal. It's purely observed — the
 *   Stop hook maps to `progress:{phase:"done"}`, which latches
 *   `lastTurnEndedAt`, which makes `deriveSessionStatus` report `finished`,
 *   which is what `task-reconciler.ts` waits for to move `in_progress →
 *   reviewing`. There is no marker to write, tool to call, or endpoint to
 *   hit. (Verified for all three agents that can actually be claimed:
 *   claude-code via `mapClaudeCodeStop`, codex via `mapCodexStop`, agy via
 *   `mapAgyEvent`'s `case "Stop"` — all in hooks/forwarder-core.mjs.)
 * - But exiting the process is the opposite of finishing:
 *   `session-reconciler.ts` fails any task still `claimed`/`in_progress`
 *   whose session died. "Stop talking" and "quit" look identical from
 *   inside the agent and could not be further apart from outside it.
 * - An outstanding background job suppresses `finished` entirely
 *   (`session-status.ts` gates it on `outstandingBackgroundTasks === 0`),
 *   so the task silently rides its budget out instead of reaching review.
 * - Untracked files block approval exactly as hard as uncommitted edits —
 *   `task-promote.ts` refuses a `dirty-tree`, and `git status --porcelain`
 *   counts untracked as dirty. A leftover scratch file is enough.
 *
 * None of that is in `docs/agent-guide.md`, in an MCP tool, or in a CLI
 * subcommand, so the prompt is the only channel that reaches every agent.
 * Deliberately a plain string builder with no Fastify/DB dependency: the
 * callers already hold everything it needs, and keeping it pure is what
 * makes the wording directly unit-testable.
 */

import path from "node:path";

/** The subset of a `tasks` row every prompt builder needs. Structural
 * rather than `typeof tasks.$inferSelect` so tests can pass a literal and
 * so it's obvious at a glance that nothing here touches runtime state. */
export interface TaskPromptTask {
  id: number;
  issueNumber: number | null;
  title: string;
  body: string | null;
}

/** Separates the machinery from the issue text, so an agent can tell which
 * part is Mullion talking and which part is the human's spec. */
const SECTION_BREAK = "\n\n---\n\n";

function taskLabel(task: TaskPromptTask): string {
  return task.issueNumber === null
    ? `task ${task.id}`
    : `task ${task.id} (GitHub issue #${task.issueNumber})`;
}

/** The issue text as the agent should see it — title, then body when there
 * is one. Matches the pre-existing `${title}\n\n${body}` shape exactly, so
 * the spec half of the prompt is unchanged by this module. */
function taskSpec(task: TaskPromptTask): string {
  return task.body ? `${task.title}\n\n${task.body}` : task.title;
}

export interface WorkerPreambleOptions {
  task: TaskPromptTask;
  branchName: string;
  worktreePath: string;
  /** `settings.taskMaster.budgetMinutes`; `0` means unlimited, in which
   * case the budget line is omitted rather than promising "0 minutes". */
  budgetMinutes: number;
  /** `claimTask`'s own `opts.auto`. Gates ONE bullet: the instruction not
   * to stop and ask. A human who clicked Claim is sitting right there, and
   * telling that agent to decide unilaterally suppresses exactly the
   * check-in a manual claim wants. Everything else in the preamble applies
   * identically either way. */
  auto: boolean;
}

/**
 * The standing "how Task Master works" block prepended to every worker
 * spawn. Kept to the things an agent cannot discover from inside the
 * worktree — deliberately NOT a restatement of CLAUDE.md, which the agent
 * already reads (the worktree is a checkout of the same repo).
 */
export function buildTaskMasterPreamble(opts: WorkerPreambleOptions): string {
  const { task, branchName, worktreePath, budgetMinutes, auto } = opts;

  const lines = [
    `You are working ${taskLabel(task)} as a Mullion Task Master worker.`,
    "",
    `Your working directory is a git worktree at ${worktreePath}, already checked out`,
    `on branch ${branchName}. Do all your work there. Do not switch, rebase onto, or`,
    `create another branch — Mullion pushes ${branchName} by name, so work anywhere`,
    "else is invisible to it.",
    "",
    "When you are done:",
    "",
    `- Commit your work on ${branchName}. Uncommitted changes never reach the pull`,
    '  request, and the review summary reports them as "nothing changed".',
    "- Leave the worktree clean. Untracked files count as dirty and block approval",
    "  just as hard as uncommitted edits — delete scratch files or gitignore them.",
    "- End your turn and stay running. Ending your turn is what signals completion",
    "  and moves this task to review; there is nothing to call and no file to write.",
    "  Do NOT run `exit` or `/quit` — if the session dies before the task reaches",
    "  review, the task is marked failed no matter how good the work was.",
    "- Finish or cancel any background job before you end your turn. An outstanding",
    "  one suppresses the completion signal, and the task will sit until its budget",
    "  runs out.",
  ];

  if (auto) {
    lines.push(
      "- Nobody is watching this session. Do not stop to ask a question or wait on a",
      "  permission prompt — make a reasonable decision and record it in your commit",
      "  message.",
    );
  }

  lines.push(
    "",
    "Mullion does the rest: it pushes the branch, opens the pull request, and",
    "comments on and closes the issue once a human approves. Do not push, open a",
    "pull request, or comment on the issue yourself.",
  );

  if (budgetMinutes > 0) {
    lines.push(
      "",
      `Budget: ${budgetMinutes} minutes from when this task was claimed, after which`,
      "the session is killed without warning.",
    );
  }

  return lines.join("\n");
}

export interface WorkerPromptOptions extends WorkerPreambleOptions {
  /** `"retry"` adds one line telling the agent the branch already carries
   * earlier work — otherwise a retry looks like a fresh start on a
   * mysteriously non-empty tree. */
  mode: "claim" | "retry";
}

/** The full initial prompt for a claim or retry spawn: preamble, break,
 * then the issue text. */
export function buildWorkerPrompt(opts: WorkerPromptOptions): string {
  const preamble = buildTaskMasterPreamble(opts);
  const retryNote =
    opts.mode === "retry"
      ? `\n\nThis is a retry — ${opts.branchName} already carries the earlier attempt's` +
        " commits. Continue from them rather than starting over."
      : "";
  return `${preamble}${retryNote}${SECTION_BREAK}${taskSpec(opts.task)}`;
}

/**
 * Absolute path a review agent should write its findings to —
 * round-suffixed and deliberately OUTSIDE the worktree (see
 * `buildReviewPrompt`'s own doc comment on why writing inside it is
 * forbidden). Shared between `buildReviewPrompt` (which tells the agent
 * where to write) and `task-reconciler.ts` (which reads the file back) so
 * the two can never compute different paths for the same round.
 *
 * Round-suffixed, not a fixed per-task path: a task enters "reviewing"
 * twice when its first round auto-returns to the worker (see
 * task-reconciler.ts's review-feedback loop), and the prompt tells the
 * reviewer to write nothing when it has no findings — a fixed path would
 * leave round 1's file in place for round 2's reconcile pass to
 * re-ingest as if it were new.
 */
export function taskReviewFindingsPath(sessionsDir: string, taskId: number, round: number): string {
  return path.join(sessionsDir, `task-${taskId}.review.${round}.md`);
}

/**
 * The reject re-seed's prompt (`routes/tasks.ts`).
 *
 * Note this path only fires when the previous session has already exited —
 * a live agent picks the feedback up itself. That makes the spawned agent a
 * COMPLETELY fresh one with no memory of the task, which is why the task
 * spec is included here: the pre-existing prompt sent only the feedback
 * text, so a re-seeded agent was told "this was rejected, here's why" about
 * work it had never seen and a spec it had never read.
 */
export function buildRejectPrompt(
  opts: WorkerPreambleOptions & { feedback: string | null },
): string {
  const preamble = buildTaskMasterPreamble(opts);
  const rejection = opts.feedback
    ? `A human reviewed this task and requested changes:\n\n${opts.feedback}`
    : "A human reviewed this task and asked for more work on it.";
  return `${preamble}${SECTION_BREAK}${rejection}${SECTION_BREAK}${taskSpec(opts.task)}`;
}

/**
 * The review agent's prompt (`task-reconciler.ts`).
 *
 * Keeps the original first sentence verbatim — the review agent is not
 * expected to make changes, and that framing is load-bearing (agy's own
 * global `agentMode: "plan"`, for instance, makes it incapable of changes
 * regardless). It is no longer purely advisory, though: non-empty findings
 * can now drive one bounded `reviewing -> in_progress` round back to the
 * worker (see task-reconciler.ts's review-feedback loop) before a human
 * reviews again — see docs/tasks.md's Task → PR promotion section. Keeps
 * the one hazard the original prompt already warned about: the reviewer
 * runs in the WORKER's own worktree, not a copy, so anything it writes
 * there (other than the findings file below, which lives outside it)
 * dirties the tree and blocks the human's approve via `task-promote.ts`'s
 * `dirty-tree` refusal.
 */
export function buildReviewPrompt(opts: {
  task: TaskPromptTask;
  worktreePath: string;
  findingsPath: string;
}): string {
  const preamble = [
    "Review this task's diff. You are not expected to make changes.",
    "",
    `You are running inside the worker's own git worktree at ${opts.worktreePath} —`,
    "not a copy. Do not create or modify any file here: an untracked or modified",
    "file blocks the human's approval of this task.",
    "",
    "Report your findings in this session, AND write them (as plain text or",
    `markdown) to ${opts.findingsPath} — that path is outside the worktree, so`,
    "writing it does not block approval. If you have no findings, do not create",
    "that file at all.",
    "",
    "Write findings as clear, actionable instructions, not just observations:",
    "non-empty findings may be sent back to the worker automatically, once, to",
    "act on before a human reviews again.",
    "",
    "End your turn and stay running once you are done. Ending your turn is what",
    "signals your review is complete; do NOT run `exit` or `/quit` — a review",
    "session that exits on its own is treated the same as one that crashed.",
  ].join("\n");
  return `${preamble}${SECTION_BREAK}Task: ${taskSpec(opts.task)}`;
}

/**
 * The review-feedback auto-return's prompt (`task-reconciler.ts`) — the
 * review agent's own findings, delivered the same way a human's reject
 * feedback is (`buildRejectPrompt`), since the worker doesn't need to know
 * WHO sent it back, only what to fix. Always carries the task spec, same
 * reasoning as `buildRejectPrompt`: this only actually reaches an agent
 * once `reseedTaskIfSessionExited` (`task-reseed.ts`) decides the previous
 * session is gone, so it may be a completely fresh one with no memory of
 * the task.
 */
export function buildReviewFeedbackPrompt(
  opts: WorkerPreambleOptions & { findings: string },
): string {
  const preamble = buildTaskMasterPreamble(opts);
  const feedback = `An automated review of your work found the following:\n\n${opts.findings}`;
  return `${preamble}${SECTION_BREAK}${feedback}${SECTION_BREAK}${taskSpec(opts.task)}`;
}
