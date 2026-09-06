import type { SpeechProvider, SpeechProviderCallbacks, SpeechSession } from "./types.js";
import { isSpeechDictationSupported, mapSpeechError } from "./support.js";

// TypeScript's lib.dom.d.ts (as of the version pinned in package.json) ships
// SpeechRecognitionEvent/SpeechRecognitionErrorEvent/SpeechRecognitionResult
// (List)/SpeechRecognitionAlternative/SpeechRecognitionErrorCode, but not the
// SpeechRecognition interface or constructor itself, nor the
// webkit-prefixed global Safari and Chrome actually expose it under. This is
// the minimal ambient shape this file needs — deliberately narrow (only the
// members actually used below), not a full spec-shaped typing.
interface MinimalSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface MinimalSpeechRecognitionConstructor {
  new (): MinimalSpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: MinimalSpeechRecognitionConstructor;
    webkitSpeechRecognition?: MinimalSpeechRecognitionConstructor;
  }
}

function getConstructor(): MinimalSpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

export const webSpeechProvider: SpeechProvider = {
  id: "web-speech",
  isSupported: isSpeechDictationSupported,
  start(opts: { lang: string } & SpeechProviderCallbacks): SpeechSession {
    const Ctor = getConstructor();
    if (!Ctor) {
      // Contract violation, not a runtime condition — callers (useVoiceDictation)
      // must have already checked isSupported()/isSpeechDictationSupported()
      // before calling start(). Fail loudly rather than silently no-op.
      throw new Error("webSpeechProvider.start() called without SpeechRecognition support");
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = opts.lang;

    // event.results is CUMULATIVE across the whole recognition session (a
    // real spec quirk, not a bug) — result[i] for i < resultIndex was
    // already reported on an earlier event. Iterating from resultIndex, not
    // 0, is what turns this into a delta stream; iterating from 0 would
    // re-emit every already-finalized segment on every single result event.
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          opts.onFinal(transcript);
        } else {
          interim += transcript;
        }
      }
      // Always called, even with "" — a final-only event (no interim text
      // left over after the loop above) must still clear out whatever
      // interim text a PRIOR event left displayed, or the chip shows stale
      // text ("hello wor...") after the segment it belonged to has already
      // been finalized and inserted into the buffer.
      opts.onInterim(interim);
    };
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      opts.onError(mapSpeechError(event.error));
    };
    // Fires on ANY termination — explicit stop()/abort(), a terminal error,
    // or Chrome's own auto-stop of a `continuous` session after a silence
    // window. useVoiceDictation is what decides whether to restart; this
    // provider only reports that listening has ended.
    recognition.onend = () => {
      opts.onEnd();
    };

    // Safe to call synchronously here because start() itself is called
    // synchronously from the caller's user-gesture handler (the contract
    // documented on SpeechProvider.start) — no await anywhere above this
    // line.
    recognition.start();

    return {
      stop: () => recognition.stop(),
      abort: () => recognition.abort(),
    };
  },
};
