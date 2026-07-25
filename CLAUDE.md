# CLAUDE.md — Mullion

A self-hosted, tiled, persistent browser dashboard for host-run AI CLI terminals
(Claude Code, Codex, opencode, ...), built on a Fastify + TypeScript backend
(SQLite via Drizzle, encryption-at-rest, security middleware) wired to the
centralized CI/CD in [`s3ntin3l8/.github`](https://github.com/s3ntin3l8/.github).
If you are an AI agent or developer working in this repo, read this first —
and read the full design in
[`.claude/plans/ok-i-m-thinking-of-merry-corbato.md`](.claude/plans/ok-i-m-thinking-of-merry-corbato.md)
before touching `src/services/pty-manager.ts` or the terminal WS protocol.

## Commands (Makefile)

| Command              | Does                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `make install`       | Install dependencies (`npm ci`).                                                |
| `make install-hooks` | Install pre-commit + pre-push hooks.                                            |
| `make dev`           | Start backend (`tsx watch`) + frontend (Vite, HMR) together via `concurrently`. |
| `make test`          | Run the Vitest suite.                                                           |
| `make test-coverage` | Run tests with coverage (`vitest run --coverage`).                              |
| `make lint`          | Run ESLint.                                                                     |
| `make typecheck`     | Type-check with `tsc --noEmit`.                                                 |
| `make format`        | Format the whole repo with Prettier (`--write`, includes `frontend/`).          |
| `make format-check`  | Check formatting without writing — the pre-push gate.                           |
| `make build`         | Production build → `dist/`.                                                     |
| `make clean`         | Remove `node_modules`, `dist`, and caches.                                      |

`make dev`/`test`/`lint`/`typecheck` cover the backend only; `format`/
`format-check` run repo-wide (they resolve `.prettierrc` from the root and
cover `frontend/` too — see `.prettierignore` for excluded generated/vendored
paths). The frontend is a separate npm workspace with its own `dev`/`build`/
`lint`/`typecheck` scripts — run them from `frontend/` (or see `README.md`'s
Quick Start). Direct npm equivalents also exist for the backend: `npm run
db:generate` (after `src/db/schema.ts` edits) and `npm run db:seed`.

## Architecture / Layout

- **App factory**: `src/app.ts` exports `buildApp()`, which registers plugins then
  routes and returns the Fastify instance. `src/server.ts` calls it and handles
  listen + graceful shutdown (`SIGINT`/`SIGTERM`).
- **Plugins** (`src/plugins/`, all wrapped in `fastify-plugin`): `env`, `logging`,
  `security` (helmet, rate-limit, CORS), `db` (migrations + `app.db`/
  `app.encryption`), `pty` (`app.pty` session manager + a 30s exited-session
  reconciler), `websocket`, `static` (serves the built frontend once present).
- **Routes** (`src/routes/`): a full feature surface — `projects`, `sessions`,
  `workspaces`, `groups`, `agents`, `actions`, `server-info`, and `terminal`
  (`/ws/terminal`, the PTY bridge), plus `health`. See `README.md`'s Structure
  section for the complete list. `users` and `root` are **leftover scaffolding**
  from the base template (`users` = example CRUD/encryption demo; `root` =
  placeholder `/`, disabled once the frontend build exists) — not product
  features, don't build on them.
- **Services** (`src/services/`): `pty-manager` is the heart of the app (see
  below); also `project-config` (launcher/dock config resolution),
  `agent-detect`, `attention-detect` (BEL/OSC parsing), `session-reconciler`,
  `encryption` (AES-256-GCM at-rest), `date-utils`.
- **The non-obvious model** — read this before touching sessions or
  workspaces: a session is a host PTY attached via `dtach`, running inside a
  transient `systemd --user` scope so it survives service redeploys/restarts.
  The `sessions` DB row records _intent_ (has this been explicitly killed?);
  live process state lives only in `PtyManager`'s in-memory map, and routes
  merge the two rather than trusting the DB column alone. `sessions.command`
  and `workspaces.layout` are deliberately **opaque blobs** — the backend
  never parses a shell command line or a dockview layout, it just stores and
  replays what it's given. (See the design-doc pointer above.)
- **`frontend/`**: standalone Vite + React 19 + dockview + xterm.js app with
  its own `package.json`/tsconfig/eslint — not part of the backend's npm
  workspace tooling.
- **`deploy/`**: `install.sh` (versioned-release bootstrap for a fresh host —
  the actual production install path) + a `systemd --user` unit template it
  fills in, plus Traefik/Authentik config templates (still hand-edited, not
  installed by this repo or its CI) — see `deploy/README.md`. There is no
  Docker image: the app runs natively on the host (dtach/systemd-run
  dependencies in `pty-manager.ts` mean a container can't preserve live
  terminal sessions across redeploys), installed from a CI-built release
  tarball instead (`release-please.yml`'s `build-tarball` job).
- **DB** (`src/db/`): Drizzle schema/client/seed; SQL migrations in `drizzle/`.
  `getDb()`/`ensureDb()`/`closeDb()` manage a singleton connection.
- `.github/workflows/` — thin callers of the reusable workflows in `s3ntin3l8/.github`.
- `.claude/` — `settings.json` + `hooks/session-start.sh`: a SessionStart hook that
  installs deps and tooling so
  [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
  sessions can build, test, and lint. Runs only in the remote env.

## CI/CD — uses centralized reusable workflows

Workflows here are **callers** of `s3ntin3l8/.github/.github/workflows/*.yml@main`:
`ci-cd.yml` (test-node + test-frontend only — no Docker image is built),
`codeql.yml`, `dependency-review.yml`, `release-please.yml`. `release-please.yml`
also has one job that's a real multi-step job rather than a reusable-workflow
call — `build-tarball`, which assembles and uploads the versioned-release
tarball (see `deploy/README.md`) — a deliberate exception to the "thin caller"
convention, since there's no reusable "build a tarball" workflow upstream.

**The #1 thing to get right:** a caller job that invokes a reusable workflow needing
write scopes **must declare a `permissions:` block** — the default `GITHUB_TOKEN` is
read-only and the run otherwise fails at startup with zero jobs. The caller's grant
must cover **every** scope the reusable workflow's jobs declare, or the run fails at
startup. `codeql` needs `security-events: write`; `release-please` needs
`contents: write` + `pull-requests: write`; `build-tarball` needs
`contents: write` (to `gh release upload`) even though it's not a reusable-workflow
call. See the `s3ntin3l8/.github` README for the full table.

`ci-cd.yml` calls the reusable `ci-node.yml` **twice** — `test-node` (root,
`test-script: test:coverage`, `coverage-fail-under: 80`) and `test-frontend`
(`working-directory: frontend`, its own lockfile/typecheck/test scripts, no
coverage floor since the frontend has no `test:coverage` script). Both run
`npm ci`, lint, typecheck, then tests; only `test-node` also runs
`format:check` (`test-frontend`'s `with:` block doesn't set
`format-check-script`, so that step is skipped there — formatting for
`frontend/` is still covered by the root-level `make format-check`/pre-push
hook, which is repo-wide). Coverage uploads to Codecov (`CODECOV_TOKEN` is
configured); `codecov.yml` sets the patch-coverage target to 75% —
Codecov's un-configured default is `auto` (match current project coverage,
~94%), which fails even small, well-tested diffs and isn't a required check
for merging.

`test-node` also sets `test-shards: "2"` — the reusable workflow's opt-in
sharding: `test-node / lint-and-test` still runs lint/typecheck/format/build
but no longer any tests once sharding is on, while a parallel `shard-plan` →
2×`test-shard` → `test-merge` chain does the actual test run and
coverage-threshold enforcement (merged once over the union, never
per-shard). See the Git workflow section below for why `test-merge` must be
a required branch-protection check as a result. Requires the test script's
coverage reporter to include istanbul's `json` format alongside
`json-summary` (`vitest.config.ts`'s `coverage.reporter` already does) —
that's what `test-merge` needs to re-combine shard coverage. The shared
`ci-node.yml`'s `detect-secrets` step is pip-cache-warmed
(`s3ntin3l8/.github#46`) — previously an uncached ~20s/job, run once per
caller job.

## Git workflow

**Never commit directly to `main`** — always branch and open a PR. This is
enforced by GitHub branch protection on `main` (PR required, applies even to
repo admins — no bypass), not just convention. The full required-status-check
list (verify with `gh api repos/s3ntin3l8/mullion-session-manager/branches/main/protection
--jq '.required_status_checks.contexts'` if in doubt — it has drifted from
what's written here before) is currently: `test-node / lint-and-test`,
`test-node / test-merge` (the sharded test run's coverage gate — see CI/CD
section above), `test-frontend / lint-and-test`, and CodeQL's
`analyze / Analyze (javascript-typescript)`. CodeQL **is** required, not
just advisory. Branch names are freeform (e.g. `fix/attention-false-positive`,
`chore/prettier-hook`); the only naming rule that matters is the **PR title**
needing a conventional-commit prefix (see below). Use
[`.github/pull_request_template.md`](.github/pull_request_template.md)'s
checklist before opening.

**After a PR merges**, clean up rather than leaving stale state around:
delete the local branch (`git branch -d <branch>`), delete the remote branch
(`git push origin --delete <branch>` — GitHub's "Delete branch" button on the
merged PR does the same), and if the work was done in its own git worktree
(see Worktrees below) and that worktree wasn't shared with other in-flight
work, remove it too (`git worktree remove <path>`). None of this happens
automatically — there's no reconciler for either worktree flavor described
below — so skipping it lets stale branches/worktrees accumulate silently
until something (a tooling sweep, a confused `git branch -a`) trips over
them.

## Worktrees

Two distinct, easily-confused things both called "worktree" in this repo:

- **`.mullion-worktrees/`** — Mullion's own **product** feature (issue #271,
  `src/services/git-worktree.ts`'s `createWorktree()`): an end-user's
  worktree-isolation launcher toggle or "promote to worktree" action creates
  a real `git worktree add -b <branch>` checkout under here for a _session
  Mullion itself is managing_. Gitignored via `.git/info/exclude` (added
  automatically by `ensureExcluded()`), not `.gitignore` — deliberately
  local-only, not a repo-wide convention. **Create-only by design**: per the
  file's own header comment, there is intentionally no remove/prune/
  reconciler yet, so the manual-cleanup discipline above applies here too.
- **`.worktrees/`** — a separate, repo-level (`.gitignore`'d) convention for
  isolating **your own** concurrent Claude Code session work on _this
  codebase_, unrelated to Mullion's product code — e.g. two Claude Code
  sessions each working a different branch via their own
  `.worktrees/<branch>/` checkout so they don't collide in one working
  directory. Two things to know before touching one:
  - **A freshly created worktree does not inherit `node_modules`** — its
    `npm ci` (root) and `cd frontend && npm ci` need to run at least once
    before its own tests/lint/build work. Hit this directly (issue found
    mid-session): a sibling worktree's missing `frontend/node_modules` broke
    `frontend/vite.config.test.ts` when it got swept into root's own test run (see
    next point) before `npm ci` had been run there.
  - **Any root-level tool config that globs the whole repo must exclude
    `.worktrees/**`**, the same way both `vitest.config.ts` and
    `eslint.config.js` already exclude `frontend/` (a second, separate
    workspace) — otherwise every active sibling worktree's own full
    `src/`/`frontend/`/`test/` tree gets swept up and re-checked a second
    time by the _root_ config/`node_modules`, which is both wasteful
    (confirmed: over half of a `lint` run's files) and can outright break
    (a worktree missing dependencies fails with an unrelated-looking error).
    `.pre-commit-config.yaml`'s hooks are workspace-path-scoped (`files:`
    regexes, not the old path-blind `types_or:`) for the same reason, plus
    to skip a workspace's own checks entirely when only the other one
    changed. `npm run lint:all`/`typecheck:all`/`test:all` (concurrently-based,
    mirroring the `dev` script) run both workspaces' checks in parallel for
    a fast manual full-repo check.

## Conventions

- **ESM throughout** (`"type": "module"`); imports use `.js` specifiers even for `.ts`
  sources (Node16 resolution). Prefer `import type` for type-only imports (enforced by
  ESLint).
- **Conventional Commits** — Release Please cuts versions/changelogs from them.
  **PR titles must also use a conventional-commit prefix** (`feat:`, `fix:`,
  `chore:`, `docs:`, ...), not just the underlying commits: this repo squash-merges
  PRs, and GitHub uses the **PR title** as the squashed commit's message on `main`,
  discarding the individual commits' own prefixes. A PR titled without one (e.g.
  "Add X") produces an unparseable commit that Release Please silently drops from
  the changelog/version bump — this actually happened (PR #5, fixed via a
  retroactive empty `feat:` commit rather than rewriting already-pushed history).
- Tests live in `test/`, mirroring `src/`, and use `app.inject()`. `test/setup.ts`
  gives each test file an isolated temp SQLite DB and forces `NODE_ENV=test`
  (#82) since a dev shell exporting `NODE_ENV=production` would otherwise leak
  through and mismatch what tests assert. `frontend/vitest.config.ts` has the
  same guard, via `test.env` rather than a setup file — react is imported
  before a setup file's own `process.env` assignment would run, and a leaked
  `NODE_ENV=production` there makes react resolve its production build, which
  doesn't export `act` and crashes `@testing-library/react` (#114). Don't
  "simplify" either guard into the other file's style. `frontend/vite.config.ts`
  carries a third variant of the same guard, for `vite dev` itself rather than
  its test runner: a leaked `NODE_ENV=production` makes `@vitejs/plugin-react`
  drop the Fast-Refresh preamble while still emitting `$RefreshReg$`
  registrations, blanking the page with a `ReferenceError` (#105).
- Config is read from `app.config` (typed via the `declare module "fastify"`
  augmentation in `src/plugins/env.ts`) — not `process.env` directly.
- After changing `src/db/schema.ts`, run `npm run db:generate` and commit the
  generated migration.
- **Secrets:** never commit real credentials; `detect-secrets` runs in pre-commit and
  CI against `.secrets.baseline` (regenerate with
  `detect-secrets scan > .secrets.baseline` after vetting new detections).
- **Before committing:** run `make lint && make typecheck && make test` (the pre-push
  hook enforces this).
