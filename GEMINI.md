# GEMINI.md — Mullion

For architecture and full detail, see [`CLAUDE.md`](CLAUDE.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/agent-guide.md`](docs/agent-guide.md) (if you're running inside a
Mullion-hosted session, that last one is also injected into your context
automatically).

<!-- mullion:pointer:start -->

Read [`AGENTS.md`](AGENTS.md) — it's the single source of truth for this
repo's workflow rules (worktree usage, branch/PR rules, the pre-push gate,
the review loop). This file is deliberately NOT a copy of it (issue #942) —
`scripts/check-briefing-sync.mjs` (also a pre-commit hook) hard-fails if it
ever re-acquires one.
<!-- mullion:pointer:end -->
