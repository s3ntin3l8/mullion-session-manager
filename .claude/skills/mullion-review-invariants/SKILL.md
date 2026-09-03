---
name: mullion-review-invariants
description: "Repo-specific correctness invariants for this codebase (Mullion) — read this before reviewing or writing a diff here. Covers the sessions.command/workspaces.layout opaque-blob rule, the three NODE_ENV=test guards that must not be simplified, ESM .js import specifiers, config-via-app.config, DB migration generation, and the two distinct worktree concepts. Companion to the generic autonomous-pr-review skill, which deliberately carries no repo-specific invariants of its own."
---

# Mullion review invariants

`AGENTS.md`'s "Core invariants" section states each of these rules; this
skill exists so a review pass (or `/code-review`, or a `mullion-reviewer`
sub-agent) checks them mechanically instead of relying on having read and
remembered that file. If a diff violates one of these, it's very likely
wrong even if it's internally consistent and well-tested.

## The opaque-blob invariant

See `AGENTS.md`. The **one** deliberate exception is Claude Code's hook
adapter (`src/services/hook-adapters/claude-code.ts`), which appends
`--settings`/`--mcp-config` flags via a `commandTransform`.

**Red flag:** any new code that calls `.split()`, a regex, or a shell
parser on `session.command` or `workspace.layout` outside that one adapter.
If a change needs to know something about a command's shape, that's a sign
the data belongs in a typed field, not squeezed out of the opaque string.

## The three `NODE_ENV=test` guards — do not simplify or combine

See `AGENTS.md`. These look redundant at a glance — they are not. Each
guards a different failure mode in a different tool. **Red flag:** a diff
that merges these into one shared check, or removes one because "the others
already cover it."

## ESM conventions

See `AGENTS.md`. **Red flag:** a diff that mixes value and type imports
from the same module without `import type`, or an import specifier missing
`.js`.

## Configuration

See `AGENTS.md`. **Red flag:** a new `process.env.SOMETHING` read outside
`env.ts` itself or a script under `scripts/`.

## DB migrations

See `AGENTS.md`. **Red flag:** a schema change with no corresponding new
file under `drizzle/`.

## The two worktree concepts — don't conflate them

See `AGENTS.md` for the base rule. Reconciliation detail beyond its
one-line summary: `.mullion-worktrees/` reconciliation is scoped to the
`mullion-task-` prefix plus manual GitPanel removal — an interactive
"promote to worktree" session's own worktree has no reconciler at all and
needs manual cleanup.

**Red flag:** code or docs that treat these as the same thing, or that
assume `.wt/` worktrees get automatic cleanup the way `mullion-task-`
worktrees do.

## Test conventions

See `AGENTS.md`. Tests use `app.inject()` — not a real HTTP server — for
route tests.
