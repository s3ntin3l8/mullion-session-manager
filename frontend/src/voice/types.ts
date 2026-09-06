// Voice dictation for the terminal pane (push-to-talk). See the plan at
// .claude/plans/i-want-to-enable-structured-sutherland.md for the full
// design rationale — this file is just the shared type contract.
//
// The provider seam exists so a future server-side STT implementation
// (MediaRecorder -> upload -> transcript) has a shape to satisfy. It is
// deliberately a type contract, not a registry: there is exactly one
// implementation today (webSpeechProvider.ts), imported directly by
// useVoiceDictation.ts. Don't add a factory/registry until there is a
// second implementation to select between.

export type VoiceErrorCode =
  | "unsupported"
  | "insecure-context"
  | "permission-denied"
  | "no-microphone"
  | "network"
  | "no-speech"
  | "aborted"
  | "unknown";

export interface SpeechSession {
  /** Graceful stop: flush any pending audio/result, then fire onEnd. */
  stop(): void;
  /** Discard: no further onFinal calls, then fire onEnd. */
  abort(): void;
}

export interface SpeechProviderCallbacks {
  /**
   * A newly finalized transcript SEGMENT — a delta, never the cumulative
   * transcript-so-far. The Web Speech provider must reconstruct this from
   * the browser's cumulative `event.results` array; see that file's own
   * comment. The accumulated buffer across multiple segments (and across an
   * engine auto-restart) is owned by useVoiceDictation, not the provider —
   * a fresh recognizer instance's own `results` resets to empty on restart,
   * so a provider-owned buffer would lose everything said before a restart.
   */
  onFinal(segment: string): void;
  /** Best-effort live text for the utterance in progress; may be "". */
  onInterim(text: string): void;
  onError(code: VoiceErrorCode): void;
  /**
   * The provider is no longer listening, for ANY reason: an explicit
   * stop()/abort(), a terminal error, or the engine's own auto-stop (Chrome
   * ends a `continuous` session after a silence window regardless of
   * caller intent). onEnd always fires eventually after start(); it is the
   * only reliable "done" signal.
   */
  onEnd(): void;
}

export interface SpeechProvider {
  readonly id: string;
  /** Feature-detects by API presence. Does not check secure-context — see
   * voice/support.ts's isSecureContext, a deliberately separate check. */
  isSupported(): boolean;
  /**
   * Starts listening. MUST be safe to call synchronously inside a
   * user-gesture event handler with nothing awaited first — iOS Safari
   * silently refuses to grant microphone access otherwise (the same
   * user-activation-window hazard frontend/src/pushClient.ts documents for
   * pushManager.subscribe()).
   */
  start(opts: { lang: string } & SpeechProviderCallbacks): SpeechSession;
}
