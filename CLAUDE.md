# CLAUDE.md — Tessera

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
`npm ci`, lint, typecheck, `format:check`, then tests. Coverage uploads to
Codecov (`CODECOV_TOKEN` is configured); `codecov.yml` sets the patch-coverage
target to 75% — Codecov's un-configured default is `auto` (match current
project coverage, ~94%), which fails even small, well-tested diffs and isn't
a required check for merging.

## Git workflow

**Never commit directly to `main`** — always branch and open a PR. This is
enforced by GitHub branch protection on `main` (PR required, `test-node /
lint-and-test` must pass, applies even to repo admins — no bypass), not just
convention. Branch names are freeform (e.g. `fix/attention-false-positive`,
`chore/prettier-hook`); the only naming rule that matters is the **PR title**
needing a conventional-commit prefix (see below). Use
[`.github/pull_request_template.md`](.github/pull_request_template.md)'s
checklist before opening.

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
  gives each test file an isolated temp SQLite DB.
- Config is read from `app.config` (typed via the `declare module "fastify"`
  augmentation in `src/plugins/env.ts`) — not `process.env` directly.
- After changing `src/db/schema.ts`, run `npm run db:generate` and commit the
  generated migration.
- **Secrets:** never commit real credentials; `detect-secrets` runs in pre-commit and
  CI against `.secrets.baseline` (regenerate with
  `detect-secrets scan > .secrets.baseline` after vetting new detections).
- **Before committing:** run `make lint && make typecheck && make test` (the pre-push
  hook enforces this).
