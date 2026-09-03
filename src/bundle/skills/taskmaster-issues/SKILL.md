---
name: taskmaster-issues
description: "How to write a GitHub issue that Mullion's Task Master will autonomously pick up and work correctly: the mullion-task label, the Manual:/Agent:/ReviewAgent: body directives and their exact formatting, and a body template. Read this before filing an issue meant for autonomous pickup in a Mullion project that has Task Master enabled — irrelevant to a project that doesn't use it."
---

# Writing a Task Master issue

Only relevant to a project where Mullion's Task Master is enabled — if this
repo doesn't have a background task watcher polling its issues, this skill
doesn't apply. See `docs/tasks.md` for the full system; this is just the
"how do I write the issue" cheat sheet.

## The label

Task Master's watcher polls each connected project's repo for open issues
carrying a specific label — `mullion-task` by default, configurable per
install via `MULLION_TASK_LABEL`. **No label, no pickup** — an issue
without it just sits there, however well-formatted the body is. If you're
not sure of the configured label name on this install, ask a human or check
`Settings → Task Master`.

## Body directives

Three optional directives, each matched **case-insensitively on its own
line** — a directive that merely appears in prose (e.g. "remember to set
`Agent: claude`") is deliberately NOT picked up, only a line matching
exactly (whitespace aside):

- `Manual: true` — prevents auto-claim; the task is created but waits for a
  human to claim it explicitly. Use for anything that needs human framing
  before an agent starts working it.
- `Agent: <name>` — overrides which worker agent claims this task, instead
  of the project/install default. `<name>` must be one of the known agent
  binaries (`claude`, `codex`, `opencode`, `agy`, ...); an unrecognized name
  is logged and falls through to the next default rather than blocking
  pickup.
- `ReviewAgent: <name>` — same idea, for the review agent that looks at the
  resulting diff.

An unformatted line — extra leading text, the directive mid-sentence, wrong
casing beyond what the case-insensitive match already tolerates, a typo —
is silently ignored, not an error. If a directive doesn't seem to be taking
effect, check that it's really on its own line with nothing else on it.

## Body template

This repo's own issue convention (`.github/ISSUE_TEMPLATE/issue-blueprint.md`)
is a good shape for a task issue too — Context, then a checkbox Scope list a
worker agent can work through and check off one by one:

```markdown
## Context

<!-- The problem, current behavior, and relevant code references. -->

## Scope

- [ ] <!-- Requirement 1, concrete and independently checkable -->
- [ ] <!-- Requirement 2 -->
- [ ] Update docs/*.md if there are user-facing behavior/CLI changes
- [ ] Test coverage additions/modifications

Agent: claude
ReviewAgent: codex
```

A vague body ("improve error handling somewhere in the task service") gives
a worker agent no actionable spec and produces a worse PR than filing
nothing — write the Scope checklist the way you'd want a human contributor
to read it.

## Common mistakes

- Missing the `mullion-task` label — the single most common reason an issue
  "never gets picked up."
- A directive buried in a sentence instead of alone on its own line.
- A body with no concrete Scope items — just a title and a paragraph of
  prose.
- Forgetting `Manual: true` on an issue that genuinely needs a human to
  weigh in before work starts, and being surprised when it auto-claims.

See `docs/tasks.md` for everything beyond issue authoring — claim/review/
promote flow, worktree layout, and the full directive resolution precedence
order.
