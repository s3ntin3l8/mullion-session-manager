// Pure gesture classification for the hybrid hold-or-latch push-to-talk
// button (mic button in TerminalPane, and the desktop Ctrl+Shift+Space
// hotkey) — kept DOM-free so the 350ms threshold logic is unit-testable
// without a real PointerEvent/KeyboardEvent.

/** A hold longer than this releases immediately (classic push-to-talk); at
 * or under it, the press latches on and a second press/Escape/blur stops
 * it. Recognition itself always starts on press — this only governs how
 * *release* is interpreted, so there's no added latency before listening
 * begins either way. */
export const HOLD_THRESHOLD_MS = 350;

export type ReleaseAction = "stop" | "latch";

/**
 * Deliberately takes only elapsed time, never any modifier/key state — the
 * desktop hotkey release must be recognized by `event.code === "Space"`
 * alone (see terminalKeys.ts), because a user can lift Ctrl before Space,
 * at which point the Space keyup event reports ctrlKey: false. Re-deriving
 * "was this the voice chord" from the release event's own modifier state
 * would miss that case and leave the mic listening forever.
 */
export function resolveRelease(
  pressStartedAt: number,
  releasedAt: number,
  thresholdMs: number = HOLD_THRESHOLD_MS,
): ReleaseAction {
  return releasedAt - pressStartedAt > thresholdMs ? "stop" : "latch";
}
