---
name: taskmaster-issues
description: "How to write a GitHub issue that Mullion's Task Master will autonomously pick up and implement correctly: the mullion-task label, the six body directives and their exact matching rules, what the worker agent actually receives, and how to size and spec a body a worker can finish in one worktree. Read this before filing an issue meant for autonomous pickup in a Mullion project that has Task Master enabled — irrelevant to a project that doesn't use it."
---

# Writing a Task Master issue

Only relevant to a project where Mullion's Task Master is enabled — if this
repo doesn't have a background task watcher polling its issues, this skill
doesn't apply. See `docs/tasks.md` for the full system; this is just the
"how do I write the issue" cheat sheet.

## What the worker actually gets

Before anything else: your issue's **title and body are passed to the
worker verbatim** — title, a blank line, then the body, nothing stripped,
not even the directive lines below. There is no parsing, no summarization,
no expansion: whatever isn't in the text you write is invisible to the
agent that implements it.

- **No parent issue, epic, or linked issue is ever pulled into the
  prompt.** A bare `#123` reference is just four characters to the worker
  — it never resolves to that issue's content.
- **The same title+body is what the reviewer judges the diff against**,
  when a review agent is configured — your body is the acceptance spec,
  not a hint.
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

## Body directives

Six directives, each matched **case-insensitively on its own line** — a
directive that merely appears in prose (e.g. "remember to set `Agent:
claude`") is deliberately not picked up, only a line matching exactly
(whitespace aside):

| Directive                          | Effect                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `Manual: true`                     | Ingests to `backlog`, not `ready` — never auto-claimed. Still claimable by hand. |
| `Agent: <name>`                    | Which worker agent claims this task.                                             |
| `ReviewAgent: <name>`              | Which agent reviews the diff. `none`/`false` disables review.                    |
| `Model: <provider/model>`          | opencode only — implementer model.                                               |
| `Reviewer-Model: <provider/model>` | opencode only — reviewer model; falls back to `Model:` if unset.                 |
| `SmallModel: <provider/model>`     | opencode only — opencode's lightweight `small_model`.                            |

Matching rules, all six:

- **The key is case-insensitive; the value is not.** `Agent: Claude`
  matches the line, then fails the (lowercase) allow-list of known agents
  and falls through to the next tier with a warning — a bad value never
  blocks pickup, it just doesn't do what you expected.
- The value can't contain whitespace or a trailing comment —
  `Agent: claude # default` doesn't match.
- It must be alone on the line: a `- ` bullet or `> ` quote prefix breaks
  the match.
- **A fenced code block doesn't hide a directive** — the parsers are
  plain regexes over the raw issue body with no markdown awareness. A
  directive still fires even if you paste it inside a fenced block.
- First match wins if a directive line appears more than once.
- `Manual:` matches only the literal value `true` — `Manual: yes` is
  inert.
- The three `Model:`-family directives only affect opencode-claimed
  tasks; on claude/codex/agy they're silently inert. Their value must
  look like `provider/model` — more than one slash is fine, e.g.
  `openrouter/anthropic/claude-sonnet-4-5`.
- An unrecognized or malformed value at any tier is logged and falls
  through — never blocks pickup. If a directive doesn't seem to be taking
  effect, check it's really alone on its own line first.

## Worked example

`references/worked-example.md` in this skill is one complete, filled-in
issue — copy-paste-ready, not a placeholder template. It's right-sized
(one function plus its one caller), self-contained (paths, a quoted
signature, exact line references), has checkable Scope items and an
explicit "Out of scope" list, and puts no PR/merge/cleanup step in the
worker's Scope.

## Common mistakes

- Missing the `mullion-task` label — the single most common reason an
  issue "never gets picked up."
- A directive buried in a sentence, or given an uppercase value
  (`Agent: Claude`) that matches the line but fails the allow-list.
- A body whose only context for a requirement is a link to another issue
  — nothing expands `#123`, so the worker never sees it.
- Scope items telling the worker to open the PR, request a review, merge,
  or clean up the branch/worktree — Mullion owns all of that, and the
  worker is told not to touch it.
- Forgetting `Manual: true` on something that genuinely needs a human to
  weigh in before work starts, and being surprised when it auto-claims.
- Sequencing a roadmap with parent/sub-issue nesting instead of
  `blocked_by` — nesting doesn't gate auto-claim, only dependencies do.

See `docs/tasks.md` for everything beyond issue authoring — claim/review/
promote flow, worktree layout, agent-selection precedence, and dependency
gating.
