import type { PointerEvent as ReactPointerEvent } from "react";
import { MicIcon } from "../ui/icons.js";
import type { VoiceDictationPhase } from "../voice/useVoiceDictation.js";

// Push-to-talk mic button for TerminalPane, next to the "attach image"
// button (see that file's own overlay-collision comment: top-right is
// shared by both on a fine pointer; coarse pointers get a bottom-right FAB
// instead, since the interim chip below already claims bottom-centre).
//
// This component owns only the gesture -> press()/release()/cancel() wiring
// and the interim-text chip's render; all dictation state and logic lives
// in useVoiceDictation.ts (TerminalPane owns that hook instance, since the
// actual insertion — pasteToTerminal — needs the mount effect's closures).
export interface VoiceMicButtonProps {
  phase: VoiceDictationPhase;
  interimText: string;
  /** True when the button should render disabled rather than not at all —
   * e.g. an insecure-context origin, where the API is present but calling
   * it can only fail. TerminalPane omits the button entirely (not just
   * disables it) when isSpeechDictationSupported() is false — see that
   * file's render. */
  disabled: boolean;
  /** Positions the button as a 44px bottom-right FAB instead of the
   * fine-pointer top-right overlay slot — matching the touch-target-size
   * convention `isCoarsePointer` already drives elsewhere in this file
   * (e.g. skipping WebGL). */
  coarsePointer: boolean;
  onPress: () => void;
  onRelease: () => void;
  onCancel: () => void;
}

export function VoiceMicButton({
  phase,
  interimText,
  disabled,
  coarsePointer,
  onPress,
  onRelease,
  onCancel,
}: VoiceMicButtonProps) {
  const listening = phase !== "idle";

  // preventDefault on pointerdown (not just onClick) is what keeps the
  // terminal's own focus — and, on mobile, its on-screen keyboard — from
  // being stolen by this button's own default focus-on-mousedown behavior.
  // Same rationale, verbatim, as MobileKeyBar.tsx's own onPointerDown
  // handler; TerminalPane.tsx's caller is responsible for the OTHER half
  // (refocusing the terminal once dictation actually inserts text), since
  // only it has the live `term` reference.
  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (disabled) return;
    // Lets a finger sliding off this button during a hold still deliver its
    // eventual pointerup HERE rather than wherever it happens to end up —
    // without this, a hold that drifts off a 44px touch target during
    // speech would silently leave the mic listening forever.
    event.currentTarget.setPointerCapture(event.pointerId);
    onPress();
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onRelease();
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // A genuine pointercancel (not a plain lift) means the OS/browser
    // interrupted the gesture — a system dialog, a scroll takeover — not a
    // deliberate release. Discarding rather than inserting matches the
    // principle that a misheard/interrupted dictation should never
    // surprise-insert text into the CLI's prompt.
    onCancel();
  }

  return (
    <>
      <button
        type="button"
        className={[
          "pane-tab-btn",
          "terminal-voice-btn",
          coarsePointer ? "coarse" : "",
          listening ? "listening" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={
          disabled
            ? "Dictation needs an https:// origin"
            : listening
              ? "Listening… release or tap again to insert"
              : "Hold or tap to dictate"
        }
        aria-label={listening ? "Stop dictation" : "Start dictation"}
        aria-pressed={listening}
        disabled={disabled}
        style={{ touchAction: "none", userSelect: "none" }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <MicIcon size={14} />
      </button>
      {listening && interimText && (
        <div className="terminal-voice-interim" aria-live="polite">
          {interimText}
        </div>
      )}
    </>
  );
}
