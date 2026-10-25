import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { CheckIcon } from "./icons.js";

// A native window.confirm() blocks the entire tab (including our own WS
// connections and any automated testing) until dismissed, and looks jarring
// against the app's own dark theme — an in-app "click again to confirm"
// pattern avoids both. Auto-disarms after a few seconds so a stray second
// click well after the fact can't fire it by surprise.
//
// The arm window is 6 seconds, and the button COUNTS IT DOWN while armed.
// It used to disarm silently: the button changed appearance, gave no
// indication of how long the window was, and simply reverted after six
// seconds. A user who looked away came back to a button that had quietly
// reset itself and had to start over. The pane-kill path and the kebab
// menu both showed a "3s / 2s / 1s" countdown all along (see
// PaneActionsMenu.tsx and KebabMenu.tsx), so this component was the
// outlier — the countdown now lives here, so every caller gets it.
const ARM_MS = 6000;
const ARM_SECONDS = ARM_MS / 1000;

export function ConfirmButton({
  onConfirm,
  title,
  children,
  skipConfirm = false,
  disabled = false,
  allowDoubleClickConfirm = false,
  armedLabel,
  variant = "danger",
}: {
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  // Settings -> Session management's "Confirm before kill" toggle, off —
  // fires immediately on the first click instead of arming.
  skipConfirm?: boolean;
  // Issue #442 (GitPanel branch/worktree management) — a caller-computed
  // "this action isn't valid right now" state (e.g. the current branch, or
  // one checked out elsewhere), distinct from `skipConfirm`: this disables
  // the click entirely rather than changing whether it arms first.
  disabled?: boolean;
  // Session kill controls enable this so a quick second click on the newly
  // armed checkmark completes the expected two-click flow.
  allowDoubleClickConfirm?: boolean;
  // When set, the armed state shows the check icon plus this text instead of
  // the bare icon, and the button reserves room for the wider of the two
  // labels so arming never changes its width (and so never shifts neighbours
  // under the cursor — a second click meant for this button can't land on
  // a sibling that slid into its place).
  armedLabel?: ReactNode;
  // "neutral" keeps the arm-then-confirm flow without the destructive red
  // styling, for actions that are deliberate but not dangerous.
  variant?: "danger" | "neutral";
}) {
  const [armed, setArmed] = useState(false);
  // Ticks 6 -> 5 -> ... -> 1 rather than sitting static for the whole arm
  // window — a countdown that doesn't move reads as stuck (the same
  // reasoning as KebabMenu's and PaneActionsMenu's own countdowns).
  const [secondsLeft, setSecondsLeft] = useState(ARM_SECONDS);
  // The window is a WALL-CLOCK DEADLINE, not a number of interval ticks.
  //
  // A backgrounded tab has its timers throttled to roughly one firing a
  // minute, so a countdown that decrements one step per firing ticks
  // once a minute — the button then stays armed for minutes instead of
  // six seconds, and the number it shows is wrong the whole time. The
  // deadline is compared against Date.now() on every firing, so the first
  // firing after the window has passed ends it, and the number on screen
  // is the time actually left rather than the number of ticks that have
  // happened.
  const deadlineRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCountdown = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    deadlineRef.current = null;
  };

  // The timer is cleared on unmount: an armed ConfirmButton that unmounts
  // (the dialog it lives in closes) must not leave an interval running.
  useEffect(() => clearCountdown, []);

  const arm = () => {
    setArmed(true);
    setSecondsLeft(ARM_SECONDS);
    clearCountdown();
    deadlineRef.current = Date.now() + ARM_MS;
    intervalRef.current = setInterval(() => {
      const remaining =
        deadlineRef.current === null ? 0 : Math.ceil((deadlineRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        clearCountdown();
        setSecondsLeft(ARM_SECONDS);
        setArmed(false);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
  };

  const disarm = () => {
    clearCountdown();
    setSecondsLeft(ARM_SECONDS);
    setArmed(false);
  };

  return (
    <button
      type="button"
      className={`${variant === "neutral" ? "confirm-neutral" : "danger"}${armed ? " armed" : ""}${
        armedLabel ? " confirm-btn-stable" : ""
      }`}
      disabled={disabled}
      // Independent review finding (PR #435) — armed used to replace `title`
      // outright with a generic "Click again to confirm", so a
      // caller-supplied warning (e.g. "N child sessions will keep running
      // independently") vanished at the exact moment — the second click —
      // it mattered most. Append the hint instead of discarding the context.
      // The remaining seconds are in here too: a screen-reader user cannot
      // see the countdown the button shows visually, and the title is what
      // they get when they focus it.
      title={armed ? `${title} — click again to confirm (${secondsLeft}s)` : title}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (skipConfirm) {
          disarm();
          onConfirm();
          return;
        }
        // Review finding on PR #1086: a literal double-click both arms and
        // fires in one gesture — React flushes `armed=true` from click 1
        // before click 2's handler runs, so click 2's closure already sees
        // `armed === true` and confirms immediately, with no perceptible
        // intermediate "click again to confirm" state. `e.detail` is the
        // browser's own double-click counter (bumped when successive clicks
        // land within the OS's configured double-click interval) — reject a
        // click that's part of one of those, without disarming, so the
        // user's next *deliberate* click still confirms. Verified against
        // this component's own tests: two independent `user.click()` calls
        // each report `detail: 1`; `user.dblClick()`'s second click reports
        // `detail: 2`.
        //
        // This doesn't catch a double-*activation* via keyboard (Enter/Space,
        // including key auto-repeat) — those report `detail: 0` regardless —
        // but the reported, empirically-verified bug is the mouse gesture,
        // so that's what this guards.
        if (!allowDoubleClickConfirm && armed && e.detail > 1) return;
        // The window is enforced HERE as well as in the countdown,
        // because the countdown only runs while the tab is letting timers
        // fire. A backgrounded tab has its timers throttled to roughly
        // one firing a minute, so the interval that would have disarmed an
        // expired button may not have run yet — and the button still
        // LOOKS armed, showing a stale "6s". Clicking it in that state
        // must not confirm: the six-second promise is over, and
        // confirming it anyway would make the countdown a lie. The click
        // disarms instead, so the user sees the window close and starts
        // over.
        if (armed && (deadlineRef.current === null || Date.now() >= deadlineRef.current)) {
          disarm();
          return;
        }
        if (armed) {
          disarm();
          onConfirm();
        } else {
          arm();
        }
      }}
    >
      {armedLabel ? (
        <>
          {/* Both states live in one grid cell. The inactive one is
              `visibility: hidden`, so it still reserves the button's width
              — arming cannot shift a neighbouring button out from under
              the cursor — but it contributes nothing to the accessible
              name. */}
          <span className="confirm-btn-label" aria-hidden={armed || undefined} data-active={!armed}>
            {children}
          </span>
          <span className="confirm-btn-label" aria-hidden={!armed || undefined} data-active={armed}>
            <CheckIcon size={13} /> {armedLabel}
            <span className="confirm-btn-countdown" aria-hidden="true">
              {secondsLeft}s
            </span>
          </span>
        </>
      ) : armed ? (
        <>
          <CheckIcon size={13} />
          <span className="confirm-btn-countdown" aria-hidden="true">
            {secondsLeft}s
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
