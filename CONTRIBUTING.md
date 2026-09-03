# Contributing

## Setup

```bash
make install          # backend deps
make install-hooks    # pre-commit + pre-push git hooks (see below — do this before your first commit)
cd frontend && npm install
```

See the [Quick Start](README.md#-quick-start) in `README.md` for running the
app locally, and [`docs/architecture.md`](docs/architecture.md) for the full
architecture/layout tour.

## Developer worktrees (`.wt/`)

Isolate your own concurrent agent sessions on this codebase under `.wt/`,
e.g. `.wt/<slug>` — gitignored at the repo level. A new worktree does **not**
inherit `node_modules`: run `npm ci` at the repo root **and**
`cd frontend && npm ci` before testing or building.

- **Path exclusion:** tooling configs that glob the repo (Vitest, ESLint)
  must exclude `.wt/**` to prevent duplicate workspace runs or dependency
  collisions.
- **Commit hooks:** `.pre-commit-config.yaml` uses file-based path scopes
  (`files:`) rather than generic `types_or:`, so a hook only checks the
  workspace it actually applies to.

## Before opening a PR

`make install-hooks` wires up local git hooks that catch most of this
automatically — `pre-commit` runs lint/typecheck (scoped to whichever
workspace you touched) and `pre-push` additionally runs the full test suite
(both workspaces) and a **repo-wide** `prettier --check` (covers
`frontend/` too, not just the backend). Run the same checks manually before
opening a PR — `make lint`/`typecheck`/`test` already cover both
workspaces; use `make test-backend` if you just want the backend-only fast
loop:

```bash
make lint && make typecheck && make test && make format-check
```

If `make format-check` fails, `make format` applies the fix in place.

If you changed `src/db/schema.ts`, also run `npm run db:generate` and commit
the generated migration under `drizzle/`.

All issues and pull request descriptions must adhere to the standard templates:

- Issue blueprint: [.github/ISSUE_TEMPLATE/issue-blueprint.md](.github/ISSUE_TEMPLATE/issue-blueprint.md)
- PR template: [.github/pull_request_template.md](.github/pull_request_template.md)

The templates enforce checking all guidelines (make lint, typecheck, test, format-check, migrations) before submission. Fill them in rather than skipping them.

## PR title

Must use a [Conventional Commits](https://www.conventionalcommits.org/)
prefix (`feat:`, `fix:`, `chore:`, `docs:`, ...) — this repo squash-merges
PRs and Release Please parses the **PR title**, not the individual commits,
to cut versions/changelogs. An unprefixed title silently drops from the
changelog.

## Branch protection

`main` requires a PR (no direct pushes, no admin bypass) and these status
checks: `test-node / lint-and-test`, `test-node / test-merge`,
`test-frontend / lint-and-test`, and CodeQL's
`analyze / Analyze (javascript-typescript)`. All of the above (lint,
typecheck, test, format-check) map directly to what those checks run, so a
clean local run should mean a clean CI run.

## Automated review

PRs opened from a fork won't get GitHub Actions secrets (a GitHub security
boundary, not a bug), so the automated Hermes review that normally runs on
`opened` won't complete for fork PRs — a maintainer can still trigger it
manually by commenting `@s3ntin3l8-hermes Review` on the PR, which runs in
the base repo's context.

## Addressing review feedback, and post-merge cleanup

See [`AGENTS.md`](AGENTS.md)'s "Addressing review feedback" and "Post-merge
cleanup" sections for the exact commands — the reply-and-resolve two-step for
inline PR comments, and the branch/worktree cleanup after a merge.
