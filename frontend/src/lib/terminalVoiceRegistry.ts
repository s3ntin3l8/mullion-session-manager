import { useSyncExternalStore } from "react";
import type { VoiceDictationPhase } from "../voice/useVoiceDictation.js";

// On a coarse pointer the dictation mic lives in the key bar (MobileKeyBar),
// not floating over the terminal where it covered the prompt — but the
// dictation state machine lives in TerminalPane (it needs the live
// Terminal to insert into). TerminalPane publishes its controls here per
// session; the key bar subscribes. Same per-session keying as
// terminalInputRegistry.ts.
export interface TerminalVoiceControls {
  phase: VoiceDictationPhase;
  interimText: string;
  disabled: boolean;
  press: () => void;
  release: () => void;
  cancel: () => void;
}

// A stack per session, like terminalInputRegistry.ts: the latest publisher
// wins, and removing it falls back to the previous one still mounted.
const controlsBySession = new Map<number, TerminalVoiceControls[]>();
const listeners = new Set<() => void>();

export function publishVoiceControls(sessionId: number, controls: TerminalVoiceControls): void {
  const stack = controlsBySession.get(sessionId);
  if (stack) stack.push(controls);
  else controlsBySession.set(sessionId, [controls]);
  listeners.forEach((l) => l());
}

/** Removes exactly `controls` (by identity), wherever it sits in the
 * session's stack — a stale cleanup never removes another publisher. */
export function unpublishVoiceControls(sessionId: number, controls: TerminalVoiceControls): void {
  const stack = controlsBySession.get(sessionId);
  const index = stack?.indexOf(controls) ?? -1;
  if (!stack || index === -1) return;
  stack.splice(index, 1);
  if (stack.length === 0) controlsBySession.delete(sessionId);
  listeners.forEach((l) => l());
}

function currentControls(sessionId: number): TerminalVoiceControls | undefined {
  const stack = controlsBySession.get(sessionId);
  return stack?.[stack.length - 1];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceControls(sessionId: number): TerminalVoiceControls | undefined {
  return useSyncExternalStore(subscribe, () => currentControls(sessionId));
}
