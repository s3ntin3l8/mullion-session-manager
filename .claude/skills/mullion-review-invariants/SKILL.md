---
name: mullion-review-invariants
description: "Repo-specific correctness invariants for this codebase (Mullion) — read this before reviewing or writing a diff here. Covers the sessions.command/workspaces.layout opaque-blob rule, the three NODE_ENV=test guards that must not be simplified, ESM .js import specifiers, config-via-app.config, DB migration generation, and the two distinct worktree concepts. Companion to the generic autonomous-pr-review skill, which deliberately carries no repo-specific invariants of its own."
---

# Mullion review invariants

This repo's `CLAUDE.md` documents these in prose; this skill exists so a
review pass (or `/code-review`, or a `mullion-reviewer` sub-agent) checks
them mechanically instead of relying on having read and remembered a 200+
line doc. If a diff violates one of these, it's very likely wrong even if
it's internally consistent and well-tested.

## The opaque-blob invariant

`sessions.command` and `workspaces.layout` are deliberately **opaque
blobs** — the backend never parses a shell command line or a dockview
layout, it just stores and replays what it's given. The **one** deliberate
exception is Claude Code's hook adapter (`src/services/hook-adapters/
claude-code.ts`), which appends `--settings`/`--mcp-config` flags via a
`commandTransform`.

**Red flag:** any new code that calls `.split()`, a regex, or a shell
parser on `session.command` or `workspace.layout` outside that one adapter.
If a change needs to know something about a command's shape, that's a sign
the data belongs in a typed field, not squeezed out of the opaque string.

## The three `NODE_ENV=test` guards — do not simplify or combine

- `test/setup.ts` isolates each test file with a temp SQLite DB and
  enforces `NODE_ENV=test`.
- `frontend/vitest.config.ts` sets `test.env` to prevent leaked production
  environments from loading production React (breaks `@testing-library/
react` by omitting `act`).
- `frontend/vite.config.ts` uses an inline check to prevent blanking Vite
  dev views with a `ReferenceError` from missing Fast-Refresh preambles.

These look redundant at a glance — they are not. Each guards a different
failure mode in a different tool. **Red flag:** a diff that merges these
into one shared check, or removes one because "the others already cover
it."

## ESM conventions

- `"type": "module"` throughout — import specifiers must end in `.js` even
  when importing a `.ts` source file (Node16 module resolution).
- `import type` for type-only imports (ESLint-enforced; a plain lint pass
  already catches most violations, but watch for it in a diff that mixes
  value and type imports from the same module).

## Configuration

Read config from `app.config` (`src/plugins/env.ts`'s schema), never
`process.env` directly. **Red flag:** a new `process.env.SOMETHING` read
outside `env.ts` itself or a script under `scripts/`.

## DB migrations

After editing `src/db/schema.ts`, `npm run db:generate` must have been run
and its output committed. **Red flag:** a schema change with no
corresponding new file under `drizzle/`.

## The two worktree concepts — don't conflate them

- **`.mullion-worktrees/`** — the product feature (`src/services/
git-worktree.ts`), for end-user session isolation. Gitignored via
  `.git/info/exclude`, not `.gitignore`. Reconciliation is scoped to the
  `mullion-task-` prefix plus manual GitPanel removal — an interactive
  "promote to worktree" session's own worktree has no reconciler at all and
  needs manual cleanup.
- **`.wt/`** — developer workspaces for isolating your own concurrent agent
  sessions on this codebase. Gitignored at the repo level. A fresh one
  needs `npm ci` at the root **and** in `frontend/`; tooling that globs the
  repo (Vitest, ESLint) excludes `.wt/**`.

**Red flag:** code or docs that treat these as the same thing, or that
assume `.wt/` worktrees get automatic cleanup the way `mullion-task-`
worktrees do.

## Test conventions

Tests live in `test/`, mirror `src/`, and use `app.inject()` — not a real
HTTP server — for route tests.
