# API route contracts

Read this when a diff touches batch GET routes, the PR list, PATCH handlers on projects, map-valued settings, or an endpoint that deletes things. Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. Batch GET routes: an absent id is transient, `null` is a durable nothing

**Invariant.** The multi-project batch routes (git statuses, git diff stats, and `/api/projects/git-refs` in `src/routes/projects.ts`) omit a project id when the failure is transient, such as an unreachable host, and emit `null` only for a durable "nothing". The client keeps its last-known-good value for an absent id and clears on a present `null`; `refreshGitRefs` in `frontend/src/store/slices/git.ts` tests `p.id in result.branches` and its siblings. A resolver that collapses "unreachable" into `null` must not feed these maps: use `resolveRepoRefResult`, not the null-collapsing `resolveRepoRef`.

**Breaks.** One briefly unreachable remote host wipes that project's cached PR list and branches from the client.

**Check.** For each map in a batch response, trace the error path: transient returns without assigning, durable assigns `null`. Compare against the `in` handling in `refreshGitRefs`.

## 2. PR-row fields must be populated on both the batch and the per-project route

**Invariant.** The list the UI renders comes from `usePrList` (`frontend/src/hooks/useGitHubData.ts`): the store's `prsByProject`, filled by the batch route, wins over the panel's own per-project fetch. Any field added to a PR row must be applied on both routes in `src/routes/projects.ts`; both currently wrap their rows in `annotatePrTasks(... overlayRelayRuns(...))`.

**Breaks.** The field shows on first load via the fallback path, then vanishes after the first store refresh, with no error anywhere.

**Check.** Find where the new field is produced and confirm it is applied in the per-project PR handler and in the batch handler. A frontend test must seed the store with `useDashboardStore.setState({ prsByProject })`, or it exercises only the fallback.

## 3. PATCH handlers with non-column flags must reject the "nothing to set" body

**Invariant.** A PATCH whose schema accepts flags that map to no column (`createDir`, `gitInit` on the project PATCH) and builds `.set()` from conditional spreads must answer 400 when the body contains only such flags. The guard sits before `.update().set()` in the handler in `src/routes/projects.ts`.

**Breaks.** drizzle throws "No values to set" and Fastify turns it into a 500 for a body like `{"gitInit": true}`.

**Check.** For every new optional PATCH property, name the column it maps to. If there is none, confirm the empty-body guard still covers a body made only of such properties, and that its message lists the new field.

## 4. Settings keyed by data, and edit dialogs that PATCH a whole map

**Invariant.** (a) `deepMerge` walks the keys of its base object, so a settings field whose keys are themselves data (`providerMap` under the runway settings in `src/services/settings.ts`) needs its raw value taken wholesale before `sanitizeSettings`, and the client's `updateSettings` must not clamp it either. Reads that depend on the saved value must wait for the debounced PATCH, via `settleSettingsPatch` in `frontend/src/store/slices/ui.ts`. (b) A dialog that PATCHes a whole map (`hostCwds` in `frontend/src/CreateProjectModal.tsx`) must not derive the payload from a list that defaults to empty, such as `hosts`; "not loaded yet" must send nothing.

**Breaks.** Added map keys vanish and deleted defaults return. Saving a rename while the hosts request is slow or failed PATCHes an empty `hostCwds` and wipes every per-host path without any visible error.

**Check.** (a) Run `deepMerge` on a throwaway value with a new key. (b) Render the modal in edit mode with `hosts` empty and a populated initial map, save, and read the payload.

## 5. Destructive endpoints gated on debounced settings intersect request and stored sets

**Invariant.** When an irreversible action is gated by a setting the client saves on a debounce, the route must intersect the ids in the request with a fresh `getStoredSettings` read, so neither a lagging store nor a stale tab can widen the set. The cache-directory emptying in `src/routes/system-resources.ts` filters the stored `diskCleanup.cacheDirs` by the requested ids. On the UI side, `frontend/src/settings/ServerDefaultNumberRow.tsx` keeps draft state (null means untouched) so a blur without typing does not save the displayed server default as an override.

**Breaks.** A just-unticked cache directory, or one ticked in a stale tab, is deleted anyway. A blur silently turns a server default into a saved override.

**Check.** The handler must consult both the request ids and the stored set. For number rows, confirm `onCommit` returns early when the draft is null.
