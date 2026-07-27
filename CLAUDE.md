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
  `workspaces`, `groups`, `agents`, `actions`, `server-info`, `terminal`
  (`/ws/terminal`, the PTY bridge), `webhooks` (`/api/webhooks/github`, the
  webhook handler), `ws-github` (`/ws/github`, real-time event push), plus
  `health`. See `README.md`'s Structure
  section for the complete list. `users` and `root` are **leftover scaffolding**
  from the base template (`users` = example CRUD/encryption demo; `root` =
  placeholder `/`, disabled once the frontend build exists) — not product
  features, don't build on them.
- **Services** (`src/services/`): `pty-manager` is the heart of the app (see
  below); also `project-config` (launcher/dock config resolution),
  `agent-detect`, `attention-detect` (BEL/OSC parsing), `session-reconciler`,
  `encryption` (AES-256-GCM at-rest), `date-utils`, `github-webhook` (webhook
  registration/management), `github-activity-tracker` (per-repo activity state
  for adaptive polling), `github-ws-broadcast` (WS event push to frontends).
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

Workflows are **callers** of `s3ntin3l8/.github/.github/workflows/*.yml@main`:

- `ci-cd.yml` (test-node + test-frontend only — no Docker image is built)
- `codeql.yml`, `dependency-review.yml`, `release-please.yml`
- **Exception:** `build-tarball` job in `release-please.yml` is a custom multi-step job that assembles/uploads the versioned-release tarball (no upstream reusable workflow exists).

### Reusable Workflows Rule

- **Permissions block:** Callers invoking reusable workflows needing write scopes **must declare a `permissions:` block**. The default `GITHUB_TOKEN` is read-only; missing permissions fail at startup with zero jobs.
- The caller's grant must cover **every** scope of the reusable workflow:
  - `codeql` needs `security-events: write`
  - `release-please` needs `contents: write` + `pull-requests: write`
  - `build-tarball` needs `contents: write` (to upload gh release assets)

### ci-cd.yml structure

- **`test-node` (backend)**: Runs at root. Script: `test:coverage`, `coverage-fail-under: 80`. Runs `npm ci`, lint, typecheck, format-check, and tests.
- **`test-frontend`**: Runs under `frontend/`. No coverage floor (no `test:coverage` script). Skips format-check in CI (root-level `make format-check` hook covers it).
- **Codecov**: Uploads coverage using `CODECOV_TOKEN`. Target patch coverage is 75% (configured via `codecov.yml` to prevent failures on minor, well-tested diffs).
- **Test Sharding (`test-shards: "2"`)**:
  - Node tests shard into `shard-plan` → 2×`test-shard` → `test-merge`.
  - `test-node / lint-and-test` runs lint/typecheck/format/build but **no tests**.
  - `test-merge` is the final test/coverage check; it must be a **required check** in branch protection.
  - Requires istanbul `json` reporter format alongside `json-summary` (set in `vitest.config.ts`) to merge shard results.
- **Secrets detection**: `ci-node.yml`'s `detect-secrets` step is pip-cache-warmed to avoid uncached overhead.

## Git workflow

- **No direct commits to `main`:** Always branch and open a PR (enforced by branch protection with no bypass).
- **Branch off the latest remote `main`:** Always run `git fetch origin` and base new branches off the latest remote base branch (e.g., `git checkout -b <branch> origin/main`) to avoid building on stale commits or missing recent releases.
- **Required status checks for merge:**
  - `test-node / lint-and-test`
  - `test-node / test-merge` (sharded coverage gate)
  - `test-frontend / lint-and-test`
  - `analyze / Analyze (javascript-typescript)` (CodeQL is mandatory)
  - _Verify current contexts via:_ `gh api repos/s3ntin3l8/mullion-session-manager/branches/main/protection --jq '.required_status_checks.contexts'`
- **Branch naming:** Freeform (e.g. `fix/xyz`, `chore/abc`).
- **PR Title:** Must use a Conventional Commits prefix (e.g., `feat:`, `fix:`). Because this repo squash-merges PRs, the PR title is used as the squashed commit message on `main`. An unprefixed title will be silently dropped from the changelog.
- **Issue & PR Blueprints:** All issues and PRs must follow the formatting templates:
  - Issue Template: [.github/ISSUE_TEMPLATE/issue-blueprint.md](.github/ISSUE_TEMPLATE/issue-blueprint.md)
  - PR Template: [.github/pull_request_template.md](.github/pull_request_template.md)

### Addressing Review Feedback (Hermes or Human)

Always reply to and resolve inline conversations via the API (fixing code alone is not enough). Since thread resolution is a GraphQL-only concept, use these two steps:

1. **Reply to comment:**
   ```bash
   gh api repos/s3ntin3l8/mullion-session-manager/pulls/<PR>/comments/<comment_id>/replies -f body="Fixed in latest commit"
   ```
2. **Resolve the thread:**
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_id>"}) { thread { isResolved } } }'
   ```
   _(Retrieve `thread_id` node ID via a `reviewThreads` query on the PR, not the REST comment ID)._

### Post-Merge Cleanup

Skipping cleanup lets stale references accumulate. Always run:

1. Delete local branch: `git branch -d <branch>`
2. Delete remote branch: `git push origin --delete <branch>`
3. Remove custom git worktree (if used): `git worktree remove <path>`

## Worktrees

Two distinct, easily-confused worktree concepts are used in this repo:

### 1. `.mullion-worktrees/` (Product Feature)

- Managed by Mullion's backend (`src/services/git-worktree.ts`) for end-user session isolation.
- Created via the launcher toggle or "promote to worktree" action.
- Gitignored via `.git/info/exclude` (local-only), not `.gitignore`.
- **Create-only by design:** There is no automatic reconciler; manual cleanup is required.

### 2. `.worktrees/` (Developer Workspaces)

- Used for isolating **your own** concurrent agent sessions on this codebase.
- Gitignored at the repo level.
- **Rules when using developer worktrees:**
  - **Fresh setups:** A new worktree does not inherit `node_modules`. You must run `npm ci` at the root and `cd frontend && npm ci` before testing/building.
  - **Path Exclusion:** Tooling configs that glob the repo (like Vitest, ESLint) must exclude `.worktrees/**` to prevent duplicate workspace runs or dependency collisions.
  - **Commit Hooks:** `.pre-commit-config.yaml` uses file-based path scopes (`files:`) rather than generic `types_or:` to check only the affected workspace.
  - **Full check:** Run `npm run lint:all`/`typecheck:all`/`test:all` to check both workspaces in parallel.

## Conventions

- **ESM Throughout:** We use `"type": "module"`. Import specifiers must end with `.js` even when importing `.ts` source files (Node16 resolution).
- **Import Type:** Use `import type` for type-only imports (enforced by ESLint).
- **Conventional Commits:** All commit messages and PR titles must use conventional prefixes (`feat:`, `fix:`, `chore:`, etc.). Squash-merge uses the PR title for the `main` commit message; unprefixed PR titles block changelog generation.
- **Testing:** Tests live in `test/`, mirror `src/`, and use `app.inject()`.
  - **`NODE_ENV=test` guards:**
    - `test/setup.ts` isolates each test file with a temp SQLite DB and enforces `NODE_ENV=test`.
    - `frontend/vitest.config.ts` sets `test.env` to prevent leaked production environments from loading production React (which breaks `@testing-library/react` by omitting `act`).
    - `frontend/vite.config.ts` uses an inline check to prevent blanking Vite dev views with a `ReferenceError` due to missing Fast-Refresh preambles.
    - **Do not simplify or combine these three specific guards.**
- **Configuration:** Read config from `app.config` (defined in `src/plugins/env.ts`), never read `process.env` directly.
- **DB Migrations:** After editing `src/db/schema.ts`, run `npm run db:generate` and commit the migration files.
- **Secrets Management:** Real credentials must never be committed. `detect-secrets` scans code in pre-commit/CI against `.secrets.baseline`. Update it with:
  ```bash
  detect-secrets scan > .secrets.baseline
  ```
- **Pre-Commit Checks:** Before push, run the full verification gate:
  ```bash
  make lint && make typecheck && make test && make format-check
  ```
  _(Note: `format-check` is repo-wide and also covers `frontend/`, see the Commands table above)._
