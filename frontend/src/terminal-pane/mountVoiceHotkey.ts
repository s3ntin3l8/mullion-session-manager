// Voice hotkey hold-tracking moved out of TerminalPane's mount effect
// (issue #2406). The effect calls this where stopVoiceHotkeyHold was
// declared; the call assigns voiceHotkeyPressRef and returns
// stopVoiceHotkeyHold for the effect's cleanup list (same statement, same
// position). The held key code stays a local of this factory — it is not
// shared with the rest of the effect, so it is not on the mount bag.
// Construction, the WebGL atlas sequence, and OSC 10/11/12 registration
// stayed in the effect.

import type { KeyChord } from "../lib/keyChord.js";
import type { VoiceDictationController } from "../voice/useVoiceDictation.js";

export interface MountVoiceHotkeyDeps {
  voiceControllerRef: { readonly current: VoiceDictationController };
  voiceChordRef: { readonly current: KeyChord };
  voiceHotkeyPressRef: { current: () => void };
}

export function attachMountVoiceHotkey(deps: MountVoiceHotkeyDeps) {
  const { voiceControllerRef, voiceChordRef, voiceHotkeyPressRef } = deps;

  // Voice dictation hotkey hold-tracking. Keydown is handled by
  // attachKeyConflictHandler in lib/terminalKeys.ts (all three call sites route
  // onVoicePress through voiceHotkeyPressRef, assigned here) — release is
  // deliberately NOT handled there. attachCustomKeyEventHandler only ever
  // sees the FOCUSED terminal's own keydown/keyup, but a physical hold can
  // outlast that focus (the user alt-tabs away, or a browser dialog steals
  // it mid-hold), which would otherwise leave the mic listening with no
  // way to stop it via the keyboard. A `window` listener, installed only
  // for the duration of an actual hold, catches the keyup regardless of
  // which element currently has focus. (A hold that outlasts focus loss
  // ENTIRELY — no keyup ever arrives at all, e.g. the tab itself is
  // backgrounded — is covered separately by the phase-driven blur/
  // visibility/pagehide effect in TerminalPane.tsx, which applies uniformly to
  // a hotkey hold AND a tap-latched mic-button dictation alike; this
  // handler only needs to cover the ordinary "keyup arrives somewhere
  // other than the terminal" case.)
  //
  // Tracks the held key's *code*, not a boolean, and captures it at press
  // time (#1119 — the chord is now user-configurable). The keyup listener
  // deliberately can't re-test the full chord — see pushToTalk.ts's own
  // comment: a user can lift Ctrl before the key, at which point this
  // keyup event reports ctrlKey: false, and re-testing the chord here
  // would miss the release entirely. Capturing the code at press (rather
  // than re-reading voiceChordRef.current on every keyup) means a settings
  // edit mid-hold can't strand a listening session waiting for a keyup
  // that will now never match.
  let voiceHotkeyHeldCode: string | null = null;
  function stopVoiceHotkeyHold(): void {
    if (voiceHotkeyHeldCode === null) return;
    voiceHotkeyHeldCode = null;
    window.removeEventListener("keyup", onVoiceHotkeyKeyup);
  }
  function onVoiceHotkeyKeyup(event: KeyboardEvent): void {
    if (event.code !== voiceHotkeyHeldCode) return;
    stopVoiceHotkeyHold();
    voiceControllerRef.current.release();
  }
  voiceHotkeyPressRef.current = () => {
    // Idempotent: terminalKeys.ts already filters event.repeat, but a
    // guard here too means a duplicate press (e.g. two attach sites
    // somehow both firing for one physical keydown) can never register a
    // second press() on top of an already-listening dictation.
    if (voiceHotkeyHeldCode !== null) return;
    voiceHotkeyHeldCode = voiceChordRef.current.code;
    voiceControllerRef.current.press();
    window.addEventListener("keyup", onVoiceHotkeyKeyup);
  };

  return { stopVoiceHotkeyHold };
}
