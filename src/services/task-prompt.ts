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
 * The verification-gate bullet below doesn't break that rule even though it
 * points at CLAUDE.md/AGENTS.md/README: it names no commands, so it stays
 * correct across the arbitrary target repos Task Master runs against (a Go
 * repo's gate looks nothing like this one's `make lint`). It establishes an
 * obligation this repo's own docs can't — Mullion opens the pull request
 * only AFTER the worker's turn ends, so nothing already in a target repo's
 * docs tells the agent it will never see CI's result.
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
    // #782 — if the worker DOES rewrite this with a changed type on a later
    // round, that only reaches `tasks.prTitle`; nothing currently re-syncs
    // an already-open PR's title on GitHub, so a type change past the round
    // that first opened the PR has no visible effect until that's fixed.
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
      const rawFindings = (obj as Record<string, unknown>).findings;
      const findings: ReviewFinding[] = Array.isArray(rawFindings)
        ? rawFindings.map(normalizeReviewFinding).filter((f): f is ReviewFinding => f !== null)
        : [];
      return {
        verdict: (obj as Record<string, unknown>).verdict as ReviewVerdict,
        summary: (obj as Record<string, unknown>).summary as string,
        findings,
      };
    }
  } catch {
    // Falls through to the freeform-text branch below — malformed JSON is
    // just another shape of "the agent didn't follow the contract".
  }
  return { verdict: "changes-requested", summary: trimmed, findings: [] };
}

/** `"[severity] "`, or `""` when the reviewer gave none — the one piece of
 * finding-rendering shared between this file's own bullet form and
 * `task-github-sync.ts`'s inline-anchor comment body, so the two don't
 * silently drift into different styling for the same field (Hermes review,
 * PR #736). */
export function severityPrefix(severity: ReviewFinding["severity"]): string {
  return severity ? `[${severity}] ` : "";
}

/** Renders a parsed verdict back into the plain-text form the review
 * comment and the review-feedback re-seed prompt both already expect —
 * summary prose, then each anchored finding as a `path:line` bullet,
 * severity-prefixed when the reviewer gave one. `task-github-sync.ts`'s own
 * PR-review posting (structured, not this text) consumes
 * `ParsedReviewFindings.findings` directly instead. */
export function renderReviewFindingsMarkdown(parsed: ParsedReviewFindings): string {
  if (parsed.findings.length === 0) return parsed.summary;
  const bullets = parsed.findings.map(
    (f) => `- ${severityPrefix(f.severity)}**${f.path}:${f.line}** — ${f.body}`,
  );
  return [parsed.summary, "", ...bullets].join("\n");
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
    '  "summary": "what you reviewed, what you checked and how (the actual',
    '    commands you ran), and why it is clean or not",',
    '  "findings": [',
    '    { "path": "relative/file/path", "line": 42, "side": "RIGHT",',
    '      "severity": "blocker" | "major" | "minor" | "nit",',
    '      "body": "the defect and the concrete fix" }',
    "  ]",
    "}",
    "",
    'Write "clean" only when you found nothing at all. A missing or unparseable',
    'file is treated as an inconclusive review, never as "clean" — writing the',
    "file is what lets a genuinely clean review be told apart from one that",
    "crashed or was killed before reporting anything.",
    "",
    'Every entry in "findings" must be a real file:line in this diff — see this',
    "repo's own autonomous-pr-review skill for why: a finding is an inline",
    'anchored comment, never prose citing "file:42" inside the summary.',
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
