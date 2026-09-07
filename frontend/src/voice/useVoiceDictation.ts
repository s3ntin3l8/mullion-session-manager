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

// How long a user-visible error toast stays up before clearing itself —
// mirrors TerminalPane.tsx's own uploadState === "error" toast timer.
const ERROR_DISPLAY_MS = 4_000;

// finalizeStop()/cancel() both transition to "stopping" and then wait for
// the provider's onEnd to actually confirm the session is done before
// finalize() runs — there is no other path back to "idle". If onEnd never
// fires (a browser bug, or the recognizer wedging after stop()/abort()),
// nothing else in this hook would ever recover, leaving the mic
// permanently in its "stopping"/pulsing-red state. Same class of hazard as
// pushClient.ts's SERVICE_WORKER_READY_TIMEOUT_MS ("has no built-in
// timeout — if registration failed, the promise never settles, and the
// toggle would stay stuck 'busy' forever"); this is that same fix applied
// to onEnd.
const STOP_WATCHDOG_MS = 5_000;

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
  /** Stops and inserts regardless of hold/latch state — for callers outside
   * the press/release gesture entirely (TerminalPane's blur/visibility
   * force-stop, armed whenever phase !== "idle"). Unlike release(), this
   * has no "only the matching gesture's release" guard: it's a safety net,
   * not part of the gesture protocol. No-ops when already idle. */
  forceStop: () => void;
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
  // Every startSession() call bumps this and captures the new value in its
  // own closure (see myGeneration below) — every one of that session's
  // onFinal/onInterim/onError/onEnd callbacks bails immediately if this no
  // longer matches, rather than acting on refs (sessionRef, bufferRef,
  // wantActiveRef, ...) that may by then belong to a DIFFERENT session.
  // Without this, a session the stop watchdog gave up on for being slow —
  // not dead, just slow — could still fire its real onEnd/onFinal
  // afterward: at best that's a harmless no-op against an idle hook, but if
  // a new dictation has since started, that stale onEnd stomps on the new
  // session's state (overwriting sessionRef with null, orphaning the new
  // recognizer with no UI control able to reach it anymore), and a stale
  // onFinal keeps appending into the shared bufferRef, interleaving
  // unrelated transcript text into whatever the new session captures.
  // Bumped in two places: startSession() (a genuinely new session
  // starting) and the stop watchdog (a session being given up on) — never
  // in cancel()/finalizeStop() themselves, which deliberately wait for
  // that SAME generation's real onEnd to arrive and finalize normally.
  const sessionGenerationRef = useRef(0);
  const maxSessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const clearStopWatchdog = useCallback(() => {
    if (stopWatchdogRef.current !== null) {
      clearTimeout(stopWatchdogRef.current);
      stopWatchdogRef.current = null;
    }
  }, []);

  // Sets a user-visible error and auto-dismisses it after ERROR_DISPLAY_MS
  // — same treatment as TerminalPane.tsx's own uploadState === "error"
  // toast. The permission-denied/no-microphone/network messages this is
  // used for are sticky in the sense that nothing else clears them sooner
  // (unlike a plain `no-speech`/`aborted`, which never call this at all —
  // see handleError below), but they still shouldn't sit forever once the
  // user has seen them.
  const setErrorWithTimer = useCallback((message: string) => {
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    setError(message);
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      setError(null);
    }, ERROR_DISPLAY_MS);
  }, []);

  // Clears an error immediately (a fresh press() starting a new dictation)
  // rather than waiting out ERROR_DISPLAY_MS — also cancels any pending
  // auto-dismiss timer so it can't later fire and clear a DIFFERENT error
  // this same press() might go on to set.
  const clearError = useCallback(() => {
    if (errorTimerRef.current !== null) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError(null);
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
  // happens here once onEnd actually confirms it has). Also the recovery
  // path when provider.start() throws synchronously (see startSession) and
  // when the stop watchdog below fires — both cases where onEnd will never
  // arrive on its own.
  const finalize = useCallback(() => {
    clearMaxSessionTimer();
    clearStopWatchdog();
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
  }, [clearMaxSessionTimer, clearStopWatchdog, setPhaseBoth]);

  // Arms a watchdog so a "stopping" phase (finalizeStop/cancel below) can't
  // get stuck forever if the provider's onEnd never fires — see
  // STOP_WATCHDOG_MS's own comment for why this exists at all. Cleared by
  // onEnd itself (the normal path) or by finalize() directly (belt and
  // suspenders — finalize() clears it unconditionally, whether reached via
  // onEnd or via this watchdog firing).
  const armStopWatchdog = useCallback(() => {
    clearStopWatchdog();
    stopWatchdogRef.current = setTimeout(() => {
      stopWatchdogRef.current = null;
      // Giving up on ever hearing back from this session — bump the
      // generation so its onEnd/onFinal/onError, if the engine was merely
      // slow rather than actually dead and they arrive after all, are
      // recognized as stale by the closures in startSession() below and
      // ignored, rather than corrupting whatever comes next (or, if
      // nothing comes next, spuriously inserting stray text the user has
      // already moved on from).
      sessionGenerationRef.current++;
      finalize();
    }, STOP_WATCHDOG_MS);
  }, [clearStopWatchdog, finalize]);

  const handleError = useCallback(
    (code: VoiceErrorCode) => {
      const message = voiceErrorMessage(code);
      if (message) setErrorWithTimer(message);
      if (!shouldRestartAfterError(code)) {
        terminalErrorRef.current = true;
        wantActiveRef.current = false;
      }
    },
    [setErrorWithTimer],
  );

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
    // Captured by every callback below so each can recognize when it no
    // longer belongs to the session useVoiceDictation is currently
    // tracking — see sessionGenerationRef's own comment for why this
    // exists at all (a watchdog-abandoned session's real callbacks firing
    // late must never touch state that may by then belong to a different
    // session).
    const myGeneration = ++sessionGenerationRef.current;
    const isCurrent = () => sessionGenerationRef.current === myGeneration;
    // provider.start() can throw synchronously — InvalidStateError on a
    // double-start, or an invalid `lang` value reaching the engine are both
    // real Web Speech failure modes, not hypothetical. Without this
    // try/catch, a throw here left phase stuck at "listening" with
    // sessionRef.current still null: every subsequent press()/release()/
    // cancel() call hits a guard that only acts on a phase transition (none
    // of which "listening with no session" is), and finalizeStop()'s own
    // `sessionRef.current?.stop()` is a silent no-op against null — nothing
    // would ever fire onEnd to bring it back to "idle". Route a throw
    // through the same handleError/finalize path as any other terminal
    // error instead.
    try {
      sessionRef.current = provider.start({
        lang: resolveLang(),
        onFinal: (segment) => {
          if (!isCurrent()) return;
          bufferRef.current.push(segment);
        },
        onInterim: (text) => {
          if (!isCurrent()) return;
          setInterimText(text);
        },
        onError: (code) => {
          if (!isCurrent()) return;
          handleError(code);
        },
        onEnd: () => {
          if (!isCurrent()) return;
          sessionRef.current = null;
          clearStopWatchdog();
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
              setErrorWithTimer(voiceErrorMessage("unknown"));
              finalize();
              return;
            }
            // Clears any interim text left over from the ending session —
            // the new engine instance's own onresult hasn't fired yet, so
            // without this a stale "hello wor…" chip would sit there,
            // unrelated to the fresh recognizer that's about to start,
            // until the first new result event overwrites it.
            setInterimText("");
            startSessionRef.current();
            return;
          }
          finalize();
        },
      });
    } catch {
      handleError("unknown");
      finalize();
    }
  }, [
    provider,
    resolveLang,
    handleError,
    finalize,
    setPhaseBoth,
    clearStopWatchdog,
    setErrorWithTimer,
  ]);

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
    // The utterance in progress is being cut off here, not finalized — any
    // interim text describing it is about to be stale for as long as
    // "stopping" lasts (VoiceMicButton's chip stays visible for any
    // phase !== "idle", not just "listening").
    setInterimText("");
    clearMaxSessionTimer();
    armStopWatchdog();
    sessionRef.current?.stop();
  }, [clearMaxSessionTimer, armStopWatchdog, setPhaseBoth]);

  const press = useCallback(() => {
    if (!enabledRef.current || !isSupported) return;
    if (!isSecureContext) {
      setErrorWithTimer(voiceErrorMessage("insecure-context"));
      return;
    }
    if (phaseRef.current === "idle") {
      bufferRef.current = [];
      discardRef.current = false;
      terminalErrorRef.current = false;
      restartTimestampsRef.current = [];
      clearError();
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
  }, [
    isSupported,
    isSecureContext,
    clearMaxSessionTimer,
    clearError,
    setErrorWithTimer,
    finalizeStop,
    startSession,
  ]);

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
    armStopWatchdog();
    sessionRef.current?.abort();
  }, [clearMaxSessionTimer, armStopWatchdog, setPhaseBoth]);

  // Stops and inserts regardless of hold/latch state — see the controller
  // interface's own doc comment on why this exists as a THIRD entry point
  // alongside press/release: release() only ever acts on the exact gesture
  // that started the current dictation (its own guard requires
  // phase === "listening" && !latched — see that function's comment), so a
  // TAPPED (latched) dictation has no way back to idle through release()
  // at all. finalizeStop() itself has no such restriction (it only checks
  // phase), which is what makes reusing it here — rather than duplicating
  // its logic — correct for both the held and the latched case.
  const forceStop = useCallback(() => {
    finalizeStop();
  }, [finalizeStop]);

  // Turning the feature off mid-dictation (Settings -> Terminal -> "Enable
  // dictation") must not leave a session running silently in the
  // background. `enabledRef` alone only gates the NEXT press()/release()
  // call (see those functions' own guards) — it does nothing to a
  // dictation that's already in progress, and the mic button unmounts the
  // instant `enabled` goes false (TerminalPane.tsx only renders it when
  // `terminal.voice.enabled` is true), removing the one remaining way to
  // stop or cancel it by hand. Left alone, MAX_SESSION_MS would eventually
  // force a *graceful* stop-and-insert up to two minutes later — a
  // surprise paste into the terminal for a feature the user just turned
  // off, the exact "misheard/interrupted dictation should never
  // surprise-insert" hazard VoiceMicButton.tsx's own pointercancel handler
  // is written to avoid. cancel() (discard), not forceStop() (insert): the
  // user disabled the feature, not merely stepped away from it.
  useEffect(() => {
    if (!opts.enabled && phaseRef.current !== "idle") cancel();
  }, [opts.enabled, cancel]);

  // Unmount: never leave a live recognizer running against an unmounted
  // pane, and never let its onEnd fire into stale refs afterward. Also
  // clears the stop watchdog and error-dismiss timer — both harmless if
  // they fired after unmount (they only ever touch refs/state on this
  // hook instance), but there's no reason to let them fire at all.
  useEffect(() => {
    return () => {
      // Invalidates the outgoing session's callbacks the same way the stop
      // watchdog does — an onFinal firing after unmount has no discardRef
      // guard of its own (only onEnd checks it), so without this it would
      // keep pushing into bufferRef on a hook instance nothing will ever
      // read from again. A deliberate read-and-increment of the CURRENT
      // ref value at cleanup time, not a captured one — the lint rule's
      // "stale by cleanup time" warning is for refs holding a rendered
      // node, not a plain mutable counter meant to be read live.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sessionGenerationRef.current++;
      clearMaxSessionTimer();
      clearStopWatchdog();
      if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
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
    forceStop,
  };
}
