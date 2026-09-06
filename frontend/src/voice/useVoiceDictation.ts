import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeechProvider, VoiceErrorCode } from "./types.js";
import { webSpeechProvider } from "./webSpeechProvider.js";
import { formatForPaste } from "./transcript.js";
import { resolveRelease } from "./pushToTalk.js";
import {
  isSecureContextForDictation,
  shouldRestartAfterError,
  voiceErrorMessage,
} from "./support.js";

// Chrome ends a `continuous` recognition session after a silence window
// regardless of caller intent. If that keeps happening in a tight loop
// (misconfigured backend, a browser that never actually starts capturing)
// this is what stops the restart from becoming a hot loop: more than
// MAX_RESTARTS_PER_WINDOW restarts inside RESTART_WINDOW_MS gives up
// instead of restarting again.
const RESTART_WINDOW_MS = 1000;
const MAX_RESTARTS_PER_WINDOW = 3;

// Hard cap on one dictation's total listening time, across any number of
// engine auto-restarts — a safety net independent of the restart guard
// above (that guard only catches *rapid* restarts; a session that restarts
// cleanly every ~10s on Chrome's own silence timeout would never trip it,
// but should still not run forever). Force-stops gracefully (inserts
// whatever was said so far) rather than discarding.
const MAX_SESSION_MS = 120_000;

export type VoiceDictationPhase = "idle" | "listening" | "stopping";

export interface UseVoiceDictationOptions {
  /** terminal.voice.enabled — when false, press()/release() are no-ops. */
  enabled: boolean;
  /** terminal.voice.lang. Empty string falls back to navigator.language. */
  lang: string;
  /** Called once per completed dictation with the joined, trailing-spaced
   * transcript (see transcript.ts's formatForPaste) — never called with an
   * empty string. The caller is responsible for the actual insertion
   * (TerminalPane's pasteToTerminal) and any refocus. */
  onInsert: (text: string) => void;
  /** Swappable for tests; defaults to the real Web Speech implementation. */
  provider?: SpeechProvider;
}

export interface VoiceDictationController {
  phase: VoiceDictationPhase;
  /** Live, not-yet-finalized text for the utterance in progress. */
  interimText: string;
  /** Current user-visible error, or null. Cleared at the start of the next
   * press(). */
  error: string | null;
  isSupported: boolean;
  isSecureContext: boolean;
  /** Start listening (first press) or, if already latched from a prior
   * quick tap, stop and insert (second tap). */
  press: () => void;
  /** Ends the press-hold gesture. Stops and inserts if the hold exceeded
   * the push-to-talk threshold; otherwise latches on and keeps listening
   * until the next press()/cancel(). */
  release: () => void;
  /** Discards the in-progress dictation instead of inserting it. */
  cancel: () => void;
}

export function useVoiceDictation(opts: UseVoiceDictationOptions): VoiceDictationController {
  const provider = opts.provider ?? webSpeechProvider;
  const [isSupported] = useState(() => provider.isSupported());
  const [isSecureContext] = useState(() => isSecureContextForDictation());

  const [phase, setPhase] = useState<VoiceDictationPhase>("idle");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Control-flow state lives in refs, not the state above — every callback
  // below (provider onEnd/onError, press/release/cancel) must read the
  // CURRENT value synchronously, including from inside a provider callback
  // fired well after the render that scheduled it. The state variables
  // above exist purely to drive re-renders for the UI; phaseRef is the
  // source of truth every guard below actually checks.
  const phaseRef = useRef<VoiceDictationPhase>("idle");
  const bufferRef = useRef<string[]>([]);
  const sessionRef = useRef<ReturnType<SpeechProvider["start"]> | null>(null);
  const wantActiveRef = useRef(false);
  // True only while the current tap-to-latch dictation is listening between
  // a short release() and the next press()/cancel() — distinguishes "this
  // press is the start of a new dictation" from "this press is the second
  // tap that stops an already-latched one". See press()'s own comment.
  const latchedRef = useRef(false);
  // Set by cancel(); read by the provider's onEnd handler to discard the
  // buffer instead of inserting it.
  const discardRef = useRef(false);
  // Set by onError for a "never restart" code (permission-denied,
  // no-microphone, network, unknown) — blocks the onEnd restart branch
  // even though wantActiveRef may still be true. Reset at the start of
  // every new dictation.
  const terminalErrorRef = useRef(false);
  const pressStartedAtRef = useRef(0);
  const restartTimestampsRef = useRef<number[]>([]);
  const maxSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const langRef = useRef(opts.lang);
  const onInsertRef = useRef(opts.onInsert);
  const enabledRef = useRef(opts.enabled);
  // Assigned via a dep-less effect (runs after every render), not a plain
  // assignment during render — this repo lints under the react-hooks/refs
  // rule, which forbids writing ref.current during render (only event
  // handlers/effects may). Same pattern as TerminalPane.tsx's
  // onTitleChangeRef.
  useEffect(() => {
    langRef.current = opts.lang;
    onInsertRef.current = opts.onInsert;
    enabledRef.current = opts.enabled;
  });

  const setPhaseBoth = useCallback((next: VoiceDictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearMaxSessionTimer = useCallback(() => {
    if (maxSessionTimerRef.current !== null) {
      clearTimeout(maxSessionTimerRef.current);
      maxSessionTimerRef.current = null;
    }
  }, []);

  const resolveLang = useCallback((): string => {
    const configured = langRef.current.trim();
    if (configured) return configured;
    if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
    return "en-US";
  }, []);

  // Ends the current dictation for good: clears the session/timer, and —
  // unless discarded via cancel() — inserts whatever was buffered. Called
  // from the provider's onEnd handler, never directly by press/release
  // (see finalizeStop, which only asks the session to stop; insertion
  // happens here once onEnd actually confirms it has).
  const finalize = useCallback(() => {
    clearMaxSessionTimer();
    sessionRef.current = null;
    const discard = discardRef.current;
    discardRef.current = false;
    wantActiveRef.current = false;
    latchedRef.current = false;
    const segments = bufferRef.current;
    bufferRef.current = [];
    setInterimText("");
    setPhaseBoth("idle");
    if (discard) return;
    const text = formatForPaste(segments);
    if (text) onInsertRef.current(text);
  }, [clearMaxSessionTimer, setPhaseBoth]);

  const handleError = useCallback((code: VoiceErrorCode) => {
    const message = voiceErrorMessage(code);
    if (message) setError(message);
    if (!shouldRestartAfterError(code)) {
      terminalErrorRef.current = true;
      wantActiveRef.current = false;
    }
  }, []);

  // Holds the latest startSession identity so onEnd below can restart
  // recursively without referencing the `const startSession` binding
  // directly — a genuine self-reference works fine at runtime (by the time
  // onEnd actually fires, startSession is long since assigned), but this
  // repo's lint config flags a callback referencing its own not-yet-declared
  // binding as "accessed before declared," since the linter can't otherwise
  // tell the reference will only ever be invoked later, not during this
  // render. Assigned via the same dep-less-effect pattern as
  // langRef/onInsertRef/enabledRef above.
  const startSessionRef = useRef<() => void>(() => {});

  const startSession = useCallback(() => {
    setPhaseBoth("listening");
    sessionRef.current = provider.start({
      lang: resolveLang(),
      onFinal: (segment) => {
        bufferRef.current.push(segment);
      },
      onInterim: (text) => setInterimText(text),
      onError: handleError,
      onEnd: () => {
        sessionRef.current = null;
        if (discardRef.current) {
          finalize();
          return;
        }
        if (wantActiveRef.current && !terminalErrorRef.current) {
          const now = Date.now();
          restartTimestampsRef.current = restartTimestampsRef.current.filter(
            (t) => now - t < RESTART_WINDOW_MS,
          );
          restartTimestampsRef.current.push(now);
          if (restartTimestampsRef.current.length > MAX_RESTARTS_PER_WINDOW) {
            terminalErrorRef.current = true;
            setError(voiceErrorMessage("unknown"));
            finalize();
            return;
          }
          startSessionRef.current();
          return;
        }
        finalize();
      },
    });
  }, [provider, resolveLang, handleError, finalize, setPhaseBoth]);

  useEffect(() => {
    startSessionRef.current = startSession;
  });

  // Graceful stop: asks the active session to stop, which eventually fires
  // onEnd -> finalize() above. Never inserts directly — insertion only
  // happens once the provider actually confirms it has stopped listening
  // (Chrome flushes any pending final result between stop() and onend; a
  // synchronous insert here would truncate that last utterance).
  const finalizeStop = useCallback(() => {
    if (phaseRef.current !== "listening") return;
    wantActiveRef.current = false;
    setPhaseBoth("stopping");
    clearMaxSessionTimer();
    sessionRef.current?.stop();
  }, [clearMaxSessionTimer, setPhaseBoth]);

  const press = useCallback(() => {
    if (!enabledRef.current || !isSupported) return;
    if (!isSecureContext) {
      setError(voiceErrorMessage("insecure-context"));
      return;
    }
    if (phaseRef.current === "idle") {
      bufferRef.current = [];
      discardRef.current = false;
      terminalErrorRef.current = false;
      restartTimestampsRef.current = [];
      setError(null);
      setInterimText("");
      pressStartedAtRef.current = Date.now();
      latchedRef.current = false;
      wantActiveRef.current = true;
      clearMaxSessionTimer();
      maxSessionTimerRef.current = setTimeout(() => finalizeStop(), MAX_SESSION_MS);
      startSession();
      return;
    }
    if (phaseRef.current === "listening" && latchedRef.current) {
      // Second tap of a tap-to-latch dictation: stop and insert.
      finalizeStop();
    }
    // Otherwise (mid-hold repeat, or already stopping): ignore.
  }, [isSupported, isSecureContext, clearMaxSessionTimer, finalizeStop, startSession]);

  const release = useCallback(() => {
    // Only the release that matches the initial press-and-hold gesture
    // reaches here — a release following the "second tap" branch in press()
    // above finds phase already "stopping" (or a latched dictation, handled
    // by that branch, not this one) and is correctly a no-op.
    if (phaseRef.current !== "listening" || latchedRef.current) return;
    const action = resolveRelease(pressStartedAtRef.current, Date.now());
    if (action === "stop") {
      finalizeStop();
    } else {
      latchedRef.current = true;
    }
  }, [finalizeStop]);

  const cancel = useCallback(() => {
    if (phaseRef.current === "idle") return;
    wantActiveRef.current = false;
    discardRef.current = true;
    setPhaseBoth("stopping");
    clearMaxSessionTimer();
    sessionRef.current?.abort();
  }, [clearMaxSessionTimer, setPhaseBoth]);

  // Unmount: never leave a live recognizer running against an unmounted
  // pane, and never let its onEnd fire into stale refs afterward.
  useEffect(() => {
    return () => {
      clearMaxSessionTimer();
      discardRef.current = true;
      wantActiveRef.current = false;
      sessionRef.current?.abort();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    phase,
    interimText,
    error,
    isSupported,
    isSecureContext,
    press,
    release,
    cancel,
  };
}
