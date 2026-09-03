# CI/CD

Workflows are **callers** of `s3ntin3l8/.github/.github/workflows/*.yml@main`:

- `ci-cd.yml` (test-node + test-frontend + test-e2e — no Docker image is built)
- `codeql.yml`, `dependency-review.yml`, `release-please.yml`
- **Exceptions (custom multi-step jobs, no upstream reusable workflow exists):**
  `build-tarball` in `release-please.yml`, which assembles/uploads the
  versioned-release tarball; and `test-e2e` in `ci-cd.yml`, which needs to
  `npx playwright install` a real Chromium before its test step — something
  `ci-node.yml` has no hook for.

## Reusable workflows rule

- **Permissions block:** Callers invoking reusable workflows needing write
  scopes **must declare a `permissions:` block**. The default `GITHUB_TOKEN`
  is read-only; missing permissions fail at startup with zero jobs.
- The caller's grant must cover **every** scope of the reusable workflow:
  - `codeql` needs `security-events: write`
  - `release-please` needs `contents: write` + `pull-requests: write`
  - `build-tarball` needs `contents: write` (to upload gh release assets)

## `ci-cd.yml` structure

- **`test-node` (backend)**: Runs at root. Script: `test:coverage`,
  `coverage-fail-under: 80`. Runs `npm ci`, lint, typecheck, format-check, and
  tests.
- **`test-frontend`**: Runs under `frontend/`. Script: `test:coverage`,
  `coverage-fail-under: 70`. Skips format-check in CI (root-level
  `make format-check` hook covers it).
- **`test-e2e`**: Custom job — checkout, `npm ci`,
  `npx playwright install --with-deps chromium`, `npm run test:e2e`.
  Deliberately **not** a required status check yet; see `test/e2e/README.md`.
- **Codecov**: Uploads coverage using `CODECOV_TOKEN`. Target patch coverage
  is 75% (configured via `codecov.yml` to prevent failures on minor,
  well-tested diffs).
- **Test sharding (`test-shards: "2"`)**:
  - Node tests shard into `shard-plan` → 2×`test-shard` → `test-merge`.
  - `test-node / lint-and-test` runs lint/typecheck/format/build but **no
    tests**.
  - `test-merge` is the final test/coverage check; it must be a **required
    check** in branch protection.
  - Requires istanbul `json` reporter format alongside `json-summary` (set in
    `vitest.config.ts`) to merge shard results.
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
