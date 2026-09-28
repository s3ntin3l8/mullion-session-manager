# CI/CD

Workflows are **callers** of `s3ntin3l8/.github/.github/workflows/*.yml@main`
— all pinned to `@main` except `dependency-review.yml`, which pins the
reusable workflow to a specific commit SHA instead
(`@8c62b6d0671313b8b975882f0a6d871673b6def8 # main @ 2026-09-10`, a trailing
comment recording which date's `main` that SHA corresponds to) rather than
floating on `@main` like every other caller here:

- `ci-cd.yml` (test-node + test-frontend + test-e2e — no Docker image is built)
- `codeql.yml`, `dependency-review.yml`, `release-please.yml`
- **Exceptions (custom multi-step jobs, no upstream reusable workflow exists):**
  `build-tarball` in `release-please.yml`, which assembles/uploads the
  versioned-release tarball; and `test-e2e` in `ci-cd.yml`, which needs to
  `npx playwright install` a real Chromium (and install a pinned, integrity-
  checked `opencode` binary — see "test-e2e" below) before its test step —
  something `ci-node.yml` has no hook for.
- **`claude.yml` and `hermes.yml`** are two more callers, not exceptions —
  both invoke `s3ntin3l8/.github`'s own reusable workflows
  (`claude-code.yml`/`hermes-review.yml`) rather than running custom steps.
  `claude.yml` wires up `@claude`-mention-triggered Claude Code runs on
  issues/PRs (issue comments, PR review comments, PR reviews, and newly-
  opened/assigned issues). `hermes.yml` wires up the s3ntin3l8-hermes
  review bot two ways — `auto-review` (once per PR, on `opened` for a
  non-draft PR or `ready_for_review` for one that started as a draft) and
  `on-demand-review` (`@s3ntin3l8-hermes Review`/`Triage`, restricted to
  `MEMBER`/`OWNER`/`COLLABORATOR` commenters). **`auto-review` excludes
  `mullion/task-*` branches** (`!startsWith(github.event.pull_request.head.ref,
'mullion/task-')`) — Task Master's own closed branch namespace, whose PRs
  already get a terminal review from Task Master's own review agent; see
  [`tasks-internals.md`](tasks-internals.md#external-review-workflows) for
  why. `on-demand-review` is **not** excluded — a human can still
  explicitly ask Hermes for a second opinion on a Task Master PR. Both jobs
  also guard against a fork PR running arbitrary workflow-file content on
  this repo's self-hosted runner (`head.repo.full_name == github.repository`
  for the `pull_request`-triggered path; `issue_comment` always runs the
  default branch's own copy of the file regardless).

## Reusable workflows rule

- **Permissions block:** Callers invoking reusable workflows needing write
  scopes **must declare a `permissions:` block**. The default `GITHUB_TOKEN`
  is read-only; missing permissions fail at startup with zero jobs.
- The caller's grant must cover **every** scope of the reusable workflow:
  - `codeql` needs `security-events: write`
  - `release-please` needs `contents: write` + `pull-requests: write`
  - `build-tarball` needs `contents: write` (to upload gh release assets)

## `ci-cd.yml` structure

Both `test-node` and `test-frontend` run on Node **26** (`node-version:
"26"`) and pass `strict-checks: true` to the reusable `ci-node.yml`
workflow — this makes its `detect-secrets` step (see "Secrets detection"
below) a hard job failure on a finding rather than the upstream workflow's
own default of `continue-on-error` (advisory-only, since a repo whose
baseline predates auditing would otherwise go instantly red as a hard
gate). This repo's own `.secrets.baseline` is verified clean, so
`strict-checks: true` is safe here.

- **`test-node` (backend)**: Runs at root. Script: `test:coverage`,
  `coverage-fail-under: 80`. Runs `npm ci`, lint, typecheck, format-check, and
  tests.
- **Shell scripts under `deploy/`/`scripts/` get coverage here too** — this
  is the same `vitest run` invocation, and `vitest.config.ts` has no
  `include` override, so its default glob already sweeps up
  `test/scripts/*.test.ts` alongside every other backend test file (verified
  against a real CI run: `test/scripts/self-update.test.ts` shows up in a
  `test-node / test-shard` job's own log). `test/scripts/install.test.ts`
  (issue #1469) and `test/scripts/self-update.test.ts` (issue #647) both
  exercise a **real** shell script via `execFile`, with PATH-shimmed
  `curl`/`npm`/`npx`/`systemctl`/`systemd-run` so the suite never reaches
  the network or a real `systemd --user` manager — `deploy/install.sh`'s own
  test additionally redirects `$HOME` to a fresh temp dir, since that
  script's systemd-unit and CLI-symlink writes are bash tilde-expansions of
  `$HOME`, independent of the `<mullion-home>` argument it's given. Any
  future test that shells out to a real script under `deploy/`/`scripts/`
  must follow the same sandboxing shape — never let a real `systemctl`/
  `systemd-run`/network call fire, and never let `$HOME` resolve to the
  machine's real home directory.
- **`test-frontend`**: Runs under `frontend/`. Script: `test:coverage`,
  `coverage-fail-under: 70`. Skips format-check in CI (root-level
  `make format-check` hook covers it).
- **`test-e2e`**: Custom job — checkout, `npm ci`,
  `npx playwright install --with-deps chromium`, then installs a **pinned,
  integrity-checked `opencode` binary** (currently `1.18.26`) via a
  dedicated `test/e2e/opencode/` workspace with its own `package-lock.json`
  — `npm ci` there enforces the lockfile's integrity hash, so a registry
  republish of that version tag with different content fails loudly instead
  of silently installing a tampered binary — and prepends it to `PATH`
  before `npm run test:e2e`. The pin exists because
  `test/e2e/opencode-permission-merge.e2e.test.ts` asserts a specific,
  empirically-verified opencode behavior — its `permission` config key
  deep-merges per top-level key with the user's own config, rather than
  shallow-replacing it — that a future opencode release could silently
  change; bumping the pin means re-verifying that behavior and regenerating
  the lockfile. See `test/e2e/README.md`.
  Deliberately **not** a required status check yet — this is its first run
  anywhere outside a developer's own machine, and it needs a stretch of
  real, unattended CI runs before every merge is gated on it.
- **Codecov**: Uploads coverage using `CODECOV_TOKEN`. Target patch coverage
  is 75% (configured via `codecov.yml` to prevent failures on minor,
  well-tested diffs).
- **Test sharding (`test-shards: "2"`)**:
  - Node tests shard into `shard-plan` → 2×`test-shard` → `test-merge`.
  - `test-node / lint-and-test` runs lint/typecheck/format/build but **no
    tests**.
  - `test-merge` is the final test/coverage check; it must be a **required
    check** in branch protection.
  - Requires istanbul `json` reporter format alongside `json-summary` —
    set once, in the shared `vitest.shared.ts` coverage config both
    `vitest.config.ts` and `frontend/vitest.config.ts` import, not
    duplicated per workspace — to merge shard results.
- **Secrets detection**: `ci-node.yml`'s `detect-secrets` step is
  pip-cache-warmed to avoid uncached overhead.

## Branch protection

Required status checks for merge:

- `test-node / lint-and-test`
- `test-node / test-merge` (sharded coverage gate)
- `test-frontend / lint-and-test`
- `analyze / Analyze (javascript-typescript)` (CodeQL is mandatory)

Verify the current contexts via:

```bash
gh api repos/s3ntin3l8/mullion-session-manager/branches/main/protection --jq '.required_status_checks.contexts'
```

**Issue #1360 — this same lookup is a silent no-op for Task Master's own
CI-auto-return (`#755`, `attemptReturnRedCiToWorker`) on every install,
with no operator-side fix.** That feature needs to read exactly this
endpoint (`fetchRequiredStatusContexts`, `src/services/github.ts`) to tell
a red _required_ check apart from a red _non-required_ one (this repo's own
`test-e2e` above is a real example) — but the endpoint requires the
`administration` permission, and the token Mullion mints for this lookup
never requests it: `mintInstallationToken` (`src/services/github-app.ts`)
sends only `READ_PERMISSIONS` (`actions`/`metadata`/`pull_requests`) in the
token-exchange request body, deliberately, to avoid unrequested scope creep
for one feature. **For GitHub App installation tokens, granting the App
installation broader permissions on GitHub's own side does nothing here**
— an installation token can only ever carry what's both granted AND
explicitly requested at mint time, and `administration` is never
requested. Closing this gap needs a Mullion code change (widening
`READ_PERMISSIONS` for this scope, or a new dedicated scope), which is an
open decision, not something this repo has done. **For PAT-backed installs
(no App configured), the situation is different** — a scope-starved PAT
403s this endpoint too, and that case IS fixable in the GitHub UI: a
classic PAT needs the `repo` scope to read branch protection on a private
repository (GitHub's own documented requirement for this endpoint;
verified empirically against this repo's own `repo`-scoped token — a
public repo, so this doesn't itself prove the private-repo case, but
`admin:repo_hook` was NOT among that token's granted scopes and the call
still succeeded, which is inconsistent with `admin:repo_hook` being a
requirement here). `admin:repo_hook` is a **different** scope this repo
also uses, for **webhook registration** specifically (see
[`github-integration.md`](github-integration.md#webhook-delivery) and its
[Troubleshooting webhooks](github-integration.md#troubleshooting-webhooks)
section) — not for reading branch protection; widening a PAT's scope to
fix this 403 only needs `repo`. Without resolving the underlying
permission issue, a required check can sit red on a `clean`-verdict task's
PR indefinitely with no automatic return-to-worker and (as of #1360) one
throttled warning in the reconcile log — a human still has to notice and
act. The command above returning a 403 (rather than the contexts list, or a
404 for "no protection configured") is the same signal Mullion's own code
sees.
