## Summary

<!-- Describe what changed, why, and any context or subproblems. -->

### Changes made:

<!-- Numbered list of changes per file/component. E.g.,
1. **src/services/pty-manager.ts**: Added state persistence.
-->

### Key design decisions:

<!-- Rationale for non-obvious choices, e.g. filesystem over DB, synchronous vs async, etc. -->

## Test plan / Verification

- [ ] `make lint`
- [ ] `make typecheck`
- [ ] `make test`
- [ ] `make format-check` (repo-wide — also covers `frontend/`)
- [ ] Frontend changes: `cd frontend && npm run lint && npm run typecheck`, exercised manually in the browser
- [ ] Schema changes (`src/db/schema.ts`): ran `npm run db:generate` and committed the migration

<!-- Note on schema changes: if yes, make sure migration was generated and committed. -->

Closes #<!-- Issue Number -->

<!--
PR title must use a Conventional Commits prefix (feat:, fix:, chore:, docs:, ...).
This repo squash-merges PRs and Release Please parses the PR title, not the
individual commits — an unprefixed title silently drops from the changelog.

See CONTRIBUTING.md for the full pre-PR checklist and setup steps.
-->
