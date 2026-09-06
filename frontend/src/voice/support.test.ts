import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isSpeechDictationSupported,
  isSecureContextForDictation,
  mapSpeechError,
  shouldRestartAfterError,
  voiceErrorMessage,
} from "./support.js";
import type { VoiceErrorCode } from "./types.js";

// Model: pushClient.test.ts's isPushSupported suite (vi.stubGlobal +
// vi.unstubAllGlobals, one assertion per combination).
describe("isSpeechDictationSupported", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("true when SpeechRecognition is present", () => {
    vi.stubGlobal("window", { SpeechRecognition: class {} });
    expect(isSpeechDictationSupported()).toBe(true);
  });

  it("true when only the webkit-prefixed constructor is present (Chrome/Safari)", () => {
    vi.stubGlobal("window", { webkitSpeechRecognition: class {} });
    expect(isSpeechDictationSupported()).toBe(true);
  });

  it("false when neither constructor is present (Firefox)", () => {
    vi.stubGlobal("window", {});
    expect(isSpeechDictationSupported()).toBe(false);
  });
});

describe("isSecureContextForDictation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("true when window.isSecureContext is true", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    expect(isSecureContextForDictation()).toBe(true);
  });

  it("false when window.isSecureContext is false (plain-http LAN deploy)", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(isSecureContextForDictation()).toBe(false);
  });

  it("is independent of isSpeechDictationSupported — presence and secure context are separate gates", () => {
    // webkitSpeechRecognition IS present on an insecure origin; only the
    // secure-context check should say no here.
    vi.stubGlobal("window", { webkitSpeechRecognition: class {}, isSecureContext: false });
    expect(isSpeechDictationSupported()).toBe(true);
    expect(isSecureContextForDictation()).toBe(false);
  });
});

// Table-driven: every SpeechRecognitionErrorEvent.error string this app
// handles, mapped to our code, its restart decision, and its message.
const ERROR_CASES: Array<{
  raw: string;
  code: VoiceErrorCode;
  restart: boolean;
  hasMessage: boolean;
}> = [
  { raw: "no-speech", code: "no-speech", restart: true, hasMessage: false },
  { raw: "aborted", code: "aborted", restart: false, hasMessage: false },
  { raw: "not-allowed", code: "permission-denied", restart: false, hasMessage: true },
  { raw: "service-not-allowed", code: "permission-denied", restart: false, hasMessage: true },
  { raw: "audio-capture", code: "no-microphone", restart: false, hasMessage: true },
  { raw: "network", code: "network", restart: false, hasMessage: true },
  { raw: "language-not-supported", code: "unknown", restart: false, hasMessage: true },
];

describe("mapSpeechError / shouldRestartAfterError / voiceErrorMessage", () => {
  it.each(ERROR_CASES)(
    "maps '$raw' -> $code (restart: $restart)",
    ({ raw, code, restart, hasMessage }) => {
      const mapped = mapSpeechError(raw);
      expect(mapped).toBe(code);
      expect(shouldRestartAfterError(mapped)).toBe(restart);
      expect(voiceErrorMessage(mapped).length > 0).toBe(hasMessage);
    },
  );

  it("never restarts on permission-denied or no-microphone even if raw errors differ", () => {
    expect(shouldRestartAfterError("permission-denied")).toBe(false);
    expect(shouldRestartAfterError("no-microphone")).toBe(false);
  });
});
