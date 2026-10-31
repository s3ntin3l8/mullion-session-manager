# Dockview layout: floating groups, shared arrays, layout bumps and tiers

Read this when a diff touches the dockview workspace in `frontend/src/App.tsx`,
`frontend/src/panelUtils.ts`, workspace persistence, floating panels, or the
phone/tablet/desktop breakpoints.
Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. Never hand a floating group to `maximizeGroup`

**Invariant.** Maximizing a floating group throws inside dockview. Callers go
through `maximizeIfTiled` in `frontend/src/panelUtils.ts`, and "tiled" is
decided by `isTiledGroup`, which reads the group's api location type, not its
panel list: `onDidAddGroup` fires before panels attach, so a panel-based test
sees an empty group. New `onDidAddGroup` handlers (see
`frontend/src/hooks/useLayoutPresentation.ts`) filter with `isTiledGroup`. A
floating group's header is its only drag handle and close button, so phone-mode
header hiding must skip it, and leaving phone mode restores every group.

**Breaks.** A crash on the phone tier after earlier side effects already ran
(headers hidden, nothing maximized), or floating panels stranded without a
header.

**Check.** `git grep -n maximizeGroup -- frontend/src`: any call outside
`maximizeIfTiled` is suspect.

## 2. A filter added for one consumer of a shared derived array changes the others

**Invariant.** `mobilePanels` (tiled only, feeds the phone switcher) and
`workspaceProjectIds` (built by `workspaceProjectIdsFromPanels` from all panels,
feeds the desktop Dock columns) are deliberately separate memos in
`frontend/src/App.tsx`. Filtering a shared array, memo or context value means
tracing every consumer of it.

**Breaks.** A phone crash fix quietly removes a project's Dock column on desktop
when its only open session is floating.

**Check.** For any edit near those two values or the dockview panel list, list
all consumers and confirm each still receives the set it needs.

## 3. Programmatic layout mutations self-bump `panelsVersion`; `setTitle` is a layout change

**Invariant.** The layout-change event only reaches subscribers that were
already subscribed, so a wholesale restore (`fromJSON` or `clear`) in the same
commit as the subscription must call `setPanelsVersion` itself; see
`frontend/src/hooks/useWorkspacePersistence.ts`. Also, a title change fires the
same event that autosaves the workspace. Live terminal titles of session panels
are stripped from the persisted blob by `stripSessionPanelTitles`, and saves are
debounced (`AUTOSAVE_DEBOUNCE_MS`) and deduped (`persistIfChanged`).

**Breaks.** Dock columns stale after a workspace switch; one workspace PATCH per
title update trips the rate limiter.

**Check.** The restore path still bumps explicitly; strip runs before the blob
is compared or sent; the debounce and dedupe survive any persistence edit.

## 4. Floating groups need a height clamp and the titlebar offset

**Invariant.** The `floatingGroupBounds` prop only clamps position, never size.
The container-resize clamp in `frontend/src/App.tsx` sets the group height to the
container height minus `FLOATING_TITLEBAR_HEIGHT` (the window is group height
plus the titlebar). The constant is used because the theme variable is not
readable from the container. The clamp considers only floating groups.

**Breaks.** A tall floating panel hangs behind the opaque Dock with its bottom
resize handles out of reach.

**Check.** A clamp edit keeps the titlebar subtraction and the floating-only
filter; stacking changes keep the Dock painted above dockview.

## 5. Breakpoints come from `frontend/src/lib/layoutTier.ts`; touch affordances key off the live coarse pointer

**Invariant.** Phone, tablet and desktop decisions use the shared queries in
`frontend/src/lib/layoutTier.ts`, whose upper bounds are fractional so a
699.5 px viewport still matches a tier. Touch affordances (key bar, large tap
targets, native scrollbars, touch-action overrides) follow the live
`isCoarsePointer` subscription, not viewport width. Panel kinds opened with
`applyDesktopPositioning: false` must still take the phone path through
`openOrFocusProjectPanel` and `positioningForTier`.

**Breaks.** A viewport that matches no tier, phone fixes that never reach the
Browser pane, or touch drags fighting dockview's own pointer handling.

**Check.** No new hard-coded width media query in TS; a new project-panel kind
still routes phone through `positioningForTier`.
