import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clampToBytes } from "./marked-region.js";

// Issue #937 — a small, finite set of well-known "how we work" policy
// choices (branch-vs-direct-commit, merge strategy, review process, ...),
// deterministically assembled into prose by buildWorkflowConventionsText
// below. Same "pure function assembling structural output" posture as
// mullion-scaffold.ts's computeScaffold — no agent, no network, fully
// unit-testable — but this is a STARTER, not an ongoing mode: running it
// fills settings.sessions.workflowConventionsText (settings.ts) with the
// generated prose, which is then a normal, freely-editable textarea with no
// distinction between wizard-written and hand-edited parts, and no answer
// state kept around to reconcile against later edits. See routes/
// workflow-conventions.ts for the two read-only endpoints (GET the question
// set, POST answers -> text) the frontend's wizard drives.
//
// This is the issue's own explicit v1 question list — extend over time as
// gaps are found, per the issue's own "not exhaustive" framing, but don't
// silently narrow it: each axis below is named directly in issue #937's
// "Starting question set."
export interface WorkflowConventionOption {
  id: string;
  label: string;
  /** The prose sentence(s) this option contributes when selected — joined
   * with every other selected fragment, in question order, by
   * buildWorkflowConventionsText below. Deliberately plain sentences, not a
   * markdown list item each: the assembled result reads as ordinary prose a
   * human would keep hand-editing afterward, not as a form dump. */
  fragment: string;
}

export interface WorkflowConventionQuestion {
  id: string;
  question: string;
  options: WorkflowConventionOption[];
}

export const WORKFLOW_CONVENTION_QUESTIONS: readonly WorkflowConventionQuestion[] = [
  {
    id: "branching",
    question: "Direct commits to the default branch, or always branch + PR?",
    options: [
      {
        id: "branch-pr",
        label: "Always branch + PR (recommended)",
        fragment: "Never commit directly to the default branch. Always branch and open a PR.",
      },
      {
        id: "direct-commit",
        label: "Direct commits to the default branch are fine",
        fragment: "Direct commits to the default branch are fine; branching is optional.",
      },
    ],
  },
  {
    id: "branchBase",
    question:
      "When branching, base off the local default branch, or the latest remote default branch (`git fetch` first)?",
    options: [
      {
        id: "remote",
        label: "Latest remote default branch (recommended)",
        fragment:
          'Branch off the latest remote default branch, never off your local one: `git fetch origin && git checkout -b <branch> origin/<default>`. A local default branch is routinely stale, which is what makes a PR show up as "out-of-date with the base branch" the moment it\'s opened.',
      },
      {
        id: "local",
        label: "Local default branch",
        fragment: "Branch off your local default branch.",
      },
    ],
  },
  {
    id: "titleConvention",
    question:
      "Commit/PR title convention: freeform, or Conventional Commits prefix required (`feat:`, `fix:`, `chore:`, ...)?",
    options: [
      {
        id: "conventional-commits",
        label: "Conventional Commits prefix required",
        fragment:
          "Commit and PR titles need a Conventional Commits prefix (`feat:`, `fix:`, `chore:`, ...).",
      },
      {
        id: "freeform",
        label: "Freeform titles",
        fragment: "Commit and PR titles are freeform — no required prefix convention.",
      },
    ],
  },
  {
    id: "mergeStrategy",
    question:
      "Merge strategy: squash merge, merge commit (preserve individual commits), or rebase merge?",
    options: [
      {
        id: "squash",
        label: "Squash merge",
        fragment:
          "Squash-merge PRs — the PR title becomes the commit message on the default branch.",
      },
      {
        id: "merge-commit",
        label: "Merge commit (preserve individual commits)",
        fragment: "Merge with a merge commit, preserving each PR's individual commits.",
      },
      {
        id: "rebase",
        label: "Rebase merge",
        fragment: "Rebase-merge PRs onto the default branch.",
      },
    ],
  },
  {
    id: "preMergeRequirements",
    question:
      "Before merging, require: nothing special, green CI only, or green CI and at least one review approval?",
    options: [
      {
        id: "none",
        label: "Nothing special",
        fragment: "No specific requirement before merging.",
      },
      {
        id: "green-ci",
        label: "Green CI only",
        fragment: "Require green CI before merging.",
      },
      {
        id: "green-ci-and-review",
        label: "Green CI and at least one review approval",
        fragment: "Require green CI and at least one review approval before merging.",
      },
    ],
  },
  {
    id: "codeReview",
    question:
      "Code review process: none required, self-review your own diff before declaring done, request an automated/bot review, or both?",
    options: [
      {
        id: "none",
        label: "None required",
        fragment: "No code review process is required.",
      },
      {
        id: "self-review",
        label: "Self-review your own diff before declaring done",
        fragment: "Run a self-review pass on your own diff before declaring done.",
      },
      {
        id: "bot-review",
        label: "Request an automated/bot review",
        fragment: "Request an automated/bot review.",
      },
      {
        id: "both",
        label: "Both self-review and an automated/bot review",
        fragment:
          "Run a self-review pass on your own diff before declaring done, and also request an automated/bot review.",
      },
    ],
  },
  {
    id: "reviewFeedback",
    question:
      "Addressing review feedback: just fix the code, or fix the code and reply to each inline comment via the GitHub API and resolve the thread via the GraphQL `resolveReviewThread` mutation (not just pushing a silent fix)?",
    options: [
      {
        id: "fix-only",
        label: "Just fix the code",
        fragment: "Addressing review feedback just means fixing the code.",
      },
      {
        id: "reply-and-resolve",
        label: "Fix the code, then reply to and resolve each comment",
        fragment:
          "Fixing the code is not enough to address review feedback — reply to each inline comment via the GitHub API, then resolve the thread via the GraphQL `resolveReviewThread` mutation, rather than pushing a silent fix.",
      },
    ],
  },
  {
    id: "deferredWork",
    question:
      "Deferred/descoped work: note it in the PR description only, or file a tracked issue for every deferred/blocked/descoped item, linked from the PR?",
    options: [
      {
        id: "pr-note",
        label: "Note it in the PR description only",
        fragment: "Deferred or descoped work is noted in the PR description only.",
      },
      {
        id: "tracked-issue",
        label: "File a tracked issue for every deferred item, linked from the PR",
        fragment:
          "File a tracked issue for anything a plan defers, blocks, or descopes, and link it from the PR — a footnote in a plan doc is not a durable record.",
      },
    ],
  },
  {
    id: "postMergeCleanup",
    question:
      "Post-merge cleanup: leave branches as-is, or delete the local and remote branch (and remove any associated worktree)?",
    options: [
      {
        id: "leave",
        label: "Leave branches as-is",
        fragment: "No specific post-merge cleanup is required.",
      },
      {
        id: "delete",
        label: "Delete the local and remote branch (and any worktree)",
        fragment:
          "After a merge, delete the local and remote branch and remove any associated worktree.",
      },
    ],
  },
  {
    id: "prePushChecks",
    question:
      "Pre-push checks: none required, or run lint/typecheck/test/format before every push?",
    options: [
      {
        id: "none",
        label: "None required",
        fragment: "No specific pre-push checks are required.",
      },
      {
        id: "full-gate",
        label: "Run lint/typecheck/test/format before every push",
        fragment: "Before pushing, run the full lint/typecheck/test/format gate.",
      },
    ],
  },
];

/**
 * Deterministic, pure assembly of the selected options' fragments into
 * readable prose — no I/O, no agent, no network. `answers` maps a question
 * id to the id of the option selected for it; a question with no entry (or
 * an unrecognized option id) is silently skipped, not defaulted — an
 * incomplete wizard run still produces valid, if shorter, prose rather than
 * guessing at an unanswered axis. Questions are walked in
 * WORKFLOW_CONVENTION_QUESTIONS's own fixed order, so the output is stable
 * across calls with the same `answers` regardless of key insertion order in
 * the object. Empty `answers` (or answers matching nothing) returns "".
 */
export function buildWorkflowConventionsText(answers: Record<string, string>): string {
  const fragments: string[] = [];
  for (const question of WORKFLOW_CONVENTION_QUESTIONS) {
    const selectedOptionId = answers[question.id];
    if (selectedOptionId === undefined) continue;
    const option = question.options.find((o) => o.id === selectedOptionId);
    if (!option) continue;
    fragments.push(option.fragment);
  }
  return fragments.join("\n\n");
}

/** Cap on the injected text, mirroring project-briefing.ts's own
 * MAX_BRIEFING_BYTES posture (a defense-in-depth clamp on top of whatever
 * the Settings UI already lets an operator save) but sized for genuinely
 * longer, multi-paragraph policy prose rather than a short pinned note —
 * matches the "operator-authored config" bound project-tooling.ts's
 * skill/reviewerAgent columns already use (MAX_PROJECT_TOOLING_FIELD_BYTES,
 * project-tooling.ts). */
export const MAX_WORKFLOW_CONVENTIONS_BYTES = 8192;

/** Pure path builder (no I/O) for a session's own copy of the resolved
 * workflow-conventions text — mirrors sessionBriefingPath's role
 * (project-briefing.ts) so the `<id>.workflow-conventions.md` naming
 * convention lives in one place. hook-adapters/opencode.ts's prepareLaunch
 * does an existsSync check on this exact path. */
export function sessionWorkflowConventionsPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.workflow-conventions.md`);
}

/** Self-identifying header, mirroring buildSessionBriefingContent's role
 * for the pinned note (project-briefing.ts) — so a session reading this
 * file (or an opencode session that only sees it via `instructions`) knows
 * where the note came from and that it's an install-wide default, not a
 * per-project directive (a project's own AGENTS.md is what states THIS
 * project's conventions, and always wins on anything it says explicitly).
 * Exported for tests. */
export function buildSessionWorkflowConventionsContent(body: string): string {
  return `> This Mullion install's own workflow conventions, set in Settings -> Sessions. Applies across every project unless this one opted out. If this project's own AGENTS.md says something different, AGENTS.md wins — this is a default, not an override.\n\n${body}`;
}

/**
 * Writes a session's own copy of the resolved workflow-conventions text to
 * `sessionWorkflowConventionsPath(sessionsDir, sessionId)`, mode 0600.
 * Called from launch-plan.ts before applyHookAdapters, same ordering
 * requirement as writeSessionAgentGuide/writeSessionBriefing (the opencode
 * adapter's prepareLaunch does an existsSync check on this exact path).
 *
 * `text` is session-lifecycle.ts's createSessionRecord's already-fully-
 * resolved value: `undefined` when either this project opted out
 * (projects.injectWorkflowConventions === false) or the install has no
 * global text configured at all — see that function's own comment for the
 * exact resolution. `undefined` unlinks any stale per-session copy from a
 * previous spawn, the same "a note can be deleted/disabled between spawns
 * while a session id is reused across a dtach respawn" reasoning
 * writeSessionBriefing already documents.
 *
 * UNLIKE writeSessionBriefing, an empty string is treated exactly like
 * `undefined` here (no file written; a stale one is unlinked) rather than
 * as its own distinct, deliberately-injected state — Hermes review PR #893
 * made writeSessionBriefing's own empty-string case nullish-not-truthy
 * specifically because a project's pinned note has a real "select-all-
 * delete, then Save" UI action that must still push a body-less note. This
 * field has no equivalent action: "" is simply "no convention text
 * configured yet" (settings.ts's own DEFAULT_SETTINGS default), and the
 * issue's own gating rule is explicit — inject only when the global text is
 * non-empty AND the project hasn't opted out — so an empty resolved value
 * here always means "inject nothing," not "inject an empty note."
 *
 * Every failure logged-and-swallowed: this must never block a spawn.
 */
export function writeSessionWorkflowConventions(
  sessionsDir: string,
  sessionId: string,
  log: { error: (obj: unknown, msg: string) => void } = console,
  text?: string,
): void {
  const destPath = sessionWorkflowConventionsPath(sessionsDir, sessionId);
  if (text === undefined || text.length === 0) {
    try {
      unlinkSync(destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.error(
          { err, sessionId },
          "failed to remove stale per-session workflow-conventions copy",
        );
      }
    }
    return;
  }
  const clamped = clampToBytes(text, MAX_WORKFLOW_CONVENTIONS_BYTES, "Settings -> Sessions");
  const content = buildSessionWorkflowConventionsContent(clamped);
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(destPath, content, { mode: 0o600 });
  } catch (err) {
    log.error({ err, sessionId }, "failed to write per-session workflow-conventions copy");
  }
}

/** Cheap sync read of a session's own workflow-conventions copy, for
 * hooks.ts's SessionStart branch. `null` when absent or unreadable — both
 * are the ordinary "nothing to inject" outcome (opted out, or no global
 * text configured). */
export function readSessionWorkflowConventions(
  sessionsDir: string,
  sessionId: string,
): string | null {
  try {
    return readFileSync(sessionWorkflowConventionsPath(sessionsDir, sessionId), "utf8");
  } catch {
    return null;
  }
}
