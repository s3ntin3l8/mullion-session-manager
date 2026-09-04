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

/** A single issue comment, as rendered in a worker's prompt — a local shape
 * rather than importing github.ts's own `GitHubIssueComment`, matching this
 * module's established "plain string builder, no dependency on what fetched
 * the data" convention (see `ReviewCiInfo`/`PrReviewCommentInfo` below for
 * the same pattern). */
export interface TaskPromptComment {
  author: string | null;
  body: string;
  createdAt: string;
}

/** A parent tracking issue's own spec+comments (#701's `parentIssueNumber`/
 * `parentIssueRepo` resolved to content by task-issue-context.ts) — `null`
 * distinct from `undefined`/absent the same way `TaskIssue.parent` already
 * is (github.ts): `undefined` means "not resolved for this spawn" (a local
 * task, or a failed lookup — see `taskSpec`'s own fail-open posture), `null`
 * means "resolved, and this task genuinely has no parent." */
export interface TaskPromptParent {
  number: number;
  repo: string;
  title: string;
  body: string | null;
  comments: TaskPromptComment[];
}

/** A sibling sub-issue under the same parent that Mullion already knows
 * about locally — zero GitHub calls (task-issue-context.ts reads this off
 * the `tasks` table directly), so it's cheap enough to always resolve
 * whenever a parent is known. */
export interface TaskPromptSibling {
  issueNumber: number;
  title: string;
  status: string;
}

/** The subset of a `tasks` row every prompt builder needs. Structural
 * rather than `typeof tasks.$inferSelect` so tests can pass a literal and
 * so it's obvious at a glance that nothing here touches runtime state.
 *
 * `comments`/`parent`/`siblings` (#939/#1016) are optional ADDITIONS to
 * what a worker sees beyond title+body — resolved once per spawn by
 * task-issue-context.ts and threaded straight through here, never fetched
 * by this module itself (see this file's own header doc comment on why:
 * "no Fastify/DB dependency… what makes the wording directly
 * unit-testable"). All three are absent (`undefined`) for a local
 * (non-GitHub) task, or when the resolution attempt itself failed —
 * task-issue-context.ts fails OPEN, never blocking a spawn on a GitHub
 * hiccup, the same "advisory, not a gate" posture #701's own display-only
 * hierarchy columns already established (unlike `dependencyCount`'s
 * fail-closed nullability). */
export interface TaskPromptTask {
  id: number;
  issueNumber: number | null;
  title: string;
  body: string | null;
  comments?: TaskPromptComment[];
  parent?: TaskPromptParent | null;
  siblings?: TaskPromptSibling[];
}

/** Separates the machinery from the issue text, so an agent can tell which
 * part is Mullion talking and which part is the human's spec. */
const SECTION_BREAK = "\n\n---\n\n";

function taskLabel(task: TaskPromptTask): string {
  return task.issueNumber === null
    ? `task ${task.id}`
    : `task ${task.id} (GitHub issue #${task.issueNumber})`;
}

// #939/#1016 — render caps, kept in this module (not task-issue-context.ts)
// so they're covered by this file's own pure-function unit tests. A comment
// count cap on top of task-issue-context.ts's own fetch-side cap (belt and
// suspenders: this module must render correctly regardless of how many
// comments a caller hands it) and a per-comment char cap — #939's own epic
// thread is long, and an agent's context is not infinite.
const MAX_RENDERED_COMMENTS = 10;
const COMMENT_BODY_MAX_CHARS = 800;

function truncateComment(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= COMMENT_BODY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, COMMENT_BODY_MAX_CHARS)}…`;
}

/** Renders up to `MAX_RENDERED_COMMENTS`, newest-last (matches the fetch
 * order task-issue-context.ts already returns), with an elided-count line
 * when there were more — so the agent knows something was dropped rather
 * than silently seeing a partial thread as if it were the whole one. */
function renderComments(comments: TaskPromptComment[] | undefined, heading: string): string {
  if (!comments || comments.length === 0) return "";
  const shown = comments.slice(-MAX_RENDERED_COMMENTS);
  const elided = comments.length - shown.length;
  const lines = [
    heading,
    ...(elided > 0
      ? [`(${elided} earlier comment${elided === 1 ? "" : "s"} omitted for length)`]
      : []),
    ...shown.map((c) => `- ${c.author ? `@${c.author}` : "someone"}: ${truncateComment(c.body)}`),
  ];
  return lines.join("\n");
}

/** The framing sentence is the whole point of injecting a parent at all —
 * without it, a worker handed an epic's full spec reads it as ITS task and
 * attempts every stream in it (#939 is a live example: six sibling streams
 * in one body). */
function renderParent(parent: TaskPromptParent | null | undefined): string {
  if (!parent) return "";
  const lines = [
    `## Parent tracking issue #${parent.number} (${parent.repo}) — context only, not your task`,
    "",
    "The section below is the parent epic's own spec and discussion. It is",
    "context only, not your task — your task is the issue above this break.",
    "Do not implement the epic's other streams; the sibling list (if any)",
    "below shows which ones are somebody else's.",
    "",
    parent.body ? `${parent.title}\n\n${parent.body}` : parent.title,
  ];
  const commentsBlock = renderComments(parent.comments, "\nParent issue comments:");
  if (commentsBlock) lines.push(commentsBlock);
  return lines.join("\n");
}

function renderSiblings(siblings: TaskPromptSibling[] | undefined): string {
  if (!siblings || siblings.length === 0) return "";
  return [
    "## Sibling sub-issues",
    "",
    "Other issues under the same parent that Mullion already knows about —",
    "somebody else's job, not yours:",
    "",
    ...siblings.map((s) => `- #${s.issueNumber} (${s.status}): ${s.title}`),
  ].join("\n");
}

/** The issue text as the agent should see it — title, then body when there
 * is one (matches the pre-existing `${title}\n\n${body}` shape exactly when
 * no extra context is present, so the spec half of the prompt is unchanged
 * for the common case), then any of comments/parent/siblings that were
 * resolved for this spawn, each its own `SECTION_BREAK`-separated block. */
function taskSpec(task: TaskPromptTask): string {
  const base = task.body ? `${task.title}\n\n${task.body}` : task.title;
  const extras = [
    renderComments(task.comments, "## Comments on this issue"),
    renderParent(task.parent),
    renderSiblings(task.siblings),
  ].filter((block) => block.length > 0);
  return extras.length === 0 ? base : [base, ...extras].join(SECTION_BREAK);
}

export interface WorkerPreambleOptions {
  task: TaskPromptTask;
  branchName: string;
  worktreePath: string;
  /** `settings.taskMaster.budgetMinutes`; `0` means unlimited, in which
   * case the budget line is omitted rather than promising "0 minutes". */
  budgetMinutes: number;
  /** `enqueueTask`'s own `opts.auto`. Gates ONE bullet: the instruction not
   * to stop and ask. A human who clicked Claim is sitting right there, and
   * telling that agent to decide unilaterally suppresses exactly the
   * check-in a manual claim wants. Everything else in the preamble applies
   * identically either way. */
  auto: boolean;
  /** #761 — set (via `taskCommitTitlePath`) only when the project has
   * `conventionalCommitTitles` on; omitted entirely otherwise, which is
   * what gates the title-file instruction below. Every caller of this
   * preamble passes the same resolved path, so a worker re-seeded mid-task
   * (retry, reject, a review-feedback or red-CI auto-return round) sees an
   * identical instruction each time — the title can legitimately change
   * between rounds (a fix-up round's type may differ from the initial
   * round's), so this is intentionally NOT claim-only. */
  commitTitlePath?: string;
}

/**
 * The standing "how Task Master works" block prepended to every worker
 * spawn. Kept to the things an agent cannot discover from inside the
 * worktree — deliberately NOT a restatement of CLAUDE.md, which the agent
 * already reads (the worktree is a checkout of the same repo).
 *
 * The verification-gate and self-review bullets below don't break that rule
 * even though they overlap with what a target repo's own docs might already
 * ask for: both name no commands or tools, so they stay correct across the
 * arbitrary target repos and CLIs Task Master runs against (a Go repo's
 * gate looks nothing like this one's `make lint`; a CLI without a
 * `/code-review` slash command still has "look at your own diff again").
 * Each establishes an obligation a target repo's own docs can't:
 * verification, because Mullion opens the pull request only AFTER the
 * worker's turn ends, so nothing already in a target repo's docs tells the
 * agent it will never see CI's result; self-review, because the worker
 * cannot see from inside the worktree that its diff goes to a separately
 * spawned reviewer that cannot edit files and draws on a small, never-reset
 * round budget shared with CI and PR-comment auto-returns (see
 * `buildReviewPrompt` and `docs/tasks.md`'s "The round budget") — so a
 * defect the worker catches itself is free, and the same defect caught
 * downstream is not.
 */
export function buildTaskMasterPreamble(opts: WorkerPreambleOptions): string {
  const { task, branchName, worktreePath, budgetMinutes, auto, commitTitlePath } = opts;

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
    "- Run the repo's own verification gate before you commit — the commands its",
    "  CLAUDE.md / AGENTS.md / README document (lint, typecheck, tests, formatting),",
    "  not just the test suite. Mullion opens the pull request AFTER your turn ends,",
    "  so you never see CI's result: do not claim CI is green. Report only what you",
    "  actually ran, and say so plainly if you skipped something.",
    "- Look over your own diff with fresh eyes before committing. A separate",
    "  reviewer sees this diff afterwards but cannot edit anything in it — so a",
    "  defect you catch now is free, and the same defect caught downstream costs",
    "  this task one of a small, non-renewing number of automatic fix-up rounds.",
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

  if (commitTitlePath) {
    lines.push(
      `- Write a Conventional Commits title for this pull request to ${commitTitlePath} —`,
      "  a single line, no trailing newline, shaped like",
      '  "type(scope)?: description" (types: feat, fix, chore, docs, refactor, perf,',
      '  test, build, ci, style, revert; scope is optional; add "!" before the colon',
      "  for a breaking change). This path is outside the worktree, so writing it does",
      "  not block approval. It reflects what you actually did — pick fix: over feat:",
      "  for a bug fix even if the underlying task description says otherwise. If you",
      "  are re-seeded for another round, rewrite this file only if the type should",
      "  change; otherwise leave the existing one in place.",
    );
  }

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
    "",
    "If, after a previous turn, the board still shows no pull request AND a",
    "GitHub sync error, that push or PR-open failed on Mullion's side — not",
    "something committing again will fix. Say so plainly in your final message",
    "instead of repeating the same turn.",
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
        " commits. Continue from them rather than starting over. If the most recent" +
        ' commit\'s message starts with "wip:", it is a machine-made salvage commit' +
        " Mullion made when the previous turn ended with uncommitted changes, not real" +
        " progress — fold it into a proper commit (amend it, or `git reset --soft" +
        " HEAD~1` and recommit) before you finish."
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
 * task-reconciler.ts's review-feedback loop). The reviewer is now told to
 * ALWAYS write this file (see `buildReviewPrompt` — a missing file is
 * "inconclusive", not "clean"), but round-suffixing still matters:
 * `unlinkFindingsFileIfPresent` (task-reconciler.ts) deletes each round's
 * file once its content is durably ingested, so round 2's reconcile pass
 * only ever sees round 1's file if that deletion itself failed — a fixed
 * path would instead make that the COMMON case (round 2 silently
 * re-ingesting round 1's leftover content as if it were fresh).
 */
export function taskReviewFindingsPath(sessionsDir: string, taskId: number, round: number): string {
  return path.join(sessionsDir, `task-${taskId}.review.${round}.md`);
}

/**
 * Where a worker should write its Conventional Commits PR title (`#761`) —
 * a `sessionsDir`-relative path, same convention `taskReviewFindingsPath`
 * documents: a file written INSIDE the worktree dirties the tree and trips
 * `promoteTaskToPR`'s `dirty-tree` refusal, and if the agent committed it
 * instead it would pollute the PR diff. Shared between `buildTaskMasterPreamble`
 * (which tells the worker where to write) and `task-reconciler.ts` (which
 * reads it back at the "-> reviewing" transition) so the two can never
 * compute different paths.
 *
 * Deliberately NOT round-suffixed, unlike `taskReviewFindingsPath`: this is
 * read synchronously, once, in the same reconcile tick as the transition
 * that observes the worker's turn as finished — there is no separate
 * polling loop with a grace window that could re-ingest a stale file the
 * way the review-findings loop's own round-suffixing guards against. A
 * worker that finishes a later round without rewriting this file simply
 * leaves the previous round's title in place, which is the right fallback
 * (the title rarely changes between an initial round and a review-feedback
 * fix-up) rather than a bug to guard against.
 */
export function taskCommitTitlePath(sessionsDir: string, taskId: number): string {
  return path.join(sessionsDir, `task-${taskId}.title`);
}

// #761 — Conventional Commits' own spec: type(scope)!: description. `!`
// marks a breaking change; `(scope)` is optional. Intentionally permissive
// on `description` (`.+`) — this validates the STRUCTURE Mullion needs to
// trust the title enough to use it verbatim, not the prose an agent chose.
const CONVENTIONAL_COMMIT_TITLE_PATTERN =
  /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]+\))?!?: .+/;
// GitHub itself allows PR titles far longer than this; bounded here to keep
// a malformed/runaway agent write from becoming a wall of text in the PR
// list and the squash-merge commit log, same spirit as a conventional git
// subject line (traditionally ~50-72 chars) without being that strict.
const MAX_COMMIT_TITLE_LENGTH = 100;

/**
 * Validates and trims a worker-supplied PR title read from
 * `taskCommitTitlePath`. Returns `null` for anything that doesn't parse as
 * a Conventional Commits title or exceeds the length bound — the caller
 * (`task-reconciler.ts`) falls back to the raw task title on `null`, one
 * `app.log.warn`, never blocking promotion (see that column's own doc
 * comment, `schema.ts`).
 */
export function parseCommitTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_COMMIT_TITLE_LENGTH) return null;
  // Reject embedded newlines even though the regex's `.` would already stop
  // at the first one — an explicit check reads clearer than relying on that
  // as the reason a multi-line write gets rejected.
  if (trimmed.includes("\n")) return null;
  return CONVENTIONAL_COMMIT_TITLE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The PR title `task-promote.ts` should actually use — an issue title that
 * ALREADY parses as Conventional Commits wins over the worker-supplied
 * `prTitle`, which only kicks in when the issue title itself doesn't parse.
 *
 * This exists because the release-please auto-enable sweep
 * (project-release-please.ts) turns `conventionalCommitTitles` on for a
 * project even when it was previously an explicit `0` — safe only because
 * of this precedence: a repo whose issue titles were already conventional
 * (this repo's own `fix:`/`chore:`/`fix(tasks):` titles, for instance) keeps
 * using them verbatim, and a worker's own guess never has a chance to
 * downgrade a human-written `feat:` to a worker-guessed `chore:`. Without
 * this, auto-enabling for a repo that didn't need it would be a behavior
 * change, not a no-op.
 *
 * Every one of `task.prTitle`'s four read sites in task-promote.ts
 * (createOrRecoverPR's create, its own 422-adopt re-sync, openDraftPRForTask's
 * re-sync, promoteTaskToPR's approve-time re-sync) must route through this,
 * not read `task.prTitle` directly — otherwise a `#782` re-sync round would
 * overwrite a correctly-kept conventional issue title with `task.prTitle` on
 * the very next round.
 */
export function resolvePrTitle(task: { title: string; prTitle: string | null }): string {
  if (parseCommitTitle(task.title) !== null) return task.title;
  return task.prTitle ?? task.title;
}

/** A single anchored review comment — GitHub's own review-comment shape
 * (`path`/`line`/`side`), so `task-github-sync.ts` can pass these straight
 * through to `createPullRequestReview` with no reshaping. */
export interface ReviewFinding {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "blocker" | "major" | "minor" | "nit" | null;
  body: string;
}

/** The review agent's parsed verdict — deliberately only two values a
 * reviewer can assert. "unknown" (an inconclusive/missing review) is NOT
 * a member here: it's a `task-reconciler.ts`-level fact about the absence
 * of a parseable file, never something `parseReviewFindings` itself
 * returns, so a caller can't accidentally treat "I couldn't tell" as a
 * verdict the agent actually reached. */
export type ReviewVerdict = "clean" | "changes-requested";

export interface ParsedReviewFindings {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  /** What the reviewer says it actually ran/checked (commands, files read) —
   * rendered as its own "Verified" section. Empty when the reviewer omitted
   * it or (see `structured` below) never wrote JSON at all. */
  verified: string[];
  /** Cross-cutting observations that don't anchor to one file:line — kept
   * distinct from `findings` so they never get force-fit into a fake
   * path/line pair just to have somewhere to go. */
  notes: string[];
  /** What's solid about the change — Hermes-parity "Looks Good" content. */
  looksGood: string[];
  /** `true` only when `raw` parsed as the JSON contract `buildReviewPrompt`
   * asks for; `false` on the freeform-fallback branch, where `summary` holds
   * the ENTIRE raw file content rather than one verdict sentence.
   * `renderReviewFindingsMarkdown` uses this to decide whether `summary` is
   * safe to wrap in a "**Verdict:**" line and section headings, or must be
   * returned verbatim — see that function's own doc comment. */
  structured: boolean;
}

/**
 * Normalizes one raw findings-array entry, or returns `null` to drop it —
 * Hermes review, PR #733: an LLM routinely emits `"line": "42"` (a numeric
 * string) rather than a bare number, so `line` is coerced through `Number`
 * before validation rather than type-checked as `"number"` outright. Also
 * range-checks to a positive integer: a `0`, negative, or fractional line
 * would later fail as a GitHub inline-comment anchor (`createPullRequestReview`,
 * task-github-sync.ts) — better to drop it here (falling back to the
 * `changes-requested` verdict already keeping a human in the loop) than
 * surface a 422 downstream.
 */
function normalizeReviewFinding(f: unknown): ReviewFinding | null {
  if (f === null || typeof f !== "object") return null;
  const rec = f as Record<string, unknown>;
  if (typeof rec.path !== "string" || rec.path.length === 0) return null;
  if (typeof rec.body !== "string" || rec.body.length === 0) return null;
  const line = typeof rec.line === "string" ? Number(rec.line) : rec.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) return null;
  return {
    path: rec.path,
    line,
    side: rec.side === "LEFT" ? "LEFT" : "RIGHT",
    severity:
      rec.severity === "blocker" ||
      rec.severity === "major" ||
      rec.severity === "minor" ||
      rec.severity === "nit"
        ? rec.severity
        : null,
    body: rec.body,
  };
}

/** Normalizes an optional raw string-array field (`verified`/`notes`/
 * `looksGood`) the same tolerant way `findings` is: not an array → `[]`;
 * non-string or empty-string entries dropped rather than rejecting the
 * whole file over one bad entry. */
function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Parses a review agent's findings-file content into a verdict — the
 * load-bearing half of the review contract (`task-reconciler.ts`'s
 * `isUsableSignal`/`shouldAutoReturn` key off the returned `verdict`, not
 * off whether findings are non-empty; see that file's own doc comment on
 * why file-existence was never a safe signal).
 *
 * Tolerant by construction: `raw` comes from an LLM that may ignore the
 * JSON contract `buildReviewPrompt` asks for. Anything that isn't valid
 * JSON matching the expected shape is treated as legacy/freeform findings
 * text — `verdict: "changes-requested"`, the whole string as `summary`,
 * no anchored findings. An agent that ignores the format must never
 * silently read as a clean review: a parse failure defaults to the verdict
 * that keeps a human in the loop, not the one that lets the task glide
 * through.
 */
export function parseReviewFindings(raw: string): ParsedReviewFindings {
  const trimmed = raw.trim();
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (
      obj !== null &&
      typeof obj === "object" &&
      ((obj as Record<string, unknown>).verdict === "clean" ||
        (obj as Record<string, unknown>).verdict === "changes-requested") &&
      typeof (obj as Record<string, unknown>).summary === "string"
    ) {
      const rec = obj as Record<string, unknown>;
      const rawFindings = rec.findings;
      const findings: ReviewFinding[] = Array.isArray(rawFindings)
        ? rawFindings.map(normalizeReviewFinding).filter((f): f is ReviewFinding => f !== null)
        : [];
      return {
        verdict: rec.verdict as ReviewVerdict,
        summary: rec.summary as string,
        findings,
        verified: normalizeStringArray(rec.verified),
        notes: normalizeStringArray(rec.notes),
        looksGood: normalizeStringArray(rec.looksGood),
        structured: true,
      };
    }
  } catch {
    // Falls through to the freeform-text branch below — malformed JSON is
    // just another shape of "the agent didn't follow the contract".
  }
  return {
    verdict: "changes-requested",
    summary: trimmed,
    findings: [],
    verified: [],
    notes: [],
    looksGood: [],
    structured: false,
  };
}

/** `"[severity] "`, or `""` when the reviewer gave none — the one piece of
 * finding-rendering shared between this file's own bullet form and
 * `task-github-sync.ts`'s inline-anchor comment body, so the two don't
 * silently drift into different styling for the same field (Hermes review,
 * PR #736). */
export function severityPrefix(severity: ReviewFinding["severity"]): string {
  return severity ? `[${severity}] ` : "";
}

/** Which rendered-markdown section a finding's severity belongs under —
 * mapped mechanically, never left to the LLM to decide. `null` (a reviewer
 * that gave no severity at all) goes to Warnings, not Suggestions: a
 * severity-less finding from a reviewer that asked for changes isn't
 * necessarily a nit. */
function findingSection(
  severity: ReviewFinding["severity"],
): "critical" | "warnings" | "suggestions" {
  if (severity === "blocker" || severity === "major") return "critical";
  if (severity === "nit") return "suggestions";
  return "warnings";
}

/** `mode` controls how findings render within a section:
 * - `"bullets"` — today's `- [sev] **path:line** — body` form.
 * - `"count"` — a single `- N finding(s) anchored inline below` line, for
 *   the PR review body where the findings themselves are posted as
 *   GitHub's own anchored inline comments (`task-github-sync.ts`) and must
 *   not ALSO appear as prose in the summary — `autonomous-pr-review` §5. */
function renderFindingsSection(
  heading: string,
  items: ReviewFinding[],
  mode: "bullets" | "count",
): string[] {
  if (items.length === 0) return [`### ${heading}`, "- None", ""];
  const lines =
    mode === "count"
      ? [`- ${items.length} finding(s) anchored inline below`]
      : items.map((f) => `- ${severityPrefix(f.severity)}**${f.path}:${f.line}** — ${f.body}`);
  return [`### ${heading}`, ...lines, ""];
}

function renderTextSection(heading: string, items: string[], omitIfEmpty: boolean): string[] {
  if (items.length === 0) return omitIfEmpty ? [] : [`### ${heading}`, "- None", ""];
  return [`### ${heading}`, ...items.map((s) => `- ${s}`), ""];
}

/** Every real one-sentence `summary` in this file's own test fixtures is
 * under 100 characters; this leaves generous headroom above that before
 * treating a `summary` as the old contract's whole-paragraph shape instead
 * — see `renderReviewFindingsMarkdown`'s own doc comment (Hermes review,
 * PR #992). */
const MAX_STRUCTURED_SUMMARY_LENGTH = 300;

/**
 * Renders a parsed verdict into the markdown body its four consumers post
 * or feed a worker: the PR-review body/comment body (`task-reconciler.ts`),
 * the 422/issue-comment fallback (`task-github-sync.ts`), the persisted
 * `tasks.reviewFindings` column, and the review-feedback re-seed prompt
 * (`buildReviewFeedbackPrompt`). One renderer, three `mode`s, so the four
 * call sites can never drift into different section styling for the same
 * fields (the same reasoning `severityPrefix`'s own doc comment gives for
 * why THAT one piece of styling is centralized).
 *
 * `mode`:
 * - `"comment"` (default) — issue comment, no-anchor PR body, the 422
 *   fallback, and `tasks.reviewFindings`. Findings render as bullets.
 * - `"review-body"` — the PR review body only. Each section with findings
 *   gets its own "N finding(s) anchored inline below" line instead of
 *   `path:line` bullets, since `task-github-sync.ts` posts the findings
 *   themselves as GitHub's own anchored inline comments alongside this body.
 * - `"worker-prompt"` — the review-feedback auto-return re-seed. Only
 *   findings + notes render — no "Looks Good", no "Verified", no `- None`
 *   filler. That prompt's only job is telling the worker what to fix;
 *   praise and empty headings compete with the instruction, not support it.
 *
 * `parsed.structured === false` means the reviewer never wrote the JSON
 * contract `buildReviewPrompt` asks for, so `summary` holds the ENTIRE raw
 * file content, not one verdict sentence (see `parseReviewFindings`'s own
 * doc comment). Wrapping that in a "**Verdict:**" line and section headings
 * would render a multi-kilobyte bold line above four empty sections —
 * instead, return it verbatim in every mode, exactly as before this change.
 * The same escape hatch also fires for a STRUCTURED review whose `summary`
 * is suspiciously long (see `MAX_STRUCTURED_SUMMARY_LENGTH` below): valid
 * JSON in the old contract shape (the whole review dumped into `summary`)
 * still parses as `structured: true`, so length is the only signal left to
 * catch it.
 */
export function renderReviewFindingsMarkdown(
  parsed: ParsedReviewFindings,
  mode: "comment" | "review-body" | "worker-prompt" = "comment",
): string {
  if (!parsed.structured) return parsed.summary;

  const critical = parsed.findings.filter((f) => findingSection(f.severity) === "critical");
  const warnings = parsed.findings.filter((f) => findingSection(f.severity) === "warnings");
  const suggestions = parsed.findings.filter((f) => findingSection(f.severity) === "suggestions");

  if (mode === "worker-prompt") {
    const lines: string[] = [parsed.summary, ""];
    for (const f of parsed.findings) {
      lines.push(`- ${severityPrefix(f.severity)}**${f.path}:${f.line}** — ${f.body}`);
    }
    for (const n of parsed.notes) lines.push(`- ${n}`);
    return lines.join("\n").trimEnd();
  }

  // Hermes review, PR #992 — `structured` only means `raw` parsed as the
  // JSON shape; it says nothing about whether the reviewer actually kept
  // `summary` to the one-sentence verdict `buildReviewPrompt` now asks for
  // (the OLD contract asked for the whole review in this one field, and
  // that shape still parses cleanly). Past this length, `summary` no longer
  // looks like "one sentence" — render it verbatim rather than wrap a
  // paragraph in "**Verdict:**" above four empty "- None" sections.
  if (parsed.summary.length > MAX_STRUCTURED_SUMMARY_LENGTH) return parsed.summary;

  const findingsMode = mode === "review-body" ? "count" : "bullets";
  // A `changes-requested` verdict whose findings are ALL nits/warnings (no
  // blocker/major) would otherwise post a REQUEST_CHANGES review above an
  // empty "### Critical\n- None" — `autonomous-pr-review` §5 calls exactly
  // this state ("a REQUEST_CHANGES next to an empty Critical section")
  // a sign one of the two is wrong. It isn't wrong here — `wantsAutoReturn`
  // (task-reconciler.ts) still correctly spends the task's one auto-return
  // round on it — so the fix is saying so in the verdict line, not
  // suppressing the section.
  const nonBlockingNote =
    parsed.verdict === "changes-requested" && critical.length === 0
      ? " (non-blocking findings only)"
      : "";
  const verdictLabel = parsed.verdict === "clean" ? "clean" : "changes requested";
  // Hermes review, PR #992 — an empty `summary` (the reviewer left it
  // blank) must not leave a dangling " — " with nothing after it.
  const summarySuffix = parsed.summary ? ` — ${parsed.summary}` : "";

  const lines: string[] = [`**Verdict:** ${verdictLabel}${nonBlockingNote}${summarySuffix}`, ""];
  lines.push(...renderFindingsSection("Critical", critical, findingsMode));
  lines.push(...renderFindingsSection("Warnings", warnings, findingsMode));
  lines.push(...renderFindingsSection("Suggestions", suggestions, findingsMode));
  lines.push(...renderTextSection("Verified", parsed.verified, /* omitIfEmpty */ true));
  lines.push(...renderTextSection("Notes", parsed.notes, /* omitIfEmpty */ true));
  lines.push(...renderTextSection("Looks Good", parsed.looksGood, /* omitIfEmpty */ false));
  return lines.join("\n").trimEnd();
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
 * CI signal for the PR head commit the reviewer is about to look at —
 * `task-reconciler.ts`'s `processPendingReviewSpawns` resolves this (via
 * `github.ts`'s `fetchRunsForHead`/`computeCiStatus`) before spawning, so
 * the reviewer sees real pass/fail results instead of running before CI even
 * starts (the gap a live Task Master run against branchdam #213782 exposed:
 * the reviewer posted "no findings" 26s before a real golangci-lint failure
 * landed). `note` carries why a non-terminal signal was accepted anyway — a
 * wait-deadline timeout or a lookup failure — so the reviewer knows to trust
 * its own read of the diff over an absent or stale check.
 */
export interface ReviewCiInfo {
  headSha: string;
  status: "success" | "failure" | "in_progress" | null;
  runs: { name: string; conclusion: string | null; htmlUrl: string }[];
  note?: string;
}

/** Renders `ReviewCiInfo` into the paragraph `buildReviewPrompt` hands the
 * reviewer. Deliberately terse for `success`/`null` (nothing to act on);
 * `failure` gets an explicit instruction, since that's the one status this
 * whole mechanism exists to surface as a finding. */
export function renderCiSummary(ci: ReviewCiInfo): string {
  const shortSha = ci.headSha.slice(0, 7);
  const suffix = ci.note ? ` (${ci.note})` : "";

  if (ci.status === null) {
    return (
      `CI status on this PR's head commit ${shortSha} could not be determined${suffix || " (no runs, or the lookup failed)"} — ` +
      "review the diff without it."
    );
  }

  const lines = [`CI on this PR's head commit ${shortSha} is ${ci.status.toUpperCase()}${suffix}:`];
  for (const run of ci.runs) {
    lines.push(`  - ${run.name} — ${run.conclusion ?? "pending"} — ${run.htmlUrl}`);
  }
  if (ci.status === "failure") {
    lines.push(
      "",
      "A failing check is a finding. Read its log before concluding it is unrelated to",
      "this diff, and write it up with the file and line the failure names.",
    );
  }
  return lines.join("\n");
}

/**
 * The review agent's prompt (`task-reconciler.ts`).
 *
 * Keeps the original first sentence verbatim — the review agent is not
 * expected to make changes, and that framing is load-bearing (agy's own
 * global `agentMode: "plan"`, for instance, makes it incapable of changes
 * regardless). It is no longer purely advisory, though: a "changes-requested"
 * verdict can now drive one bounded `reviewing -> in_progress` round back to
 * the worker (see task-reconciler.ts's review-feedback loop) before a human
 * reviews again — see docs/tasks.md's Task → PR promotion section. Keeps
 * the one hazard the original prompt already warned about: the reviewer
 * runs in the WORKER's own worktree, not a copy, so anything it writes
 * there (other than the findings file below, which lives outside it)
 * dirties the tree and blocks the human's approve via `task-promote.ts`'s
 * `dirty-tree` refusal.
 *
 * The reviewer is told to ALWAYS write the findings file, as JSON with an
 * explicit `verdict` — see `parseReviewFindings`'s own doc comment for why
 * "the agent wrote nothing" can no longer mean "clean": a missing file
 * (crash, killed session, an agent that ignored this instruction entirely)
 * used to ingest as a confident "no findings" with no way to tell it apart
 * from a genuine clean review. `task-reconciler.ts` now treats a missing
 * file as inconclusive instead, and this contract is what makes a real
 * "clean" verdict distinguishable from that.
 */
export function buildReviewPrompt(opts: {
  task: TaskPromptTask;
  worktreePath: string;
  findingsPath: string;
  /** Omitted for an issue-only task (no PR to check CI on) or when the
   * reconciler couldn't resolve one before its wait deadline — see
   * `ReviewCiInfo`'s own doc comment. */
  ci?: ReviewCiInfo;
}): string {
  const preamble = [
    "Review this task's diff. You are not expected to make changes.",
    "",
    `You are running inside the worker's own git worktree at ${opts.worktreePath} —`,
    "not a copy. Do not create or modify any file here: an untracked or modified",
    "file blocks the human's approval of this task.",
    "",
    ...(opts.ci ? [renderCiSummary(opts.ci), ""] : []),
    `Always write your findings to ${opts.findingsPath} — that path is outside`,
    "the worktree, so writing it does not block approval. Write it ATOMICALLY:",
    `write the JSON to ${opts.findingsPath}.tmp first, then move/rename that to`,
    `${opts.findingsPath} as your LAST step — never write the final path`,
    "directly. Mullion may read this file mid-write otherwise, and a",
    "half-written JSON body is worse than a missing file: it can be misread",
    "as a real, if malformed, verdict. Shape:",
    "",
    "{",
    '  "verdict": "clean" | "changes-requested",',
    '  "summary": "one sentence: your overall verdict, nothing more",',
    '  "findings": [',
    '    { "path": "relative/file/path", "line": 42, "side": "RIGHT",',
    '      "severity": "blocker" | "major" | "minor" | "nit",',
    '      "body": "the defect and the concrete fix" }',
    "  ],",
    '  "verified": ["what you actually ran/checked, e.g. the exact commands"],',
    '  "notes": ["cross-cutting observations that do not anchor to one line"],',
    '  "looksGood": ["what is solid about this change"]',
    "}",
    "",
    "`verified`/`notes`/`looksGood` are all optional arrays of strings — omit",
    "any that don't apply, but keep `summary` to one sentence: the detail",
    "belongs in `verified`, not folded into `summary`.",
    "",
    'Write "clean" only when you found nothing at all. A missing or unparseable',
    'file is treated as an inconclusive review, never as "clean" — writing the',
    "file is what lets a genuinely clean review be told apart from one that",
    "crashed or was killed before reporting anything.",
    "",
    'Every entry in "findings" must be a real file:line in this diff: a finding',
    'is an inline anchored comment, never prose citing "file:42" inside the',
    '"summary" or "notes" fields.',
    "",
    "Write findings as clear, actionable instructions, not just observations: a",
    '"changes-requested" verdict may be sent back to the worker automatically,',
    "once, to act on before a human reviews again.",
    "",
    "Report your findings in this session too, in plain language — the JSON file",
    "is what Mullion reads; this is for a human reading your transcript.",
    "",
    "End your turn and stay running once you are done. Ending your turn is what",
    "signals your review is complete; do NOT run `exit` or `/quit` — a review",
    "session that exits on its own is treated the same as one that crashed.",
  ].join("\n");
  return `${preamble}${SECTION_BREAK}Task: ${taskSpec(opts.task)}`;
}

/**
 * The red-CI auto-return's prompt (`task-reconciler.ts`'s `attemptAutoApprove`,
 * #755) — sent when a REQUIRED check fails on a task's PR after it reached
 * "reviewing". Reuses `renderCiSummary` (the same rendering the review
 * agent's own prompt gets) rather than fetching and summarizing Actions
 * logs itself: the worker has a shell and the actual worktree, and can run
 * `gh run view --log-failed` far more precisely than Mullion could
 * pre-digest for it. Always carries the task spec, same reasoning as
 * `buildRejectPrompt`/`buildReviewFeedbackPrompt`: this only runs once
 * `reseedTaskIfSessionExited` decides the previous session is gone, so it
 * may be a completely fresh one with no memory of the task.
 */
export function buildCiFailurePrompt(opts: WorkerPreambleOptions & { ci: ReviewCiInfo }): string {
  const preamble = buildTaskMasterPreamble(opts);
  const failure =
    `A required CI check failed on this task's PR after it reached review.\n\n${renderCiSummary(opts.ci)}\n\n` +
    "Pull the latest changes, read the failing check's log, and fix it — then push and finish again.";
  return `${preamble}${SECTION_BREAK}${failure}${SECTION_BREAK}${taskSpec(opts.task)}`;
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

/**
 * The auto-rebase worker's prompt (`task-reconciler.ts`'s `attemptAutoRebase`,
 * #758) — sent when a `done` task's PR has a real conflict with its base
 * branch. Unlike every other prompt this module builds, this one must
 * countermand THREE lines of `buildTaskMasterPreamble` explicitly rather
 * than just add to it:
 *
 * - "Do not switch, rebase onto, or create another branch" is about branch
 *   IDENTITY (so Mullion can find `branchName` to push it) — replaying
 *   `branchName`'s own commits onto a newer base via `git rebase` keeps the
 *   worker on the same branch the whole time, so it doesn't actually violate
 *   that rule, but it reads like it might, so this spells out why it doesn't.
 * - "Mullion pushes the branch... do not push it yourself" does NOT hold
 *   here: Mullion's only push happens once, at the "-> reviewing" transition
 *   (`task-promote.ts`), and a `done` task never revisits that transition
 *   (`done` has no outgoing edges — see `task-state.ts`). The merge sweep
 *   only re-reads GitHub's own `mergeableState` on its next tick; a resolved
 *   conflict that stays unpushed is invisible to it forever.
 * - "Ending your turn... moves this task to review" is simply false here —
 *   this task already left "reviewing" once, back when it was first
 *   approved. Ending the turn only signals THIS rebase attempt is over, not
 *   a lifecycle transition.
 */
export function buildRebasePrompt(opts: WorkerPreambleOptions & { baseRef: string }): string {
  const preamble = buildTaskMasterPreamble(opts);
  const instructions =
    `Your pull request for ${opts.branchName} has a merge conflict with ${opts.baseRef} that is ` +
    "blocking it from being merged.\n\n" +
    `Rebase onto the latest ${opts.baseRef}, resolve every conflict, then re-run the repo's own ` +
    "verification gate (the same one the instructions above point at) — a conflict resolution " +
    "that isn't re-verified can silently break something the original change got right.\n\n" +
    `You are staying ON ${opts.branchName} the whole time — a rebase replays this branch's own ` +
    "commits onto a newer base, it does not switch to or create another branch, so this does not " +
    'conflict with the "do not switch, rebase onto, or create another branch" rule above (that ' +
    "rule is about branch identity, not this operation).\n\n" +
    'This turn is the one exception to "do not push it yourself": once the rebase is clean and ' +
    "the gate passes, push with `git push --force-with-lease origin " +
    `${opts.branchName}\` (not a plain push — ${opts.branchName} already has commits on the ` +
    "remote). Mullion picks up the result automatically on its next check; do not open or " +
    "comment on any pull request yourself.\n\n" +
    "One more correction to the instructions above: ending your turn here does NOT move this " +
    "task to review — that already happened earlier in its lifecycle. It only signals that this " +
    "rebase attempt is finished; Mullion notices the push (or the lack of one) on its own.";
  return `${preamble}${SECTION_BREAK}${instructions}${SECTION_BREAK}${taskSpec(opts.task)}`;
}

/** The subset of `PrReviewThreadComment` (github-write.ts) this prompt
 * needs to render — a local shape rather than importing that module's own
 * type, matching this module's own "plain string builder, no dependency on
 * what fetched the data" convention (see `ReviewCiInfo` above for the same
 * pattern). */
export interface PrReviewCommentInfo {
  author: string | null;
  path: string | null;
  line: number | null;
  body: string;
}

function renderPrReviewComments(comments: PrReviewCommentInfo[]): string {
  return comments
    .map((c) => {
      const location = c.path
        ? `${c.path}${c.line !== null ? `:${c.line}` : ""}`
        : "general comment";
      const who = c.author ? `@${c.author}` : "someone";
      return `- **${location}** (${who}): ${c.body}`;
    })
    .join("\n");
}

/**
 * The PR-review-comment auto-return's prompt (`task-reconciler.ts`, #757) —
 * new GitHub review comments on unresolved threads, delivered the same way
 * a human's reject feedback or Mullion's own review-agent findings are
 * (`buildRejectPrompt`/`buildReviewFeedbackPrompt`). Unlike `buildRebasePrompt`,
 * this needs no countermand of the standard preamble: this trigger goes
 * through the exact same "reviewing -> in_progress" lifecycle as every other
 * auto-return (`autoReturnTask`), so Mullion still does the push once the
 * worker ends its turn — the worker just needs to know what to fix.
 */
export function buildPrReviewCommentsPrompt(
  opts: WorkerPreambleOptions & { comments: PrReviewCommentInfo[] },
): string {
  const preamble = buildTaskMasterPreamble(opts);
  const feedback =
    "New review comments came in on this task's pull request, on threads GitHub still shows as " +
    `unresolved:\n\n${renderPrReviewComments(opts.comments)}\n\n` +
    "Address each one, then finish your turn as usual. You don't need to reply on GitHub or " +
    "resolve the thread yourself — Mullion picks up your commits and re-checks automatically.";
  return `${preamble}${SECTION_BREAK}${feedback}${SECTION_BREAK}${taskSpec(opts.task)}`;
}
