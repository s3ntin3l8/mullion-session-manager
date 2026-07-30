import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
}: {
  onConfirm: () => void;
  title: string;
  children: ReactNode;
  // Settings -> Session management's "Confirm before kill" toggle, off —
  // fires immediately on the first click instead of arming.
  skipConfirm?: boolean;
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
      // Independent review finding (PR #435) — armed used to replace `title`
      // outright with a generic "Click again to confirm", so a
      // caller-supplied warning (e.g. "N child sessions will keep running
      // independently") vanished at the exact moment — the second click —
      // it mattered most. Append the hint instead of discarding the context.
      title={armed ? `${title} — click again to confirm` : title}
      onClick={() => {
        if (armed || skipConfirm) {
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
