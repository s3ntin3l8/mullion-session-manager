import { useEffect, useState } from "react";
import {
  chordFromEvent,
  chordLabel,
  formatChord,
  parseChord,
  validateChord,
  type KeyChord,
} from "../lib/keyChord.js";
import { ErrorText } from "../ui/ErrorText.js";

// A "press a combo" control for rebinding the voice dictation push-to-talk
// chord (#1119). No key-capture input existed anywhere in this codebase
// before this — see ui/primitives.tsx, which has no text/key input, and
// `settings-kbd-chip` (styles/modals.css), previously display-only styling
// for the hardcoded Ctrl+R/L/K rows below this one on the same page.
export function KeyChordField({
  value,
  defaultValue,
  onChange,
  disabled,
}: {
  /** Current stored chord string. Parsed defensively — an unparseable value
   * (hand-edited settings, a future format change) falls back to showing
   * `defaultValue` rather than crashing the settings page. */
  value: string;
  defaultValue: KeyChord;
  onChange: (next: string) => void;
  /** Same convention as Toggle/NumberField elsewhere in Settings (e.g.
   * TaskMasterSection's `disabled={!resolved.enabled}`) — greys out and
   * blocks capture, doesn't hide the control. */
  disabled?: boolean;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adjusting state during render (React's own documented pattern for this,
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than an effect that calls setState: if the field is disabled
  // mid-capture (the user unchecked "Dictation hotkey" while this was
  // armed), drop out of capture state immediately rather than leaving a
  // "Press a combo…" button that no longer does anything for one extra
  // render.
  const [prevDisabled, setPrevDisabled] = useState(disabled);
  if (disabled !== prevDisabled) {
    setPrevDisabled(disabled);
    if (disabled) {
      setCapturing(false);
      setError(null); // don't leave a stale rejection reason under a greyed-out field
    }
  }

  const chord = parseChord(value) ?? defaultValue;

  useEffect(() => {
    if (!capturing || disabled) return;
    // Capture phase, deliberately: useGlobalShortcuts installs a bubble-
    // phase window keydown listener for Ctrl+K / Ctrl+, / Escape, and this
    // field needs first look at every keydown while armed — including a
    // combo the user is trying to rebind ONTO one of those global
    // shortcuts (validateChord below still rejects that, but only after
    // actually seeing the keydown).
    function onKeyDown(event: KeyboardEvent): void {
      const next = chordFromEvent(event);
      if (!next) return; // bare modifier or an unusable code — keep waiting
      event.preventDefault();
      event.stopPropagation();
      // next.code, not event.key, for the same layout/IME-independence
      // reason every other comparison in this module uses code — this is
      // the one intentional exception to "Escape always cancels regardless
      // of modifiers held" (e.g. Shift+Escape can never be captured as a
      // chord, it always cancels too).
      if (next.code === "Escape") {
        setCapturing(false);
        setError(null); // don't leave a stale rejection reason after cancelling
        return;
      }
      const validation = validateChord(next);
      if (!validation.ok) {
        setError(validation.reason);
        return;
      }
      setError(null);
      setCapturing(false);
      onChange(formatChord(next));
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange identity churn shouldn't re-arm capture
  }, [capturing, disabled]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          className="settings-secondary-btn"
          aria-label="Record dictation hotkey"
          disabled={disabled}
          onClick={() => {
            setError(null);
            setCapturing(true);
          }}
        >
          <span className="settings-kbd-chip">
            {capturing ? "Press a combo…" : chordLabel(chord)}
          </span>
        </button>
        {/* Compares the parsed/canonicalized chord, not the raw stored
            string — parseChord accepts any modifier order, so a
            non-canonical-but-equivalent stored value (e.g. set via a
            direct API PATCH) must not show a Reset button for a chord
            that already IS the default. */}
        {formatChord(chord) !== formatChord(defaultValue) && !capturing && (
          <button
            className="settings-secondary-btn"
            disabled={disabled}
            onClick={() => {
              setError(null);
              onChange(formatChord(defaultValue));
            }}
          >
            Reset
          </button>
        )}
      </div>
      {capturing && !error && (
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Nothing captured? Another app may have claimed this combo globally — 1Password's Quick
          Access defaults to Ctrl+Shift+Space on Windows and Linux. Escape to cancel.
        </span>
      )}
      {error && <ErrorText style={{ fontSize: 11.5 }}>{error}</ErrorText>}
    </div>
  );
}
