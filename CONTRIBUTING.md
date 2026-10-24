# Contributing

## Setup

```bash
make install          # backend deps
make install-hooks    # pre-commit + pre-push git hooks (see below — do this before your first commit)
cd frontend && npm ci
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
- **The clone's automatic gc is off** (`gc.auto 0`), because this clone is
  shared by several agents that push concurrently and a background `git gc`
  can destroy an object a concurrent write is creating
  ([#1836](https://github.com/s3ntin3l8/mullion-session-manager/issues/1836)).
  `make wt` sets it for you; `make git-safe` does it on demand and is safe to
  re-run. Loose objects then accumulate, so run `git gc` deliberately, when no
  agent is pushing.
  If the damage ever happens — a commit that will not complete, with an error
  naming a _missing_ object — `make git-doctor` reports it, and
  `make git-doctor APPLY=1` repairs it: the zero-byte objects are **moved**
  (never deleted) into a quarantine inside `.git/`, the refs are restored from
  the remote, and the affected worktree indexes are rebuilt. The rebuild
  restores exactly the paths that were staged, so an unrelated untracked file
  is never adopted — but it re-stages them from the working tree, so it
  refuses to run when the index holds content that is _not_ in the working
  tree (a partially staged file), because re-staging that would discard what
  you staged. `FORCE=1` overrides that refusal. The exit code says what
  happened: **0** the clone is whole, **1** it is still not whole, **2** it is
  whole again but some objects could not be recovered (they were never
  committed and are not on the remote, so nothing references them any more).
  So `make git-doctor APPLY=1` is usable as a health check.

## Demo instance and screenshots

`make demo` starts a throwaway Mullion (backend and Vite frontend) seeded with
demo projects, sessions and tasks, and prints its URL. Ctrl-C stops its
sessions and deletes everything it created. `make screenshots` uses the same
instance to regenerate `frontend/public/screenshots/` (referenced by the README
and `frontend/public/site.webmanifest`), and `make screenshots-landing OUT=<dir>`
writes 2x landing-page stills plus a short terminal loop (the loop needs
`ffmpeg`).

It is safe to run on a host that also runs a real Mullion, including from inside
one of its sessions. `scripts/demo/env.mjs` enforces that, and
`test/scripts/demo-env.test.ts` covers it:

- Every demo process gets a clean environment. Only `PATH`, locale, `SHELL` and
  the systemd user-bus variables are inherited, so no `MULLION_*` from the
  hosting session gets through.
- All state lives in one `mktemp` directory: the database, `SESSIONS_DIR`,
  `CRS_CONFIG_DIR`, `HOME` and the demo projects.
- The backend runs from a scratch directory without a `.env`.
- The demo uses dedicated loopback ports that must be free.
- `docker` is shadowed, so the Dock never probes real compose stacks.
- Demo sessions run as `crs-session-<instanceId>-*` scopes, namespaced by the
  scratch `SESSIONS_DIR`; teardown stops exactly those.

## Before opening a PR

`make install-hooks` wires up local git hooks that catch most of this
automatically — `pre-commit` runs lint/typecheck (scoped to whichever
workspace you touched) and `pre-push` additionally runs the full test suite
(both workspaces, with coverage enabled so the patch-coverage check can
reuse it), a **repo-wide** `prettier --check` (covers `frontend/` too, not
just the backend) and the **≥75% patch-coverage check**. Lint itself is a
**pre-commit** hook only, and it is path-scoped — the hooks do not run the
repo-wide lint for you. Run the same checks manually before opening a PR —
`make lint`/`typecheck`/`test` already cover both workspaces; use
`make test-backend` if you just want the backend-only fast
loop:

```bash
make lint && make typecheck && make test && make format-check
```

If `make format-check` fails, `make format` applies the fix in place.

Any new or modified executable line in `src/` or `frontend/src/` must also
meet **≥75% patch test coverage** against `origin/main`. The `pre-push` hook
runs this check for you (`npm run check:patch-coverage`); `make
test-patch-coverage` runs the same thing by hand. On the PR, Codecov reports
the same floor as the advisory `codecov/patch` status — it is **not** one of
`main`'s required status checks, so it shows you the number but does not
block the merge on its own. `make test-patch-coverage`'s istanbul
instrumentation only covers
`src/`/`frontend/src/`, so a shell-only change under `deploy/`/`scripts/`
reports "no source changes" regardless of how much `.sh` logic changed —
that's expected, not a gap to work around. Those scripts still get
regression coverage via `test/scripts/*.test.ts` (see
[`docs/ci-cd.md`](docs/ci-cd.md)), which runs a real script via `execFile`
against real temp directories, with the network and the host's real
`systemd --user` manager PATH-shimmed out. Any new test in that style must
stay sandboxed the same way: never let a real `systemctl`/`systemd-run`/
network call fire, and redirect `$HOME` if the script under test writes
anywhere under it.

If you changed `src/db/schema.ts`, also run `npm run db:generate` and commit
the generated migration under `drizzle/`.

### A long `TMPDIR` breaks socket tests, and it is not a code bug

A `sockaddr_un` socket path is capped at **108 bytes on Linux and 104 on
macOS**, and that cap includes the NUL terminator, so the usable path is one
byte shorter. A Mullion-hosted session exports a long `TMPDIR`
(`.../sessions/<id>.tmp/...`), which is long enough to eat most of that
budget on its own.

The suite defends against this by putting its own temp root somewhere short
(`test/helpers/suite-tmpdir.ts`): it uses `os.tmpdir()` when the projected
path fits the budget and falls back to `/tmp` when it does not. The budget is
derived from the platform limit, which lives in ONE place —
`src/cli/sun-path.mjs` — and is read by the backend's own guard
(`src/plugins/pty.ts`), the demo script (`scripts/demo/env.mjs`) and the
suite's temp-dir helper alike. The off-by-one for the NUL terminator lives
there too, so it cannot be got wrong at a call site.

So a `listen()` failure with a bare `EINVAL`, or a test that hangs until its
timeout, in a run whose `TMPDIR` is long, is this — not the code under test.
Two symptoms worth recognising:

- `EADDRINUSE`/`EADDRNOTAVAIL` on a socket path that "cannot possibly" be
  too long, and
- a test failing only in a session, and passing in a plain checkout.

If you hit either, check `echo $TMPDIR` first. To run the suite with a short
temp root by hand, `TMPDIR=/tmp npm test`. The same rule applies to a
Mullion-hosted session's own sockets: the backend relocates a too-long
`sessionsDir` to a short fallback and logs which path it moved to, so read
the log line rather than assuming the configured path is in use.

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

`main` requires a PR (no direct pushes, no admin bypass) — and these status
checks: `test-node / lint-and-test`, `test-node / test-merge`,
`test-frontend / lint-and-test`, `test-frontend / test-merge`, and CodeQL's
`analyze / Analyze (javascript-typescript)` — plus every review conversation
resolved. Each of those status checks (lint, typecheck, test, format-check)
maps directly to what the check runs, so a clean local run should mean a
clean CI run. An open review thread blocks the merge even when every check
is green; `node scripts/review-threads.mjs list <pr>` lists them (see
"Addressing review feedback" below).

Both workspaces shard their test run, so the real tests (and the
`coverage-fail-under` check) live in the two `test-merge` jobs; the
matching `lint-and-test` jobs keep running lint/typecheck/build and report
green whether or not any test ran. **Both `test-merge` contexts are
required for that reason** — drop one and a broken suite merges silently.

## Automated review

PRs opened from a fork won't get GitHub Actions secrets (a GitHub security
boundary, not a bug), so the automated Hermes review that normally runs on
`opened` won't complete for fork PRs — a maintainer can still trigger it
manually by commenting `@s3ntin3l8-hermes Review` on the PR, which runs in
the base repo's context.

## Addressing review feedback, and post-merge cleanup

See the "Workflow Conventions" section of [`AGENTS.md`](AGENTS.md) — the
reply-and-resolve two-step for inline PR comments, and the branch/worktree
cleanup after a merge. `scripts/review-threads.mjs` runs the two-step for you.
