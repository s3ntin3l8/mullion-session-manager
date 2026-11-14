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
