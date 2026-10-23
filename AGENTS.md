# AGENTS.md — Mullion

This file is the single source of truth for this repo's agent instructions.
`CLAUDE.md` is a one-line `@AGENTS.md` import, so every CLI Mullion hosts
(Claude Code, Codex, opencode, agy) reads this file, natively or via that
import. It has two halves with different owners:

- **The `mullion:briefing` region** is written by Mullion's project setup:
  the workflow conventions this Mullion install generates (branching,
  reviews, merging, cleanup), plus a pointer to this repo's skill and
  reviewer agent. The next setup apply replaces it wholesale — change the
  rules in Settings → Agent context & skills, not here.
- **Everything outside it** is about this repo itself: its layout, commands
  and invariants. Workflow rules do not belong there.

For deeper detail, see [`docs/architecture.md`](docs/architecture.md)
(plugins/routes/services tour), [`docs/ci-cd.md`](docs/ci-cd.md) (CI/CD
internals) and [`CONTRIBUTING.md`](CONTRIBUTING.md) (contributor workflow).
[`docs/agent-guide.md`](docs/agent-guide.md) is also auto-injected into your
context if you're running inside a Mullion-hosted session.

<!-- mullion:briefing:start -->

This repository uses [Mullion](https://github.com/s3ntin3l8/mullion-session-manager)
to run AI coding agents. A project-specific skill and reviewer subagent for
this repo live at `.claude/skills/mullion-review-invariants/SKILL.md` and
`.claude/agents/mullion-reviewer.md` — read the skill before making
changes, and use the reviewer subagent (or `/code-review`) before declaring a
change done.

## Workflow Conventions

Never commit directly to the default branch. Always branch and open a PR.

Branch off the latest remote default branch, never off your local one: `git fetch origin && git checkout -b <branch> origin/<default>`. A local default branch is routinely stale, which is what makes a PR show up as "out-of-date with the base branch" the moment it's opened.

Work in a dedicated worktree per branch, under `.wt/<branch>`, off the latest remote default branch: `git fetch origin && git worktree add .wt/<branch> -b <branch> origin/<default>`. A fresh worktree does not inherit installed dependencies — reinstall them there before testing or building.

Commit and PR titles need a Conventional Commits prefix (`feat:`, `fix:`, `chore:`, ...).

Squash-merge PRs — the PR title becomes the commit message on the default branch.

Require green CI before merging.

Run a self-review pass on your own diff before declaring done.

Request an automated/bot review through the review relay (`mullion review`, or the `request_review` tool) — once after opening the pull request, and once per head commit after pushing fixes, then wait for it. A review comment that mentions the review bot is for humans, not agents; if no relay is set up, tell the human instead. One review per pull request at a time: a review that is already running is not re-requested — the request is refused with its run id, and that refusal is the answer, not an error to retry: wait for it, or stop it with stop_review. A review takes 10-30 minutes; check review_status once instead of asking again. After pushing fixes, ask again only when no review is in flight. Never re-trigger a review with an @mention of the review bot: that path is for humans, and it queues another round behind the running one.

Fixing the code is not enough to address review feedback — reply to each inline comment via the GitHub API, then resolve the thread via the GraphQL `resolveReviewThread` mutation, rather than pushing a silent fix. Reply with `gh api repos/{owner}/{repo}/pulls/<pr>/comments/<comment_id>/replies -f body="…"`; resolve with `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_id>"}) { thread { isResolved } } }'`, taking the thread id from a `reviewThreads` query on the pull request, not from the REST comment id.

File a tracked issue for anything a plan defers, blocks, or descopes, and link it from the PR (using the repository's issue template if it has one) — a footnote in a plan doc is not a durable record.

After a merge, delete the local and remote branch and remove any associated worktree.

Before pushing, run the full lint/typecheck/test/format gate.

<!-- mullion:briefing:end -->

## Repo specifics

How this repo applies the conventions above — facts and commands, not rules.

- **Worktrees:** `make wt name=<slug>` creates `.wt/<slug>` off the latest
  `origin/main` and runs `npm ci` in the repo root **and** in `frontend/`. A
  worktree made by hand needs both `npm ci`s before it can build or test.
- **The pre-push gate** is what `.pre-commit-config.yaml` actually wires to
  the `pre-push` stage: `typecheck` (both workspaces, path-scoped), a
  repo-wide `prettier --check` (covers `frontend/` too), the two vitest
  suites (path-scoped, run as `test:coverage` so the coverage JSON is on
  disk), and the **≥75% patch-coverage check**
  (`npm run check:patch-coverage`). It is **not** `make lint` — lint is a
  **pre-commit** hook only, path-scoped to the workspace you touched. Run
  `make lint && make typecheck && make test && make format-check` yourself
  before pushing; the hooks do not run the repo-wide lint for you.
- **Patch test coverage (≥75%)** on changed lines in `src/` and
  `frontend/src/` is enforced locally by the pre-push hook
  (`scripts/check-patch-coverage-hook.mjs`, a thin wrapper over
  `scripts/check-patch-coverage.mjs`). In CI the same floor is **advisory**:
  Codecov posts a `codecov/patch` status on the PR, but it is not one of
  `main`'s required status checks, so a red patch status does not block a
  merge on its own.
- **Reviews:** this repo reviews every pull request automatically when it
  opens (`.github/workflows/hermes.yml`'s `auto-review` job), except Task
  Master's own `mullion/task-*` branches — see `docs/tasks-internals.md`'s
  "External review workflows". Asking through the relay after opening is
  still safe: it refuses a review that is already running or already landed.
- **Issues:** use the [Issue Blueprint](.github/ISSUE_TEMPLATE/issue-blueprint.md)
  format.
- **Codex:** an `AGENTS.override.md` would be read _instead of_ this file;
  `npm run check:scaffold-region-sync` (also a pre-commit hook) fails if one
  carries its own copy of the region.

## Core invariants

- **The non-obvious session model.** A session is a host PTY attached via
  `dtach`, running inside a transient `systemd --user` scope so it survives
  service redeploys/restarts. The `sessions` DB row records _intent_ (has
  this been explicitly killed?); live process state lives only in
  `PtyManager`'s in-memory map, and routes merge the two rather than trusting
  the DB column alone. Read this before touching `src/services/pty-manager.ts`
  or the terminal WS protocol. The scope's unit name
  (`crs-session-<instanceId>-<id>`, `session-process.ts`'s `scopeUnitName`)
  lives in a **Unix-user-global** systemd namespace, so it's namespaced by a
  per-Mullion-instance id (`deriveInstanceId`, a hash of `sessionsDir`) to
  keep two backends (or a test run) on one host from colliding on a low
  `sessions.id` (issue #1140). The unit name is **not** what identifies a
  session as this instance's own, though — ownership is always resolved by
  the scope's dtach socket path (`listOwnedScopes`/`resolveOwningUnit`),
  which is what lets a session created before an instance's own unit-naming
  scheme changed keep working unchanged. A test must never let a real
  `systemd-run` fire for this (mock `node:child_process`'s `spawn`, not just
  `node-pty` — issue #1137), and a teardown must never call
  `terminate()`/`stopScope()` on an id it didn't itself create.
- **Scope operations go through the `ScopeBackend` seam
  (`src/services/scope/`), not through systemd directly.** The systemd scope
  above is one _implementation_ of a platform-neutral seam ("run a detached
  long-lived process and track it"), added in issue #1715 so a non-Linux
  agent host becomes possible. `pty-manager.ts` launches, probes liveness,
  stops and inventories every scope through `getScopeBackend()`; it must not
  call `systemd-run`/`systemctl` itself. The backend is chosen **on the host
  that owns the scope**, from that host's own `process.platform` — never
  negotiated between hosts. `src/services/session-process.ts` remains the
  systemd implementation's home, and `src/services/device-process.ts` (the
  Android device scopes) is a second consumer of the same shape that has
  **not** been migrated yet.
- **`sessions.command` and `workspaces.layout` are opaque blobs.** The
  backend never parses a shell command line or a dockview layout — it just
  stores and replays what it's given. **The exception** is
  `src/services/hook-adapters/`: each adapter's own `commandTransform`
  (Claude Code's appends `--settings`/`--mcp-config`/`--plugin-dir`; Codex's
  and agy's append their own MCP/model flags the same way) inspects and
  rewrites the launch command at spawn time. The same is true of a narrow
  set of helpers that inspect `session.command` from outside the adapters
  themselves: `commandIsOpencode`/`commandModelCli` (`hook-adapters/index.ts`)
  and `buildModelFlag` (`hook-adapters/shared.ts`), plus `validateModel`/
  `validateCliModel` (`services/task-model-resolve.ts`) and
  `commandSupportsSeed` (`services/task-agent-resolve.ts`), and the pure
  adapter lookups in `hook-adapters/index.ts` — `getAdapterPromptFraming`
  (the one `sessions.prompt` uses to frame input for the child's agent
  family), `getAdapterEmits`, `getAdapterInitialPromptArgs`/
  `adapterHasInitialPromptArgs`, `getAdapterResumeSessionArgs`/
  `adapterHasResumeSessionArgs`, and `getAdapterDelegationHint` — used by
  callers like `task-claim.ts`, `task-reconciler.ts` and
  `routes/sessions.ts` to branch on a command's agent family, inject a model
  flag, or decide whether a real first-turn prompt can be delivered,
  rather than re-deriving that shape with their own ad-hoc parsing — and
  the seam they all go through, `applyHookAdapters` (the entry point that
  matches a command to its adapter and applies that adapter's transform;
  `launch-plan.ts` is its caller). Any `session.command` inspection
  outside these sanctioned adapter/helper call sites is the red flag, not a
  call into one of them.
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
  workspace, described in "Repo specifics" above.
- **Patch test coverage ($\ge 75\%$) and clean mergeability.** PR branches
  must cleanly rebase onto `origin/main` without merge conflicts. Any new or
  modified executable lines in `src/` or `frontend/src/` must meet $\ge 75\%$
  patch test coverage (`make test-patch-coverage`).
- **Security anti-patterns & CORS credentials.** Never enable
  `Access-Control-Allow-Credentials: true` with wildcard or reflected origins
  (`scripts/check-security-antipatterns.mjs`, enforced in `make lint`).

## Everyday commands

- `make dev` — backend (`tsx watch`) + frontend (Vite, HMR) together.
- `make test-backend` — backend tests only, the fast inner loop; `make test`
  runs both workspaces.
- `make test-patch-coverage` — verify $\ge 75\%$ patch test coverage on modified lines against `origin/main`.
- `make format` — fixes a failing `make format-check` in place (repo-wide,
  covers `frontend/` too).
- `npm run db:generate` — after any `src/db/schema.ts` edit.

## Secrets and security linters

Real credentials must never be committed. `detect-secrets` scans code in
pre-commit/CI against `.secrets.baseline`; regenerate it with
`detect-secrets scan > .secrets.baseline`. A `pragma: allowlist secret`
comment must stay on the **same line** as the flagged string — Prettier can
silently move it to its own line, which breaks the allowlist match.

In CI the scan covers the files the push touched plus the files the
previous baseline listed, not the whole tree (see `docs/ci-cd.md`). A known
secret is matched by filename, hash and type — not by line number — but the
baseline carries the line number as metadata and the hook refreshes it when
it rescans. So the baseline has to be refreshed in the same change when the
change **moves, adds or removes** a baselined secret: a moved or removed one
fails the build with "the baseline file was updated", an added one is
reported as a new secret. A change that leaves every baselined secret where
it was (appending a line below one, say) needs no refresh.

`scripts/check-security-antipatterns.mjs` enforces CORS security (e.g. no
`Access-Control-Allow-Credentials: true` with wildcard or reflected origins).
In the rare event intentional credentials reflection is needed, add
`// pragma: allowlist cors-credentials` on the same line to bypass the check.
