# Audit reports

Every audit in this repo is one report in this folder. The report is committed; the
evidence is local. Structure, naming and rules: the `audit` skill
([`s3ntin3l8/ai-agent-skills`](https://github.com/s3ntin3l8/ai-agent-skills), `plugins/audit`).

## This repo

- **Scope token:** `frontend` (the React UI in `frontend/`).
- **Capture:** from the repo root, with a checkout of
  [`ai-agent-skills`](https://github.com/s3ntin3l8/ai-agent-skills) (the `audit` plugin):

  ```bash
  node <path to ai-agent-skills>/plugins/audit/skills/audit/scripts/capture.mjs <slug>
  ```

  It starts an isolated demo (`make demo`) and reads [`capture.json`](capture.json), the
  repo's usual config. An audit whose routes or ports differ adds its own
  `capture.<slug>.json`, which the script prefers; that lookup is added by
  [ai-agent-skills#4](https://github.com/s3ntin3l8/ai-agent-skills/pull/4), so until it
  merges, pass `--config docs/audit/capture.<slug>.json` instead.
  Captures go to `docs/audit/assets/<slug>/`, which is gitignored. Record the
  `ai-agent-skills` commit you ran in the report's Evidence section, so the capture can be
  reproduced after the script changes.

- **Capture limit:** the app is one workspace URL, so the script captures its landing
  state (the seeded shell), not views that need clicking through. For populated views use
  `make screenshots`, which drives the seeded sessions, or extend the capture script
  with interaction steps.

## Index

| Audit                                                  | Scope                                                                         | Outcome                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [2026-10-frontend-ui-ux.md](2026-10-frontend-ui-ux.md) | Frontend UI/UX: accessibility, interaction feedback, information architecture | 48 findings: 3 blockers, 21 major and 10 minor fixed (#1895, #1897, #1898, #1923, #1926, #1927, #1930, #1933, #1934); 14 deferred as issues |
