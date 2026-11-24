# Motion

How things move in the dashboard: the shared values, the one spring, and the
rules every animation follows. The feel was approved on a Pixel 10 Pro Fold
from the motion study in the Tasks mode redesign (design section 10,
`docs/design/tasks-mode/prototype.html#polish`); the numbers below are that
study's.

## Tokens

Durations and curves live in `frontend/src/styles/tokens.css`, at `:root`
(they do not change with the theme). `frontend/src/lib/motion.ts` carries the
same values for code that animates from TypeScript, and a test keeps the two
copies equal.

| Token                 | Value                            | For                                                                  |
| --------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `--motion-press`      | 110ms                            | Press feedback: the scale and tint a control shows when touched.     |
| `--motion-fade`       | 160ms                            | Content arriving in place; what travel becomes under reduced motion. |
| `--motion-layout`     | 420ms                            | A layout change no finger drives, such as a card moving lanes.       |
| `--motion-ease`       | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Anything that arrives and settles.                                   |
| `--motion-ease-press` | `cubic-bezier(0, 0, 0.58, 1)`    | Press feedback.                                                      |

Write `transition: transform var(--motion-press) var(--motion-ease-press)`
rather than a literal duration. Older components still carry their own
durations; they move to the tokens as each surface is revisited.

## The spring

Anything a finger can move uses the spring in `frontend/src/lib/spring.ts`,
not a duration: a critically damped spring (no bounce) with a response of
0.36s.

- **It is interruptible.** Every run starts from the current value and the
  current velocity, so a moving sheet can be caught, dragged, thrown, or sent
  back the other way without a jump in position or speed.
- **A drag hands its speed over.** `releaseVelocity` measures the last few
  pointer samples; a finger that rested more than 80ms before lifting hands
  over no speed.
- **A drag is decided by where it is heading.** `projectRest` says where the
  throw would come to rest, and the gesture commits from that, not from where
  the finger lifted. A short fast flick dismisses as surely as a long drag.
- **Past an edge it resists.** `rubberBand` makes a drag past the resting
  place follow less the further it goes.

`ui/BottomSheet.tsx` is the reference consumer: it enters on the spring,
leaves on it, and follows a finger on its header.

## Where it lives

The rules below are applied once, in `frontend/src/styles/motion.css`
(imported last), rather than per component:

- **Press feedback.** Every button, `role="button"`/`tab`/`menuitem`/`option`,
  and the rows and cards that are not buttons (`.session-item`, `.task-card`,
  `.rail-ws-row`) scale a little and take a `--press-tint` on `:active`, over
  `--motion-press`. It uses the `scale` property, so it composes with any
  `transform` a component already has. A component that declares its own
  `transition` still scales on press, just without easing into it; restate
  `scale var(--motion-press) var(--motion-ease-press)` in that transition to
  keep the ease (`.task-card` does). Controls whose `pointerdown` calls
  `preventDefault()` are left out: that strands `:active` on touch.
- **Overlays enter and leave.** A menu or popover (`.pane-tab-overflow-menu`,
  `.custom-select-menu`) grows from its trigger; a dialog (`.motion-scrim`
  around `.motion-dialog`, set by `ui/Modal.tsx` and the command palette)
  settles in over a scrim that fades. Each leaves the same way when it
  carries `data-presence="leaving"`.
- **Material.** Sheets and popovers sit on `--material` with
  `--material-blur` and a `--material-edge`; under
  `prefers-reduced-transparency: reduce` they are solid `--chrome`.
  `--material` is `--term` at 94%, not a translucent `--chrome`: over the worst
  backdrop (white under the dark theme, black under the light one) it is
  still no closer to the text than solid `--chrome`, so every text colour that
  clears AA on `--chrome` clears it on material. `--chrome` has no headroom
  for that (`--r` and `--accent-solid` barely clear 4.5:1 on it).
  `tokens.contrast.test.ts` holds the invariant.
- **Layout changes.** A right-sidebar view arriving or replacing another
  fades and settles in (`.motion-arrive`); the mode switch fades the board in,
  and the grid and the Dock back in. Nothing that holds a terminal changes
  size over time, and under reduced motion these fades are off entirely
  (`animation: none`, not the reset's 0.01ms). Between 800 and 1099px the
  right half's view arrives the same way, and so does a session arriving on
  the right half (`App.tsx` keys `RightHalfPane` by the session); the halves
  themselves snap.
- **Rails.** Rail entries are buttons, so they take the press rule; the
  selected entry's edge marker grows in (`scale`) instead of appearing.
- **Soft edges.** Lists that scroll under a header fade out over their top
  16px once scrolled (a scroll timeline, so nothing runs while still; at rest
  nothing is masked).

### Keeping an overlay mounted while it leaves

There are two shapes:

- `usePresence(open, ref)` (`hooks/usePresence.ts`) for an overlay that owns
  its `open` state (a menu, a popover): render while `present`, put `state`
  on its root as `data-presence`.
- `<Presence when={open}>` (`ui/Presence.tsx`) around an overlay its parent
  mounts: every `Modal` and the command palette. However the parent closes
  it (a submit that succeeded, a palette command that ran, the global
  Escape, or the overlay's own Escape, backdrop and close button, which now
  call `onClose` at once), the overlay stays mounted for its exit and then
  unmounts. Write `<Presence when={open}><XModal … /></Presence>` in place of
  `{open && <XModal … />}`; a call site whose dialog needs a payload keeps its
  guard inside (`<Presence when={x !== null}>{x && <XModal x={x} />}</Presence>`):
  while leaving, Presence renders the children it last had while open. A
  reopen during the exit mounts a fresh overlay.

  `Modal` and the palette read the leaving state from context
  (`useParentPresence`) and hand Presence their root to wait on. Nothing
  waits on the exit but the picture: the state change, the action behind it
  and the focus move all happen at the close. The focus trap lets go at once
  (restoring to the opener, unless the action called `suppressRestore()`, as
  the palette's launch path does), focus still inside is blurred, and the
  leaving overlay is `inert`. A `Modal` rendered without a Presence (a test)
  falls back to `useDismissExit`: its own controls play the exit before
  `onClose`, and anything else closes it at once.

Both wait on the overlay's own clock-driven animations (`lib/presence.ts`),
not a timer: nothing there knows how long an exit is. Infinite and
scroll-driven animations inside the overlay are not waited on, and a safety
net (`EXIT_SAFETY_MS`, far past any exit) unmounts it even if an animation
never finishes. Under reduced motion, or where there is no
Web Animations (jsdom), there is nothing to wait for and the overlay goes at
once. A test that wants to see the leaving state installs
`test/exitAnimations.ts`, asserts `data-presence="leaving"`, then calls
`finishExits()`.

## Rules

- **Feedback on touch-down.** A control answers the moment it is pressed (a
  small scale and tint over `--motion-press`), not on release.
- **Springs for anything you can touch.** No bounce, except as the result of
  a throw.
- **Things leave the way they came.** A sheet enters from the edge it
  belongs to and returns there.
- **Continuity when the layout changes.** When a layout changes shape, an
  item travels to its new place instead of jumping (over `--motion-layout`).
- **Never animate a terminal's size.** A pane that holds a terminal opens at
  its final size at once; only its content fades and settles in. Animating a
  width or height would re-flow the terminal on every frame and resize its
  PTY. Animate `transform` and `opacity` around it, never the box it
  measures.
- **Material for layers above content.** Sheets may be translucent with a
  blur; structural chrome (rails, sidebars) stays solid. Reduced
  transparency makes sheets solid.
- **Reduced motion turns travel into a short fade.** One function decides
  it, `prefersReducedMotion()` in `lib/motion.ts`. The spring asks it and
  jumps straight to its target; a caller that wants a fade in place of the
  travel plays one over `--motion-fade` with the Web Animations API
  (`element.animate`). A CSS fade would not play: the reset at the end of
  `tokens.css` zeroes every CSS transition and shortens every CSS animation
  under reduced motion. Do not give the tokens a near-zero reduced-motion
  value instead; that reset's comment explains why a transition of a few
  milliseconds breaks the terminal's text canvas.
