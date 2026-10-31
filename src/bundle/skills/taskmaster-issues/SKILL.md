---
name: taskmaster-issues
description: "Read this before filing ANY GitHub issue from a Mullion-hosted session — a deferred follow-up, a bug you found, a spike, or a Task Master task. Covers the Conventional Commits title and the repo's scope vocabulary, attaching the issue to an existing epic as a sub-issue, and sequencing with blocked_by; and, where Task Master is enabled, the mullion-task label, the eight body directives and their exact matching rules, what the worker agent actually receives, and how to size and spec a body a worker can finish in one worktree."
---

# Filing an issue from a Mullion session

Applies to every issue you file from a Mullion-hosted session, whether or not
it is meant for autonomous pickup: the title, epic and dependency sections
below. The label, directive and worker-spec sections only matter in a project
where Mullion's Task Master is enabled — if this repo doesn't have a
background task watcher polling its issues, skip those. See
[`docs/tasks.md`](https://github.com/s3ntin3l8/mullion-session-manager/blob/main/docs/tasks.md)
for the full system; this is just the "how do I write the issue" cheat
sheet.

## The title

If the repo uses Conventional Commits for commit and PR titles (its
`AGENTS.md` says so, or `git log --oneline` shows it), title the issue the
same way: `type(scope): summary`. The squash-merged PR usually reuses it.

- **Types are the Conventional Commits set only:** `feat`, `fix`, `docs`,
  `test`, `ci`, `chore`, `refactor`, `perf`, `build`, `style`, `revert`. A decision or design
  issue is `docs(scope): decide …`; an investigation into a bug is
  `fix(scope): investigate …`. Don't invent `design:`, `decide:`, `idea:` or
  `investigate:` as types.
- **Reuse the repo's existing scope.** Look for a documented scope list in
  `AGENTS.md` first. If there isn't one, take the most-used scope for that
  area from `git log --format=%s -300` and the open issue titles. Never coin a
  synonym — `task-master` when `tasks` exists, `session` when `sessions`
  exists. CI-only work is a bare `ci:` with no scope.
- Correct: `fix(sessions): wait_for_output matches the prompt's redrawn echo`.
  Incorrect: `investigate: wait_for_output echo` (invented type, no scope).

## Link it to an existing epic

Before filing, list the open epics so the new issue lands in the right group
instead of floating loose:

    gh issue list --label epic --state open

If the repo has no `epic` label, query for open issues whose
`subIssuesSummary.total` is above zero instead. Pick the one epic that clearly
fits, then attach the new issue to it as a sub-issue:

    gh api -X POST repos/{owner}/{repo}/issues/<epic>/sub_issues -F sub_issue_id=<id>

`<id>` is the issue's REST `id` — `gh api repos/{owner}/{repo}/issues/<n> --jq .id` —
not its issue number. An issue can have only one parent: a 422 "may only have
one parent" means it is already parented, so leave it as it is.

If no epic clearly fits, leave the issue unparented and say so in your reply
or PR. Don't create a new epic unprompted.

Linking is worth doing even where nothing is auto-claimed: when a sub-issue is
picked up, the parent's spec and comments plus the list of sibling sub-issues
are appended to the worker's prompt as context (see below). It is board
display only — it gates nothing.

## What the worker actually gets

Before anything else: your issue's **title and body are passed to the
worker verbatim** — title, a blank line, then the body, nothing stripped,
not even the directive lines below. There is no parsing, no summarization,
no expansion: whatever isn't in the text you write is invisible to the
agent that implements it.

- **The worker DOES get more than your raw title+body.** Comments already
  posted on the issue are always appended to the prompt. If this issue is a
  registered GitHub sub-issue, the parent tracking issue's own spec and
  comments, plus a list of sibling sub-issues Mullion already knows about,
  are appended too (`task-prompt.ts`'s `renderComments`/`renderParent`/
  `renderSiblings`) — each framed explicitly as context, not the worker's
  own task. What still doesn't resolve: a bare `#123` reference typed into
  your own prose is just four characters to the worker — it never expands
  to that issue's content, so paste the conclusion instead of pointing at
  it.
- **An issue that still has open sub-issues is treated as an epic and
  parked in `backlog`, not `ready`** — it won't auto-claim until every
  sub-issue closes (or you claim it by hand).
- **The same title+body is what the reviewer judges the diff against**,
  when a review agent is configured — spawned once your task moves from
  `in_progress` to `reviewing`, the same point its draft PR opens. Your
  body is the acceptance spec, not a hint.
- Mullion's own preamble already covers running the repo's verification
  gate, self-reviewing the diff before committing, and leaving the
  worktree clean. Don't repeat any of that in your Scope.

## The label

Task Master's watcher polls each connected project's repo for open issues
carrying a specific label — `mullion-task` by default. **No label, no
pickup** — an issue without it just sits there, however well-formatted the
body is. The label is a deploy-time setting, not something a project or an
issue can override; Settings → Task Master shows the configured label
read-only. If you're not sure of it, ask a human or check there.

**The issue's author also has to be trusted.** Task Master ignores a labeled
issue unless its author is a repo owner, member or collaborator (or is on the
Trusted GitHub logins list in Settings → Task Master — e.g. a bot account you
file from). Comments from anyone else are left out of the worker's prompt. If a
correctly labeled issue never appears, check who opened it.

## Writing a body a worker can implement

This is the part that decides whether autonomous pickup produces a usable
PR or a wasted round trip.

**Right-size it to one worktree, one PR, one worker turn.** If it touches
two unrelated subsystems, or needs a decision made partway through, that's
two issues, not one with two phases. The worker has a wall-clock budget
and a small, non-renewing number of automatic fix-up rounds with its
reviewer — an oversized issue burns both fastest.

When splitting work into an ordered roadmap, sequence it with GitHub's own
**`blocked_by` dependency** — that's what actually gates auto-claim (a
dependent issue stays `ready` but isn't claimed until its blocker closes).
Parent/sub-issue nesting does **not** gate anything; it's board display
only. One caveat: a **human clicking Claim bypasses the dependency gate
entirely**, so `blocked_by` protects automation, not a person who ignores
it on purpose.

Set it with the REST API — both ids are REST `id`s, not issue numbers:

    gh api -X POST repos/{owner}/{repo}/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker id>

Set it only when one issue literally can't start before another closes — not
for "related to" or "follow-up to", and not by writing "blocked by #N" in
prose, which nothing reads. A blocker outside the repo (an upstream tracker)
can't be linked: use the `blocked` label if the repo has one, and paste the
URL into the body.

**Give it self-contained context.** Name files by path and functions by
name; quote the two or three lines that actually matter. Never make a bare
issue number the only source of a requirement — nothing expands it (see
above), so "as discussed in #870" is invisible to the worker. Paste the
conclusion instead.

**Write acceptance criteria a reviewer can check against the diff.**
"`resolveX` returns `null` for an unrecognized name and logs a warning" is
checkable by reading the changed code; "improve error handling" is not —
and your body is literally what the review agent judges the diff against.

**State non-goals explicitly.** An "Out of scope" line keeps a worker from
wandering, and stops a reviewer flagging a deliberate omission as a
defect.

**Don't put PR mechanics in Scope.** Mullion pushes the branch, opens the
PR, and closes the issue once a human approves — the worker is explicitly
told not to. A Scope item asking it to open a PR, request a review, merge,
or clean up a branch/worktree afterward asks it to do something its own
instructions forbid. Checkboxes are for the humans reading the issue, not
a completion protocol the worker follows.

**Defer instead of footnoting.** If part of the work should be its own
issue — a follow-up, a deferred edge case — file it and link it, rather
than describing it in a paragraph the worker has no obligation to notice.
File it as a spec, not a note: it is work someone has to do, and a
well-specified deferral is exactly the kind of issue Task Master picks up
and implements on its own.

## Body directives

Eight directives, each matched **case-insensitively on its own line** — a
directive that merely appears in prose (e.g. "remember to set `Agent:
claude`") is deliberately not picked up, only a line matching exactly
(whitespace aside):

| Directive                 | Effect                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Manual: true`            | Ingests to `backlog`, not `ready` — never auto-claimed. Still claimable by hand. Deleting the line later moves a still-parked task to `ready` on the next sync; otherwise `backlog` → `ready` is a human action. Closed by a merged PR → task `done`; closed otherwise → `failed`. |
| `Agent: <name>`           | Which worker agent claims this task.                                                                                                                                                                                                                                               |
| `ReviewAgent: <name>`     | Which agent reviews the diff. `hermes` runs it on the Hermes server (offered once Settings → Review relay → "Task Master reviews" is on). `none`/`false` disables review.                                                                                                          |
| `Model: <model>`          | Implementer model override — every claimable agent, not just opencode.                                                                                                                                                                                                             |
| `Reviewer-Model: <model>` | Reviewer model — every agent; falls back to `Model:` if unset.                                                                                                                                                                                                                     |
| `SmallModel: <model>`     | opencode and claude only — lightweight small/fast model; inert on codex/agy.                                                                                                                                                                                                       |
| `Platform: <os>`          | The task must run on a host of that platform (`darwin`, `linux`, `win32`).                                                                                                                                                                                                         |
| `Host: <host id>`         | The task must run on exactly that host. With `Platform:`, both must hold.                                                                                                                                                                                                          |

Matching rules, all eight:

- **The key is always case-insensitive. For `Agent:`/`ReviewAgent:`/the
  `Model:` family, the value is not.** `Agent: Claude` matches the line,
  then fails the (lowercase) allow-list of known agents and falls through
  to the next tier with a warning — a bad value never blocks pickup, it
  just doesn't do what you expected. `Manual:` is the one exception: its
  whole line, value included, is matched case-insensitively (see below).
- The value can't contain whitespace or a trailing comment —
  `Agent: claude # default` doesn't match.
- It must be alone on the line: a `- ` bullet or `> ` quote prefix breaks
  the match.
- **A fenced code block doesn't hide a directive** — the parsers are
  plain regexes over the raw issue body with no markdown awareness. A
  directive still fires even if you paste it inside a fenced block.
- First match wins if a directive line appears more than once.
- `Manual: true`/`Manual: True`/`Manual: TRUE` all match — only the word
  `true` counts, in any casing; `Manual: yes` is inert.
- **`SmallModel:` only affects opencode- and claude-claimed tasks; on
  codex/agy it's silently inert.** `Model:` and `Reviewer-Model:` work for every
  claimable agent, but the expected shape differs by agent:
  opencode wants `provider/model` (more than one slash is fine, e.g.
  `openrouter/anthropic/claude-sonnet-4-5`), while claude/codex/agy take a
  bare `--model` value with no slash required (e.g. `sonnet`, `gpt-5`).
  A value in the wrong shape for the claiming agent is logged and falls
  through, same as any other malformed value.
- **`Platform:` / `Host:` are hard requirements, unlike every other
  directive.** A task that needs Xcode or the iOS Simulator should say
  `Platform: darwin`: it then runs only on an online, un-parked host of that
  platform that has the project (the project's "Also lives on" path), and works
  for a `pinned` project too. It never falls back to a host where it would just
  break. If a matching host exists but is offline or parked right now, the task
  **waits** in the queue (the reason shows on its card) and starts when the host
  is back — or is failed after 6 hours. If no host could ever match (none of that
  platform, or none with the project's path) the task is **failed at once with
  the reason on it**; fix the host (or the path), then move it back to `ready`. The
  platform is matched case-insensitively; a value no host reports (`mac`
  instead of `darwin`) matches nothing and is refused naming it. Leave both
  out and placement is the usual load-based choice. **Beware `Host:`** — it is
  an everyday word: a `Host: localhost` line in a pasted HTTP request or config
  snippet is parsed as the directive (fenced blocks do not hide it) and fails
  the task. Put such a line behind a `- ` or `> ` prefix, or reword it
  (indentation does not help — leading whitespace is ignored); the refusal
  names the line it came from.
- An unrecognized or malformed value at any tier is logged and falls
  through — never blocks pickup. If a directive doesn't seem to be taking
  effect, check it's really alone on its own line first.

### `Manual: true` is the exception, not the default

**Leave `Manual: true` off unless a human genuinely has to weigh in
BEFORE work starts.** Without it, the issue is claimable: Task Master picks
it up, a worker implements it, and a reviewer judges the diff, if one is
configured. That is the point of filing the issue.

Add it only for an issue where starting work would be wrong or wasteful
without a human's answer — an unsettled design decision, a spec whose
scope is genuinely ambiguous, a change that needs sign-off on direction.
Those are rare. "This is a follow-up" and "this was deferred" are **not**
reasons: a deferral is work someone has to do, and if it is specified
well enough to be worth filing, it is specified well enough to be
implemented.

Getting this backwards is expensive and quiet. An issue marked
`Manual: true` is ingested to `backlog` instead of `ready`, so it is never
auto-claimed; it sits there until a human claims it by hand. An issue
marked `Manual: true` that a human then closes with a merged PR is recorded
as done (linked to that PR); one closed without a merged PR is recorded as
failed. A
backlog full of `Manual: true` issues reads as "Task Master isn't picking
anything up" when in fact it was told not to.

If you are filing an issue because your plan deferred part of the work,
file it **without** `Manual: true` — unless a human has to weigh in on it
first, in which case that is exactly what the directive is for.

## Worked example

`references/worked-example.md` in this skill is one complete, filled-in
issue — copy-paste-ready, not a placeholder template. It's right-sized
(one function plus its one caller), self-contained (paths, a quoted
signature, exact line references), has checkable Scope items and an
explicit "Out of scope" list, and puts no PR/merge/cleanup step in the
worker's Scope. Its `ReviewAgent:` names a local CLI; `ReviewAgent: hermes`
is the other valid shape, but only on an install with "Task Master reviews"
turned on, and then `Reviewer-Model:` does not apply (Hermes's model is the
Review relay → Review policy → Model setting).

## Common mistakes

- A title with an invented type (`design:`, `decide:`, `idea:`,
  `investigate:`) or a coined scope (`task-master` when `tasks` exists) —
  use the Conventional Commits types and the repo's existing scopes.
- Filing without checking the open epics, so the issue floats loose instead
  of being attached to the group it belongs to.
- Describing a blocker in prose ("blocked by #N") instead of setting the
  `blocked_by` dependency — nothing reads the prose.
- Missing the `mullion-task` label — the single most common reason an
  issue "never gets picked up."
- A directive buried in a sentence, or given an uppercase value
  (`Agent: Claude`) that matches the line but fails the allow-list.
- A body whose only context for a requirement is a link to another issue
  — nothing expands `#123`, so the worker never sees it.
- Scope items telling the worker to open the PR, request a review, merge,
  or clean up the branch/worktree — Mullion owns all of that, and the
  worker is told not to touch it.
- Adding `Manual: true` to an issue that is simply deferred work, and
  watching it sit in `backlog` forever — `Manual: true` means "a human
  must weigh in before this starts", not "this is a follow-up". See
  "`Manual: true` is the exception, not the default" above.
- Forgetting `Manual: true` on something that genuinely needs a human to
  weigh in before work starts, and being surprised when it auto-claims.
- Sequencing a roadmap with parent/sub-issue nesting instead of
  `blocked_by` — nesting doesn't gate auto-claim, only dependencies do.

See
[`docs/tasks.md`](https://github.com/s3ntin3l8/mullion-session-manager/blob/main/docs/tasks.md)
for everything beyond issue authoring — claim/review/promote flow, worktree
layout, agent-selection precedence, and dependency gating.
