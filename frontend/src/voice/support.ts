import type { VoiceErrorCode } from "./types.js";

// Presence-based feature detection, same idiom as pushClient.ts's
// isPushSupported() — check for the API on the global, not
// window.isSecureContext. Deliberately does NOT check isSecureContext
// itself (see isSecureContextForDictation below): unlike the Clipboard API,
// webkitSpeechRecognition IS present on an insecure origin — construction
// and start() both succeed there and only fail later with a bare
// "not-allowed", which reads as a permission problem rather than a
// transport one. Keeping the two checks separate lets the UI show the
// right message for each.
export function isSpeechDictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  );
}

// Separate from isSpeechDictationSupported on purpose — see that function's
// own comment. http://localhost is a secure context, so `make dev` is
// unaffected; a plain-http LAN deploy (a plausible install path for a
// self-hosted app that never terminates TLS itself — src/plugins/
// security.ts) is not.
export function isSecureContextForDictation(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/**
 * Maps a SpeechRecognitionErrorEvent's `error` string to our own
 * VoiceErrorCode. `service-not-allowed` and `network` both cover the same
 * real-world case: a Chromium build with webkitSpeechRecognition present on
 * the global but no configured speech endpoint (some Chromium distros,
 * Brave, some Electron shells) — construction and start() succeed and only
 * fail here, which presence-detection alone can never catch. That's why
 * the UI needs a visible error surface rather than a button that silently
 * does nothing.
 */
export function mapSpeechError(error: string): VoiceErrorCode {
  switch (error) {
    case "no-speech":
      return "no-speech";
    case "aborted":
      return "aborted";
    case "not-allowed":
    case "service-not-allowed":
      return "permission-denied";
    case "audio-capture":
      return "no-microphone";
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

// Whether the controller should start a fresh recognition session after
// this error's onEnd fires. "never restart" here is what keeps a denied
// permission (or a missing speech endpoint) from becoming a hot restart
// loop — see the error table in the plan. no-speech restarts because it
// fires routinely (the user held the key before actually speaking) and is
// not itself a failure.
export function shouldRestartAfterError(code: VoiceErrorCode): boolean {
  return code === "no-speech";
}

// User-facing copy for each error code. permission-denied and no-microphone
// are the "never restart, tell the user clearly" cases; no-speech and
// aborted are swallowed entirely (return "" — no toast) since they're
// expected, not failures.
export function voiceErrorMessage(code: VoiceErrorCode): string {
  switch (code) {
    case "unsupported":
      return "Dictation isn't supported in this browser.";
    case "insecure-context":
      return "Dictation needs an https:// origin.";
    case "permission-denied":
      return "Microphone access denied — allow it in your browser's site settings.";
    case "no-microphone":
      return "No microphone found.";
    case "network":
      return "Speech service unreachable.";
    case "no-speech":
    case "aborted":
      return "";
    case "unknown":
    default:
      return "Dictation failed.";
  }
}
