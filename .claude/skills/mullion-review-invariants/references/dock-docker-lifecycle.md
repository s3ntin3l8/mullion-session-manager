# Dock: compose recreate, docker-logs auto-attach, docker routes, availability

Read this when a diff touches the bottom Dock (`frontend/src/dock/`), the docker
and compose routes in `src/routes/projects.ts`, or the stylesheets that hide the
Dock.
Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. Compose recreate: hold vanished rows in render-phase state, keep them inert

**Invariant.** Discovery is driven by `docker ps -a`, so a compose recreate
drops a service from a poll or two. `holdVanishedDockerControls` re-inserts
vanished docker controls for `RECREATE_GRACE_MS`. It runs in the render body of
`frontend/src/dock/DockProjectGroup.tsx` from state-held previous values, never a
ref and never an effect, because an effect commits after the group has already
unmounted. Held rows are inert in `frontend/src/dock/DockMonitor.tsx`
(`aria-disabled`, no menu, no click handler): the backend cannot resolve their
frozen docker data. The auto-attach effect reads the raw discovery list, not the
held-merged one.

**Breaks.** Every recreate resizes sibling monitors and remounts terminals;
actions on a vanished control 404; attach edges shift.

**Check.** The hold block keeps its "controls changed" guard on a stable
state-backed input, the helper stays pure, and held rows stay unclickable.

## 2. Docker-logs auto-attach is edge-triggered by identity, pruned each poll

**Invariant.** Auto-attach fires on an eligible false-to-true edge (or a timed
retry after failure), keyed by `dockerSessionIdentity` in
`frontend/src/dock/dockHelpers.ts`, which yields `docker-logs:<container>`, never
by command text. Identities absent from the current poll are pruned first, so a
`down` then `up` attaches again. The session is created `nameLocked`. Writing
the persisted selection is gated by `hasSeenRows`, so an empty first render
cannot overwrite the saved choice.

**Breaks.** Re-attaching over a stream the user stopped, orphaned sessions when
the command text changes, no re-attach after a recreate, or a failed fetch
erasing the saved Dock selection.

**Check.** In the effect: prune loop before the eligibility loop, edge-or-retry
condition, `nameLocked: true`, and the `hasSeenRows` early return before storage
is written.

## 3. Docker routes: `controlId` is a lookup key, stack identity is the compose project

**Invariant.** `controlId` is never interpolated into argv. `resolveOwnedService`
matches it against live discovery (404 when unowned or the docker-services
setting is off) and arguments are rebuilt from `ComposeService` fields. Stack
actions share one identity per compose project (`docker-stack:<project>`,
`nameLocked`), backed by the unique index `sessions_stack_identity_unique`; they
go through `startStackSession` and `findActiveStackSession`. "Already running"
uses `isMasterAliveState`, not `sessions.status` (intent only) or the in-memory
manager map (empty after a restart). `willRecreateOnApply` is advisory and
returns null on an empty recorded hash or failed recompute.

**Breaks.** Command injection through the body; two concurrent compose actions
leave the stack half-applied; a dead session is reused or a duplicate spawned
after a restart; spurious "will recreate" labels.

**Check.** A new docker route calls `resolveOwnedService` and has a body schema
requiring `controlId` with no additional properties; new liveness checks use
`isMasterAliveState`.

## 4. Dock availability CSS and its predicate stay in sync

**Invariant.** Exactly two stylesheet conditions hide `.dock`: coarse pointer in
`frontend/src/styles/tablet.css` and the phone tier in
`frontend/src/styles/mobile.css`. `frontend/src/lib/dockAvailability.ts` is the
one predicate the palette and Settings read. `check:dock-availability`
(`scripts/check-dock-availability.ts`, part of `npm run lint`) fails when a
stylesheet hides the Dock under a condition the predicate does not know.

**Breaks.** The palette or Settings offer Dock actions on a layout where the
Dock is invisible, or hide them where it shows.

**Check.** After editing any stylesheet that targets `.dock`, run
`npx tsx scripts/check-dock-availability.ts`.
