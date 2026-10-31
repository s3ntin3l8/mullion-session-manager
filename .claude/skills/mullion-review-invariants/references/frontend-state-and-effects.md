# Frontend state: render-phase adjustments, effects, dialogs, store errors and input

Read this when a diff touches React state that is adjusted during render, a
`useEffect` that fetches or is keyed on a prop, a per-project view, a busy
modal, `refreshSessions` or its error handling, or terminal launch and keyboard
paths. Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. Render-phase `setState` adjustments must converge

**Invariant.** Two render-phase "adjust state when X changed" blocks that write
the same state need disjoint predicates. Derive any value they share, gated on
membership in its source array, once before either block runs. A guard of the
form `if (input !== lastInput)` terminates only when `input` is a stable
reference (state-backed or memoized), not a fresh `.filter()` per render.
`DockProjectGroup` in `frontend/src/dock/DockProjectGroup.tsx` holds the
convergent form.

**Breaks.** React's "too many re-renders" error. On a cold load, where a
restored layout names a project while `projects` is still empty, the whole
viewport goes blank, because no subtree boundary catches it.

**Check.** For each added render-phase setter, list the predicates of every
other writer of that state and look for a value that satisfies one's
postcondition and the other's precondition. Confirm the compared input is stable.

## 2. Effect-keyed props are identity-stable; async effects guard stale responses

**Invariant.** An effect keyed on a counter, token or object that a parent
builds inline re-fires every render, so the counter gates nothing: memoize over
scalars and scope any position to the displayed subject. A `useEffect` that
fetches keyed on an id (project, path, session) sets a `cancelled` flag in its
cleanup and checks it before writing state. `useDockGithubStatus` is the
pattern.

**Breaks.** The view is yanked back on unrelated re-renders; a slow response
for project A overwrites project B.

**Check.** For each changed effect with an API call, find the cleanup that sets
the flag; for object-valued dependencies, find the `useMemo`.

## 3. Per-project component state resets on project switch

**Invariant.** `RightSidebarPanel` renders its views unkeyed, so component-local
state (`useAsyncData` results, release or merge rows) survives a project switch
unless the view keys itself, as `GitHubSidebarView` does with
`key={projectId}`, or derives everything from `projectId`.

**Breaks.** The previous project's row stays on screen with a callback now bound
to the new project, opening the wrong repo's pull request.

**Check.** Rerender with a second project whose fetch never resolves and assert
the old text is gone. Then delete the key: if the test stays green it pins
nothing (a mock keyed on the id records the new id on the reused instance).

## 4. Busy dialogs use `aria-disabled`, not `disabled`

**Invariant.** A modal control that becomes `disabled` while busy drops focus to
`<body>`, and `useFocusTrap` (it selects enabled buttons) has nothing to pull
back. Busy controls use `aria-disabled` with a no-op handler; `Modal` takes
`closeDisabled`, and the caller also guards `onClose` for Escape and backdrop.
`PrActionBar` is the example.

**Breaks.** Focus escapes behind the backdrop; a double-submitted merge.

**Check.** Grep the dialog for a busy-driven `disabled`. The test must click the
busy controls and assert no second request, since the guard lives in JS.

## 5. `refreshSessions` coalescing and the error classes

**Invariant.** Mutations await `refreshSessions` to observe their own write, so
coalescing must never hand a caller a fetch already in flight from before the
mutation. It rethrows on failure (callers `.catch`), and prunes per-session maps
only on success. `ApiError`, `RateLimitedError` (carries `retryAfterMs`) and
`AuthExpiredError` in `frontend/src/api/client.ts` are separate classes, so
`instanceof ApiError ? err.message : generic` hides the two whose message
matters.

**Breaks.** A just-created session missing from the list; every session
vanishing after one failed fetch; a generic error instead of a back-off hint.

**Check.** Reject a bare shared-promise dedup in `refreshSessions`. In new
`catch` blocks, confirm 429 and expiry are handled.

## 6. Launch gates and keyboard bytes have one enforcement point

**Invariant.** `canLaunchTerminal` is applied inside `openGlobalLauncher`; the
keyboard path in `useGlobalShortcuts` goes through that function rather than
calling `setPalette` itself. For terminal input, `sendInput` is a raw
passthrough that skips the custom key handler, so keys needing keydown
semantics (Ctrl+C as copy-or-interrupt) use the dedicated `sendCtrlC` in
`frontend/src/terminalInputRegistry.ts`. xterm swallows any key
its handler accepts, so check chords against it.

**Breaks.** A terminal opened into an unrelated workspace from a view with no
dockview; copy silently becoming an interrupt.

**Check.** Grep new launcher entry points for a direct `setPalette` open, and
new `MobileKeyBar` keys that send control bytes via `sendInput`.
