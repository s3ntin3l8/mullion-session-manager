# Settings and schema threading

Read this when a diff adds or changes a per-project column, a setting, a default or bound, or an environment key. Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. A new per-project field must be threaded through every layer

**Invariant.** A nullable per-project column in the `injectAgentGuide` / `autoTagRelease` family is live only when every layer carries it: the column in `src/db/schema.ts` plus its migration, the `UpdateProjectBody` interface and the `updateProjectSchema` entry in `src/routes/projects.ts`, the destructure in the PATCH handler, the "at least one of ..." empty-body guard (including the error string that lists the fields), and the conditional spread into `.set()`. On the client the field must also reach the project type, both of the `Pick` unions that list the patchable fields (`frontend/src/api/projects.ts` and `frontend/src/store/types.ts`), the modal or sidebar control, and the project test fixtures.

**Breaks.** The toggle compiles and renders, but the PATCH silently drops the value because one `Pick` omits it. A flag-only body falls through the guard into a 500. Fixtures stop typechecking.

**Check.** Take the field name and grep it across `src/db/schema.ts`, `src/routes/projects.ts`, `frontend/src/api/projects.ts`, `frontend/src/store/types.ts` and `frontend/src/api/types.ts`; every file must appear, and the two `Pick` unions must list the same members. Confirm a new migration sits under `drizzle/`.

## 2. Resolve a per-project setting once on the primary; consumers read the Session

**Invariant.** An override of the form `project.X ?? settings.sessions.X` is resolved once on the primary, carried through the spawn options, and echoed back in the spawn result (`src/routes/internal-schemas.ts` request and response, and the response in `src/routes/internal.ts`). Downstream consumers read the value off the live session, as `src/plugins/hooks.ts` does with `session?.injectAgentGuide`. Agent-role processes have no database, so any `getStoredSettings(app.db)` read outside the primary path needs an `app.db` guard with a `DEFAULT_SETTINGS` fallback, as in `src/plugins/pty.ts`.

**Breaks.** On a database-less agent host the setting silently evaluates to the default whatever the operator configured. Reading settings late (at hook time instead of spawn time) lets a mid-session toggle retroactively change sessions already running.

**Check.** Flag any new `getStoredSettings` or `DEFAULT_SETTINGS` read in `src/plugins/hooks.ts`, `src/plugins/pty.ts`, `src/services/pty-manager.ts` or `src/routes/internal.ts` that is not behind an `app.db` guard. Confirm the new field is in both halves of the internal schema.

## 3. Frontend and backend defaults, bounds and fallbacks are independent copies

**Invariant.** `DEFAULT_SETTINGS` in `src/services/settings.ts` and `DEFAULT_SETTINGS` in `frontend/src/api/settings.ts` are a hand-maintained mirror. Bounds must agree across `sanitizeSettings`, the UI `min`/`max` props under `frontend/src/settings/`, and `src/plugins/env.ts`. `FALLBACK_TASK_MASTER_ENV` and `FALLBACK_RUNTIME_ENV` in `frontend/src/store/constants.ts` must equal the `env.ts` defaults. Nothing but review enforces any of this.

**Breaks.** The UI shows one default or limit while the server applies another, or the pre-load fallback flashes values that then jump.

**Check.** For each changed setting, grep its key in those four files and compare defaults and bounds side by side. A diff that touches only one copy is the finding.

## 4. A new env key lands in env.ts, `.env.example` and `docs/configuration.md` together

**Invariant.** Environment-variable truth is three files: `src/plugins/env.ts`, `.env.example`, and the schema-backed tables of `docs/configuration.md`. The `check:env-docs` script (`scripts/check-env-docs.mjs`) asserts they agree and runs as part of `npm run lint`. It reads `env.ts` by pattern, so keys must keep their existing flat indentation.

**Breaks.** Lint goes red, most often for a key missing from `.env.example`. Worse, a reformat of `env.ts` shrinks the set the checker matches, so later drift goes unreported.

**Check.** Run `node scripts/check-env-docs.mjs`, and confirm that an `env.ts` edit leaves the indentation of existing keys alone.
