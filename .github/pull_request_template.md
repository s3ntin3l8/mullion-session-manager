## Summary

<!-- What changed and why. -->

## Test plan

- [ ] `make lint`
- [ ] `make typecheck`
- [ ] `make test`
- [ ] `make format-check` (repo-wide — also covers `frontend/`)
- [ ] Frontend changes: `cd frontend && npm run lint && npm run typecheck`, exercised manually in the browser
- [ ] Schema changes (`src/db/schema.ts`): ran `npm run db:generate` and committed the migration

<!--
PR title must use a Conventional Commits prefix (feat:, fix:, chore:, docs:, ...).
This repo squash-merges PRs and Release Please parses the PR title, not the
individual commits — an unprefixed title silently drops from the changelog.

See CONTRIBUTING.md for the full pre-PR checklist and setup steps.
-->
