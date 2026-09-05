import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { CheckIcon } from "./icons.js";

// A native window.confirm() blocks the entire tab (including our own WS
// connections and any automated testing) until dismissed, and looks jarring
// against the app's own dark theme — an in-app "click again to confirm"
// pattern avoids both. Auto-disarms after a few seconds so a stray second
// click well after the fact can't fire it by surprise.
export function ConfirmButton({
  onConfirm,
  title,
  children,
  skipConfirm = false,
  disabled = false,
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
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={`danger${armed ? " armed" : ""}`}
      disabled={disabled}
      // Independent review finding (PR #435) — armed used to replace `title`
      // outright with a generic "Click again to confirm", so a
      // caller-supplied warning (e.g. "N child sessions will keep running
      // independently") vanished at the exact moment — the second click —
      // it mattered most. Append the hint instead of discarding the context.
      title={armed ? `${title} — click again to confirm` : title}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (skipConfirm) {
          setArmed(false);
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
        if (armed && e.detail > 1) return;
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? <CheckIcon size={13} /> : children}
    </button>
  );
}
