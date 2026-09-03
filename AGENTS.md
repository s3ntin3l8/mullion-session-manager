# AGENTS.md — Mullion

This file is the single source of truth for this repo's workflow rules and
load-bearing invariants — the ones every agent needs before touching
anything, regardless of which CLI you are. `CLAUDE.md` is a one-line
`@AGENTS.md` import, so every CLI Mullion hosts (Claude Code, Codex,
opencode, agy) reads this file, natively or via that import. For deeper
detail beyond what's here, see [`docs/architecture.md`](docs/architecture.md)
(plugins/routes/services tour), [`docs/ci-cd.md`](docs/ci-cd.md) (CI/CD
internals), and [`CONTRIBUTING.md`](CONTRIBUTING.md) (contributor workflow).
[`docs/agent-guide.md`](docs/agent-guide.md) is also auto-injected into your
context if you're running inside a Mullion-hosted session.

<!-- mullion:briefing:start -->

- **Work in a worktree.** Developer worktrees live under `.wt/`, e.g.
  `.wt/<slug>`. Create one with `git fetch origin && git worktree add
.wt/<slug> -b <slug> origin/main`. A fresh worktree does **not** inherit
  `node_modules` — run `npm ci` at the repo root **and** `npm ci` in
  `frontend/` before testing or building.
- **Never commit directly to `main`.** Branch protection has no bypass.
  Always branch off the latest `origin/main` and open a PR.
- **PR title needs a Conventional Commits prefix** (`feat:`, `fix:`, `chore:`,
  ...). This repo squash-merges, so the PR title becomes the commit message on
  `main` — an unprefixed title silently drops out of the changelog.
- **Before pushing, run the full gate:**
  `make lint && make typecheck && make test && make format-check`
  (repo-wide — covers `frontend/` too).
- **Get a review, and close the loop on it.** Hermes reviews automatically
  on open — don't also `@s3ntin3l8-hermes Review` right after opening the PR,
  or you'll trigger a redundant second review. A re-review can be requested
  the same way (`@s3ntin3l8-hermes Review` on the PR) after pushing fixes,
  but keep it to a couple of rounds — don't loop on it indefinitely. Fixing
  the code is not enough to address feedback — reply to each inline comment
  via the GitHub API, then resolve the thread via the GraphQL
  `resolveReviewThread` mutation. See "Addressing review feedback" below for
  the exact two-step recipe.
- **Run a review pass on your own diff before declaring done** — `/code-review`
  in Claude Code, or the equivalent step in your own CLI.
- **File a GitHub issue for anything a plan defers, blocks, or descopes.**
  Before implementing, open one issue per item
  ([Issue Blueprint](.github/ISSUE_TEMPLATE/issue-blueprint.md) format) and
  link it from the PR — a footnote in a plan doc is not a durable record.
- **Post-merge:** delete the local and remote branch, and
  `git worktree remove <path>` — see "Post-merge cleanup" below for the exact
  commands.
- **Note for Codex:** an `AGENTS.override.md`, if one is ever added, takes
  precedence over `AGENTS.md` _entirely_ — Codex reads it _instead of_ this
  file. `npm run check:briefing-sync` (also a pre-commit hook) hard-fails if
  one ever carries its own copy of this region — AGENTS.md is the single
  source of truth now, so don't paste this region into it; point at this one
  instead.

<!-- mullion:briefing:end -->

## Core invariants

- **The non-obvious session model.** A session is a host PTY attached via
  `dtach`, running inside a transient `systemd --user` scope so it survives
  service redeploys/restarts. The `sessions` DB row records _intent_ (has
  this been explicitly killed?); live process state lives only in
  `PtyManager`'s in-memory map, and routes merge the two rather than trusting
  the DB column alone. Read this before touching `src/services/pty-manager.ts`
  or the terminal WS protocol.
- **`sessions.command` and `workspaces.layout` are opaque blobs.** The
  backend never parses a shell command line or a dockview layout — it just
  stores and replays what it's given.
- **ESM throughout.** Import specifiers end in `.js` even when importing
  `.ts` source files (Node16 resolution). Use `import type` for type-only
  imports.
- **Three `NODE_ENV=test` guards — do not simplify or combine them:**
  `test/setup.ts` (temp SQLite DB + enforces `NODE_ENV=test`),
  `frontend/vitest.config.ts` (prevents leaked production React, which
  breaks `@testing-library/react` by omitting `act`), and
  `frontend/vite.config.ts` (prevents blanking Vite dev views with a
  `ReferenceError` from missing Fast-Refresh preambles).
- **Read config from `app.config`** (`src/plugins/env.ts`), never
  `process.env` directly.
- **After editing `src/db/schema.ts`**, run `npm run db:generate` and commit
  the generated migration under `drizzle/`.
- **Tests** live in `test/`, mirror `src/`, and use `app.inject()`.
- **Two distinct worktree concepts** — don't conflate them: `.mullion-worktrees/`
  is a product feature (`src/services/git-worktree.ts`, end-user session
  isolation, managed by the backend); `.wt/` is _your own_ developer
  workspace, described above.

## Everyday commands

- `make dev` — backend (`tsx watch`) + frontend (Vite, HMR) together.
- `make test-backend` — backend tests only, the fast inner loop; `make test`
  runs both workspaces.
- `make format` — fixes a failing `make format-check` in place (repo-wide,
  covers `frontend/` too).
- `npm run db:generate` — after any `src/db/schema.ts` edit.
- A fresh `.wt/<slug>` worktree needs `npm ci` at the repo root **and**
  `cd frontend && npm ci` before it can build or test.

## Addressing review feedback (Hermes or human)

Always reply to and resolve inline conversations via the API — fixing the
code alone is not enough. Thread resolution is a GraphQL-only concept, so use
both steps:

1. **Reply to the comment:**
   ```bash
   gh api repos/s3ntin3l8/mullion-session-manager/pulls/<PR>/comments/<comment_id>/replies -f body="Fixed in latest commit"
   ```
2. **Resolve the thread:**
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_id>"}) { thread { isResolved } } }'
   ```
   _(Get `thread_id` via a `reviewThreads` query on the PR, not the REST
   comment ID.)_

## Post-merge cleanup

Skipping this lets stale references accumulate. Always run:

1. `git branch -d <branch>` — delete the local branch.
2. `git push origin --delete <branch>` — delete the remote branch.
3. `git worktree remove <path>` — remove the worktree, if one was used.

## Secrets

Real credentials must never be committed. `detect-secrets` scans code in
pre-commit/CI against `.secrets.baseline`; regenerate it with
`detect-secrets scan > .secrets.baseline`. A `pragma: allowlist secret`
comment must stay on the **same line** as the flagged string — Prettier can
silently move it to its own line, which breaks the allowlist match.
