# Audit reports

Every audit in this repo is one report in this folder. The report is committed; the
evidence is local. Structure, naming and rules: the `audit` skill
([`s3ntin3l8/ai-agent-skills`](https://github.com/s3ntin3l8/ai-agent-skills), `plugins/audit`).

## This repo

- **Scope token:** `frontend` (the React UI in `frontend/`).
- **Capture:** `node <audit skill>/scripts/capture.mjs <slug>` from the repo root, which
  starts an isolated demo (`make demo`) and reads [`capture.json`](capture.json).
  Captures go to `docs/audit/assets/<slug>/`, which is gitignored.
- **Capture limit:** the app is one workspace URL, so the script captures its landing
  state (the seeded shell), not views that need clicking through. For populated views use
  `make screenshots`, which drives the seeded sessions, or extend the capture script
  with interaction steps.

## Index

| Audit                                                  | Scope                                                                         | Outcome                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [2026-10-frontend-ui-ux.md](2026-10-frontend-ui-ux.md) | Frontend UI/UX: accessibility, interaction feedback, information architecture | 48 findings: 3 blockers, 17 major and 7 minor fixed (#1895, #1897, #1898); 21 deferred as issues |
