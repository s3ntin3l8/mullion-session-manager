# AGENTS.md — Mullion

This file is the single source of truth for this repo's agent instructions.
`CLAUDE.md` is a short `@AGENTS.md` import, so every CLI Mullion hosts
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

Work in a dedicated worktree per branch, under `.wt/<name>` (the branch name with `/` replaced by `-`, so the directory stays flat), off the latest remote default branch: `git fetch origin && git worktree add .wt/<name> -b <branch> origin/<default>`. A fresh worktree does not inherit installed dependencies — reinstall them there before testing or building.

Commit and PR titles need a Conventional Commits prefix (`feat:`, `fix:`, `chore:`, ...).

Squash-merge PRs — the PR title becomes the commit message on the default branch.

Require green CI before merging.

Run a self-review pass on your own diff before declaring done.

Request an automated/bot review through the review relay (`mullion review`, or the `request_review` tool) — once after opening the pull request, and again per head commit after pushing fixes for a changes-requested review, then wait for it. A review comment that mentions the review bot is for humans, not agents; if no relay is set up, tell the human instead. One review per pull request at a time: a review that is already running is not re-requested — the request is refused with its run id, and that refusal is the answer, not an error to retry: wait for it, or stop it with stop_review. A review takes 10-30 minutes; check review_status once instead of asking again. After pushing fixes for a changes-requested review, ask again only when no review is in flight. Once the review bot has approved, apply its remaining suggestions and push without requesting another review, even though the head moved: small targeted fixes do not change the verdict, and re-reviewing them only breeds more nits. Never re-trigger a review with an @mention of the review bot: that path is for humans, and it queues another round behind the running one.

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
- **This clone is shared, so its automatic gc is off** (`gc.auto 0`, set by
  `make git-safe`, which `make wt` runs). A background `git gc` can delete a
  loose object that a concurrent push is creating, and the failure surfaces far
  from the cause, as a commit naming a _missing_ object
  ([#1836](https://github.com/s3ntin3l8/mullion-session-manager/issues/1836)).
  Run `git gc` deliberately, when no agent is pushing; `make git-doctor` reports
  the damage and `make git-doctor APPLY=1` repairs it.
- **The gate: run `make lint`, then push.** Lint is a pre-commit hook only
  (path-scoped to the workspace you touched), so the pre-push hook does not
  cover it; the hook runs the rest: a path-scoped typecheck, a repo-wide
  `prettier --check`, the two vitest suites (as `test:coverage`, so the
  patch-coverage check can reuse the JSON) and the **≥75% patch-coverage
  check** on changed lines in `src/` and `frontend/src/`
  (`npm run check:patch-coverage`, or `make test-patch-coverage`). Do not run
  `make test` first: it is the same suite, so you would run it twice (10-30
  minutes on a loaded host). The suites are path-scoped per workspace, so the
  one you did not touch is not run locally; say so, or run it, for parity with
  CI. Pushes from different worktrees queue on a repo-wide lock
  (`scripts/with-gate-lock.sh`; `MULLION_NO_GATE_LOCK=1` bypasses it,
  `MULLION_GATE_LOCK_TIMEOUT` bounds the wait): let a waiting push wait. In CI
  the patch-coverage floor is advisory (`codecov/patch` is not a required
  check). The region above asks for the full gate; this is how **this** repo
  satisfies it. Details: the pre-push section of [`docs/ci-cd.md`](docs/ci-cd.md).
- **Reviews:** this repo reviews every pull request automatically when it
  opens (`.github/workflows/hermes.yml`'s `auto-review` job), except Task
  Master's own `mullion/task-*` branches — see `docs/tasks-internals.md`'s
  "External review workflows". Asking through the relay after opening is still
  safe: it refuses a review that is already running or already landed.
- **PRs need not be up to date with `main`** (`strict: false`): a behind PR
  merges without a rebase, and the required checks re-run on the push to
  `main`. If CI is red on something your diff doesn't touch, check `main`'s
  latest push run first ([`docs/ci-cd.md`](docs/ci-cd.md)).
- **Issues:** use the [Issue Blueprint](.github/ISSUE_TEMPLATE/issue-blueprint.md)
  format and title them `type(scope): summary` with a Conventional Commits type
  only (a decision is `docs(scope): decide …`, a bug investigation
  `fix(scope): investigate …`; never `design:`/`decide:`/`idea:`/`investigate:`).
  Scopes are a fixed vocabulary: `sessions`, `tasks`, `uiux`, `github`, `dock`,
  `previews`, `projects`, `worktrees`, `storage`, `files`, `git`, `settings`,
  `hooks`, `opencode`, `windows`, `macos`, `hosts`, `devices`, `browser`,
  `terminal`, `mobile`, `voice`, `review-relay`, `skills`, `deps`, `deploy`,
  `scaffold`. Older history also uses `ui`, `review` and `agents`: write those
  as `uiux`, `review-relay` and `hooks`. CI-only work is a bare `ci:`. Attach
  every new issue as a sub-issue to the open epic that fits
  (`gh issue list --label epic --state open`) and set `blocked_by` where one
  issue gates another; the `taskmaster-issues` skill has the commands.
- **Spikes must be fully isolated from the host's real agent state.** A probe
  that points an agent CLI at a copy or symlink farm of its real data directory
  can fence the live runtime and abort the user's other sessions (observed with
  mcode: a second runtime on a _shared_ `runtime-state.sqlite` made the
  incumbent's `Turn controller shutdown {reason:"runtime-shutdown"}` fire,
  aborting sibling sessions seconds later). Use a fully isolated data dir with no symlink to the
  real one (a plain `cp -a` copy is fine, with its own physical `v2/sqlite`),
  never start a runtime against shared sqlite/lease state, and prefer an
  agent's documented surfaces (`--help`, its own source) over launching it.
- **Codex:** an `AGENTS.override.md` would be read _instead of_ this file;
  `npm run check:scaffold-region-sync` (also a pre-commit hook) fails if one
  carries its own copy of the region.

## Core invariants

- **The non-obvious session model.** A session is a host PTY attached via
  `dtach`, running inside a transient `systemd --user` scope so it survives
  service redeploys. The `sessions` DB row records _intent_ (explicitly
  killed?); live process state lives only in `PtyManager`'s in-memory map, and
  routes merge the two rather than trusting the DB column alone. Read this
  before touching `src/services/pty-manager.ts` or the terminal WS protocol. The
  scope unit (`crs-session-<instanceId>-<id>`) lives in a Unix-user-global
  systemd namespace, so it is namespaced by a per-instance id (`deriveInstanceId`,
  #1140); ownership is resolved by the scope's dtach socket path
  (`listOwnedScopes`/`resolveOwningUnit`), not by the unit name. A test must
  never let a real `systemd-run` fire (mock `node:child_process`'s `spawn`, not
  just `node-pty`, #1137), and a teardown must never `terminate()`/`stopScope()`
  an id it didn't create; `test/global-setup.ts` enforces the first half
  suite-wide (#2003: a `systemd-run` shim leads `PATH`, and the run fails if it
  was hit or a `crs-session-*` scope is left behind).
- **Scope operations go through the `ScopeBackend` seam
  (`src/services/scope/`), not through systemd directly** (#1715, so a non-Linux
  agent host becomes possible). `pty-manager.ts` launches, probes, stops and
  inventories scopes through `getScopeBackend()` and must not call
  `systemd-run`/`systemctl` itself; the backend is chosen on the host that owns
  the scope, from its own `process.platform`. `src/services/session-process.ts`
  is the systemd implementation's home; `device-manager.ts` is a second consumer
  through `getDeviceScopeBackend` (#1854), and the two are deliberately separate
  classes — a session's identity is its dtach socket, an emulator's its marker
  file.
- **`sessions.command` and `workspaces.layout` are opaque blobs.** The backend
  never parses a shell command line or a dockview layout; it stores and replays
  what it is given. The exception is `src/services/hook-adapters/` (each
  adapter's `commandTransform` rewrites the launch command at spawn time, via
  `applyHookAdapters`, which `launch-plan.ts` calls) and a narrow set of
  sanctioned helpers — listed in the `mullion-review-invariants` skill, "The
  opaque-blob invariant". Any other inspection of `session.command` is the red
  flag, not a call into one of them.
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
- **PR branches must cleanly rebase onto `origin/main`** without merge
  conflicts.
- **Security anti-patterns & CORS credentials.** Never enable
  `Access-Control-Allow-Credentials: true` with wildcard or reflected origins
  (`scripts/check-security-antipatterns.mjs`, enforced in `make lint`); in the
  rare intentional case add `// pragma: allowlist cors-credentials` on the same
  line.

## Everyday commands

- `make dev` — backend (`tsx watch`) + frontend (Vite, HMR) together.
- `make test-backend` — backend tests only, the fast inner loop; `make test`
  runs both workspaces.
- `make test-patch-coverage` — verify $\ge 75\%$ patch test coverage on modified lines against `origin/main`.
- `make format` — fixes a failing `make format-check` in place (repo-wide,
  covers `frontend/` too).
- `npm run db:generate` — after any `src/db/schema.ts` edit.
- `node scripts/review-references.mjs` — lists the per-area review references
  (`.claude/skills/mullion-review-invariants/references/`) that match the
  diff's changed files; read what it prints before reviewing or changing those
  areas.

## Secrets

Real credentials must never be committed. `detect-secrets` scans code in
pre-commit/CI against `.secrets.baseline`; regenerate it with
`detect-secrets scan > .secrets.baseline`. A `pragma: allowlist secret` comment
must stay on the **same line** as the flagged string — Prettier can silently
move it to its own line, which breaks the allowlist match. A known secret is
matched by filename, hash and type, not by line number, but the baseline carries
the line number and the hook refreshes it: refresh the baseline in the same
change when it **moves, adds or removes** a baselined secret (a moved or removed
one fails with "the baseline file was updated", an added one is reported as new);
appending below one needs nothing. CI scans the files the push touched plus the
ones the previous baseline listed, not the whole tree (`docs/ci-cd.md`).
