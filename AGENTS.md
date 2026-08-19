# AGENTS.md — Mullion

This file is the short, load-bearing version of this repo's workflow rules —
the ones every agent needs before touching anything, regardless of which CLI
you are. For architecture and full detail, see [`CLAUDE.md`](CLAUDE.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/agent-guide.md`](docs/agent-guide.md) (if you're running inside a
Mullion-hosted session, that last one is also injected into your context
automatically).

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
- **Post-merge:** delete the local and remote branch, and
  `git worktree remove <path>`.
- **Note for Codex:** an `AGENTS.override.md`, if one is ever added, takes
  precedence over `AGENTS.md`. If you add one, keep its briefing region in
  sync with this one — an out-of-sync override silently shadows everything
  above for Codex.

<!-- mullion:briefing:end -->
