# AGENTS.md — Mullion

This file is the short, load-bearing version of this repo's workflow rules —
the ones every agent needs before touching anything, regardless of which CLI
you are. For architecture and full detail, see [`CLAUDE.md`](CLAUDE.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/agent-guide.md`](docs/agent-guide.md) (if you're running inside a
Mullion-hosted session, that last one is also injected into your context
automatically).

**Note for opencode:** having this file present means your own loader reads
_only_ this file, not `CLAUDE.md` — per opencode's own docs, "if you have
both AGENTS.md and CLAUDE.md, only AGENTS.md is used." `CLAUDE.md`'s deeper
invariants (the opaque-blob rule for `sessions.command`/`workspaces.layout`,
the three `NODE_ENV=test` guards, ESM `.js` specifiers, `app.config` over
`process.env`, `db:generate` after schema edits) are **not** auto-loaded for
you — explicitly go read `CLAUDE.md` yourself before touching anything it
covers, rather than assuming it reached your context automatically.

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
- **Get a review, and close the loop on it.** Request a Hermes review
  (`@s3ntin3l8-hermes Review` on the PR, or it runs automatically on open).
  Fixing the code is not enough to address feedback — reply to each inline
  comment via the GitHub API, then resolve the thread via the GraphQL
  `resolveReviewThread` mutation. See `CLAUDE.md`'s "Addressing Review
  Feedback" section for the exact two-step recipe.
- **Run a review pass on your own diff before declaring done** — `/code-review`
  in Claude Code, or the equivalent step in your own CLI.
- **File a GitHub issue for anything a plan defers, blocks, or descopes.**
  Before implementing, open one issue per item
  ([Issue Blueprint](.github/ISSUE_TEMPLATE/issue-blueprint.md) format) and
  link it from the PR — a footnote in a plan doc is not a durable record.
- **Post-merge:** delete the local and remote branch, and
  `git worktree remove <path>`.
- **Note for Codex:** an `AGENTS.override.md`, if one is ever added, takes
  precedence over `AGENTS.md` _entirely_ — Codex reads it _instead of_ this
  file. `npm run check:briefing-sync` (also a pre-commit hook) hard-fails if
  one ever carries its own copy of this region (or if `GEMINI.md` does) —
  AGENTS.md is the single source of truth now, so don't paste this region
  into either file; point at this one instead.

<!-- mullion:briefing:end -->
