# Audit reports

Every audit in this repo is one report in this folder. The report is committed; the
evidence is local. Structure, naming and rules: the `audit` skill
([`s3ntin3l8/ai-agent-skills`](https://github.com/s3ntin3l8/ai-agent-skills), `plugins/audit`).

## This repo

- **Scope tokens:** `backend` (the Fastify backend in `src/`) and `frontend`
  (the React UI in `frontend/src/`). A report's slug is
  `YYYY-MM-<scope>-<topic>`, so the same topic can be audited per surface.
- **Code-health audits need no capture.** They are static: the evidence is a
  committed command (`node scripts/audit-loc.mjs`), not a screenshot run.
- **Capture:** from the repo root (needs Docker):

  ```bash
  make screenshots-audit AUDIT=<slug>
  ```

  It runs [visual-kit](https://github.com/s3ntin3l8/visual-kit) against an isolated demo and
  renders every scene tagged `audit` in [`visual/scenes.json`](../../visual/scenes.json), in
  both themes, into `docs/audit/assets/<slug>/` (gitignored): one PNG per shot plus
  `metrics.json` with axe violations, overflow and cut-off controls. A view that needs a click
  to reach is a scene with `steps`. Record the visual-kit version from `visual/Dockerfile` in
  the report's Evidence section, so the capture can be reproduced after the image moves.

- **Older reports** (2026-10) were captured with the `ai-agent-skills` capture script and
  [`capture.json`](capture.json); their Evidence sections name that command.

## Index

| Audit                                                              | Scope                                                                                          | Outcome                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [2026-10-backend-code-health.md](2026-10-backend-code-health.md)   | Backend code health: module size, layering, duplication, dead code                             | 13 findings, all deferred as issues (#2399, #2400, #2401, #2402, #2403, #2404, #2405, #2413, #2414, #2415, #2416, #2417, #2418); one guardrail landed (`scripts/check-max-file-lines.mjs`)                         |
| [2026-10-frontend-code-health.md](2026-10-frontend-code-health.md) | Frontend code health: component size, duplication, dead code                                   | 9 findings, all deferred as issues (#2406, #2407, #2408, #2409, #2410, #2411, #2412, #2414, #2415); one guardrail landed (`scripts/check-max-file-lines.mjs`)                                                      |
| [2026-10-frontend-ui-ux.md](2026-10-frontend-ui-ux.md)             | Frontend UI/UX: accessibility, interaction feedback, information architecture                  | 48 findings: 3 blockers, 21 major and 14 minor fixed (#1895, #1897, #1898, #1923, #1926, #1927, #1930, #1933, #1934, #1935, #1938, #1957); 10 deferred as issues                                                   |
| [2026-11-frontend-ui-ux.md](2026-11-frontend-ui-ux.md)             | Frontend UI/UX on phone and tablet: layout, touch behaviour and usability of the compact tiers | 9 findings (1 P1, 6 P2, 2 P3): the P1 fixed in #2986, the rest deferred as issues (#2974, #2975, #2976, #2977, #2978, #2979, #2980; #2886 already tracked); audit-only tablet scenes added to `visual/scenes.json` |
