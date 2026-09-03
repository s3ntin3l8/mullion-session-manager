# Descriptive branch names for Task Master tasks

## Problem

Mullion's Task Master stamps every claimed task with a branch named
`mullion/task-<id>` and a worktree directory `mullion-task-<id>` (where
`<id>` is the row id in the local `tasks` table). The branch name is
unique and stable, but it carries no information about the task's
content — `git branch --list 'mullion/*'`, a GitHub PR header, or a
reviewer's first look at `https://github.com/.../pull/123` reveals
nothing about what's in the PR until the PR title is opened.

The current `src/services/git-worktree.ts:541` comment makes the
constraint explicit: derived from `task.id`, not `task.issueNumber`,
because `issueNumber` is nullable (every local-only task shares
`NULL`) and branching on it would collide every local task onto
`mullion/task-null`. The same constraint rules out title-only names
(collision between two tasks titled the same thing) but does not
rule out **id + slug**: the id keeps uniqueness, the slug adds
readability.

## Goal

Stamp every newly-claimed Task Master task with a branch name of the
form `mullion/task-<id>-<slug>` where `<slug>` is the task's title,
run through the existing `sanitizeRefComponent` function. Stamp it
once at claim time and never recompute — title edits after claim do
not rename the branch. The branch name stays in the same closed,
code-controlled namespace as today (always `mullion/task-...`, never
user-chosen), so every existing safety check that pattern-matches on
that namespace continues to work, with one regex relaxed to accept
the new shape.

## Non-goals

- Renaming branches for in-flight tasks from a prior deploy. Existing
  rows keep their old `mullion/task-<id>` branch name; only
  newly-claimed tasks get the new shape. The retry path is already
  gated on `task.branchName` being non-null (`src/services/task-claim.ts:559`),
  so the DB value always wins over the helper for an in-flight retry
  — no race.
- Re-deriving the slug on title edit. Frozen at claim, same as today.
- Changing `prTitle` (already its own user-tunable field, used at
  PR-open time, unrelated to branch naming).
- Changing the worktree directory prefix
  `TASK_WORKTREE_PREFIX = "mullion-task-"`. The new directory
  `mullion-task-<id>-<slug>` still starts with that prefix; the
  existing `listTaskWorktreeDirs` filter continues to match.
- Disambiguating without the id. Two tasks titled "Fix NPE" still
  disambiguate via the id, so dropping the id was considered and
  rejected (it's doing real work, and a slug-only name is harder to
  scan in `git branch` listings).

## Design

### 4.1 New helper

In `src/services/git-worktree.ts`, next to `TASK_BRANCH_NAME_RE`
(line 541) and `TASK_WORKTREE_PREFIX` (line 535) so all three pieces
of the namespace live together:

```ts
export function deriveTaskBranchName(task: { id: number; title: string }): string {
  const slug = sanitizeRefComponent(task.title);
  return `mullion/task-${task.id}-${slug.length > 0 ? slug : "untitled"}`;
}
```

Signature takes only the fields it needs (not the full `tasks` row)
so the helper is decoupled from Drizzle and trivially testable. The
empty-after-sanitize fallback is `"untitled"`, not the existing
`"session"` fallback inside `sanitizeRefComponent` — that fallback
was written for session branch names and reads weird for a task
branch. The function is pure, synchronous, never throws.

`sanitizeRefComponent` already truncates to 200 chars, replaces
anything outside `[A-Za-z0-9_.-]` with `-`, collapses runs of `-`,
and strips leading/trailing `-`/`.`. A 200-char title → up to a
200-char slug, combined with `mullion/task-<id>-` prefix → worst
case ~230 chars, well under git's 4 KiB ref limit.

### 4.2 Relaxed namespace regex

`src/services/git-worktree.ts:541`:

- From: `const TASK_BRANCH_NAME_RE = /^mullion\/task-\d+$/;`
- To: `const TASK_BRANCH_NAME_RE = /^mullion\/task-\d+-.+$/;`

Affects `clearOrphanedTaskWorktree` (line 885-892, the
CodeQL-reviewed defense-in-depth gate that prevents this function
from ever deleting a branch outside the task namespace) and
`resumeTaskWorktree` (line 951, the retry path's check that the
branch being checked out is a task branch and not a user-chosen
ref). Both want the same shape: task-only, no user-chosen branches,
no leading `-` (the existing `branchName.startsWith("-")` check at
line 888 already covers the leading-dash case independently; the
new regex just requires `\d+-` after the `task-` so a literal
`mullion/task-foo` can't slip through).

The corresponding comment at line 537-540 (which today names the
literal `mullion/task-${task.id}`) gets updated to name the helper
and describe the new shape.

### 4.3 Call-site consolidation

Two call sites in `src/services/task-claim.ts`:

- Line 126 (`enqueueTask`): the literal `` `mullion/task-${task.id}` ``
  becomes `deriveTaskBranchName(task)`.
- Line 232 (`dispatchClaimedTask`): the literal
  `` task.branchName ?? `mullion/task-${task.id}` `` becomes
  `task.branchName ?? deriveTaskBranchName(task)`.

The fallback on line 232 is defensive — it only runs for a
freshly-dispatched task whose row had `branchName === null` at
read time, which doesn't happen in normal flow (the `enqueueTask`
reservation at line 134-138 already stamps it). Resolving through
the helper keeps the shape consistent if a future flow ever does
start here.

The comment at line 123-125 (`Derived from task.id, not
task.issueNumber`) is updated to explain the new shape: id for
uniqueness (same reason), title-slug for readability, slug frozen
at claim.

### 4.4 Worktree dir uniqueness — already free

Two tasks titled "Add dark mode" under one project get different
worktree dirs because their ids differ:
`mullion-task-7-add-dark-mode` vs `mullion-task-8-add-dark-mode`.

`sanitizeRefComponent("mullion/task-42-add-dark-mode")` returns
`"mullion-task-42-add-dark-mode"`, which
`startsWith(TASK_WORKTREE_PREFIX)` — so the `listTaskWorktreeDirs`
filter at line 995 still works.

`deriveWorktreePath` (line 288) takes the full branch string as
`seed` and joins it through `sanitizeRefComponent`, so the directory
is automatically derived from the branch name. No additional
uniqueness handling required.

### 4.5 Test updates

New `describe("deriveTaskBranchName", ...)` block in
`test/services/git-worktree.test.ts` with parametrized cases for
representative inputs: clean title, oversize title, all-emoji
title, non-ASCII title, leading/trailing punctuation, title
containing `mullion/task-N` itself. Each asserts the exact branch
string and that `deriveWorktreePath(cwd, branchName)` returns the
matching directory.

Existing assertion cases that hard-code `mullion/task-N` (no slug)
get updated to cover the new shape, and the literal-`mullion/task-1`
"refuses outside" cases at `test/services/git-worktree.test.ts:1559,1649`
reword to "refuses outside `mullion/task-<digits>-...`".

Call-site fixtures at `test/services/task-claim.test.ts:267,588,612`
and `test/routes/tasks.test.ts:419` currently hard-code
`branchName: \`mullion/task-${task.id}\``. Update each so the row
has a real `title` and the branch is computed from the helper at
assertion time, rather than re-asserting the literal by hand. This
keeps fixtures honest and exercises the helper.

The remote-host proxy test at
`test/services/remote-host-client.test.ts:455-470` posts
`{cwd, branchName: "mullion/task-1"}` and asserts the same comes
back. Update to the helper-derived shape. No protocol change — the
proxy just passes strings through.

### 4.6 Documentation

Prose-only updates, no behavior change:

- `docs/tasks.md:1681-1682` (worktree-lifecycle example): show the
  new shape with a representative slug and explain "slug is
  sanitized and frozen at claim".
- `docs/tasks.md:175,307,1368,1746` and any other literal
  `mullion/task-<id>` mentions: update prose where the literal is
  shown; generalize to "task branch" where it isn't load-bearing.
  Same for `mullion-task-<id>` directory examples.
- `CLAUDE.md:190` (the `mullion-task-<id>` worktree mention): update
  to the slugged form.
- `.claude/skills/mullion-review-invariants/SKILL.md:68,77` (the
  namespace-prefix rules a reviewer enforces): update the regex
  examples.
- `docs/git-panel.md:80,86`: update the namespace examples.
- `src/db/schema.ts:592-597` (the `branchName` column comment, the
  one place a future contributor would copy from): rewrite the
  comment to name the helper and describe the new shape with the
  "not derived from issueNumber" rationale preserved.

## Risks

- **Regex relaxation scope.** `TASK_BRANCH_NAME_RE` is the only
  regex enforcing "task branch, not user-chosen." A bug in the new
  shape would still hit the leading-dash check (line 888) and the
  non-empty check (line 887) but is the most security-relevant
  change. Mitigation: the new test block covers adversarial inputs
  (literal `mullion/task-N` strings, non-ASCII, leading-dash
  titles).
- **Test fixture churn.** Every place that hard-codes the literal
  branch name needs to know about this. Mitigated by the helper
  - `deriveTaskBranchName` test block as a single source of truth.
- **Rollout model.** Existing in-flight tasks keep their old branch
  name. A user with `mullion/task-7` open in their workspace
  doesn't see the name change retroactively — they only see the
  new shape on the next claim. Documented in the user-facing
  `docs/tasks.md` worktree section.
- **Long directory names.** A 200-char title produces a ~225-char
  directory name (`mullion-task-<id>-<200 char slug>`). Linux
  filesystem path limit is 4096 chars, so no realistic issue.
  macOS HFS+ is 255 UTF-16 chars but Mullion's primary deployment
  is Linux (per `docs/` tone), and the existing 200-char
  `sanitizeRefComponent` cap is already used for session branch
  names that go through the same path. No change.

## Out-of-scope followups

- A future "rename branch" affordance for in-flight tasks once the
  helper exists — gated on the new shape. Not in this spec.
