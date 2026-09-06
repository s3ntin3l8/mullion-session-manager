// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoiceDictation } from "./useVoiceDictation.js";
import { HOLD_THRESHOLD_MS } from "./pushToTalk.js";
import type { SpeechProvider, SpeechProviderCallbacks, SpeechSession } from "./types.js";

// A hand-written fake standing in for webSpeechProvider, driven manually
// from each test so restart/error/timing edge cases are exercised
// deterministically rather than depending on a real SpeechRecognition
// instance's own (unmockable) internal timing. Each fake session is
// independent — a restart from useVoiceDictation calls provider.start()
// again, producing a NEW fake session, mirroring the real engine's own
// `results` array resetting to empty across a restart.
class FakeProvider implements SpeechProvider {
  readonly id = "fake";
  startCalls: FakeSession[] = [];
  supported = true;

  isSupported(): boolean {
    return this.supported;
  }

  start(opts: { lang: string } & SpeechProviderCallbacks): SpeechSession {
    const session = new FakeSession(opts);
    this.startCalls.push(session);
    return session;
  }
}

class FakeSession implements SpeechSession {
  constructor(private readonly callbacks: SpeechProviderCallbacks) {}
  stopped = false;
  aborted = false;

  final(segment: string): void {
    this.callbacks.onFinal(segment);
  }
  interim(text: string): void {
    this.callbacks.onInterim(text);
  }
  error(code: Parameters<SpeechProviderCallbacks["onError"]>[0]): void {
    this.callbacks.onError(code);
  }
  end(): void {
    this.callbacks.onEnd();
  }
  stop(): void {
    this.stopped = true;
  }
  abort(): void {
    this.aborted = true;
  }
}

describe("useVoiceDictation", () => {
  let provider: FakeProvider;
  let onInsert: ReturnType<typeof vi.fn<(text: string) => void>>;

  beforeEach(() => {
    provider = new FakeProvider();
    onInsert = vi.fn<(text: string) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<{ enabled: boolean; lang: string }> = {}) {
    return renderHook(() =>
      useVoiceDictation({
        enabled: overrides.enabled ?? true,
        lang: overrides.lang ?? "",
        onInsert,
        provider,
      }),
    );
  }

  it("hold-to-talk: press, speak, release after the hold threshold inserts once", () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.press());
    expect(provider.startCalls).toHaveLength(1);
    expect(result.current.phase).toBe("listening");

    const session = provider.startCalls[0];
    act(() => session.final("hello world"));

    act(() => vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 1));
    act(() => result.current.release());
    expect(result.current.phase).toBe("stopping");
    expect(session.stopped).toBe(true);
    expect(onInsert).not.toHaveBeenCalled(); // not yet — waiting on onEnd

    act(() => session.end());
    expect(onInsert).toHaveBeenCalledWith("hello world ");
    expect(result.current.phase).toBe("idle");
  });

  it("tap-to-latch: a quick release keeps listening; a second press stops and inserts", () => {
    const { result } = setup();

    act(() => result.current.press());
    const session = provider.startCalls[0];
    // Release immediately — well under the hold threshold — should latch,
    // not stop.
    act(() => result.current.release());
    expect(result.current.phase).toBe("listening");
    expect(session.stopped).toBe(false);

    act(() => session.final("add a test"));
    // Second tap: press() again while latched stops it.
    act(() => result.current.press());
    expect(session.stopped).toBe(true);

    act(() => session.end());
    expect(onInsert).toHaveBeenCalledWith("add a test ");
  });

  it("buffer survives an engine auto-restart mid-hold, and inserts everything on release (the single most valuable case)", () => {
    vi.useFakeTimers();
    const { result } = setup();

    act(() => result.current.press());
    const first = provider.startCalls[0];
    act(() => first.final("first half"));
    // Chrome's own auto-stop: onEnd fires with no prior error while the
    // user is still holding (wantActive true) — this must trigger a
    // restart, not a premature insert.
    act(() => first.end());
    expect(onInsert).not.toHaveBeenCalled();
    expect(provider.startCalls).toHaveLength(2);
    expect(result.current.phase).toBe("listening");

    const second = provider.startCalls[1];
    // The new engine instance's own results start fresh — proven here by
    // this being a BRAND NEW FakeSession with no memory of "first half".
    act(() => second.final("second half"));

    act(() => vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 1));
    act(() => result.current.release());
    act(() => second.end());

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith("first half second half ");
  });

  it("restart guard: no-speech restarts, but permission-denied stops for good and never restarts", () => {
    const { result } = setup();

    act(() => result.current.press());
    const first = provider.startCalls[0];
    act(() => first.error("no-speech"));
    act(() => first.end());
    // no-speech restarts.
    expect(provider.startCalls).toHaveLength(2);
    expect(onInsert).not.toHaveBeenCalled();

    const second = provider.startCalls[1];
    // FakeSession.error() takes an already-mapped VoiceErrorCode (the
    // provider contract's onError shape), not the raw
    // SpeechRecognitionErrorEvent.error string — the raw->code mapping
    // itself is support.test.ts's job, exercised on mapSpeechError directly.
    act(() => second.error("permission-denied"));
    expect(result.current.error).toMatch(/microphone access denied/i);
    act(() => second.end());

    // permission-denied must never restart — exactly 2 start() calls total.
    expect(provider.startCalls).toHaveLength(2);
    expect(result.current.phase).toBe("idle");
  });

  it("a final delivered after stop() but before onEnd still lands in the inserted text", () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.press());
    const session = provider.startCalls[0];
    // A hold long enough to classify as "stop" on release, deterministic
    // via fake timers rather than however fast this test happens to run.
    act(() => vi.advanceTimersByTime(HOLD_THRESHOLD_MS + 1));
    act(() => result.current.release());
    expect(result.current.phase).toBe("stopping");
    expect(session.stopped).toBe(true);

    // Chrome flushes any pending final result between stop() and onend —
    // this must still be captured, not dropped because stop() was already
    // called.
    act(() => session.final("trailing word"));
    act(() => session.end());

    expect(onInsert).toHaveBeenCalledWith("trailing word ");
  });

  it("cancel() discards the buffer instead of inserting it", () => {
    const { result } = setup();
    act(() => result.current.press());
    const session = provider.startCalls[0];
    act(() => session.final("never mind"));

    act(() => result.current.cancel());
    expect(session.aborted).toBe(true);

    act(() => session.end());
    expect(onInsert).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.interimText).toBe("");
  });

  it("interim text is exposed live and cleared once finalized", () => {
    const { result } = setup();
    act(() => result.current.press());
    const session = provider.startCalls[0];

    act(() => session.interim("hello wor"));
    expect(result.current.interimText).toBe("hello wor");

    act(() => session.final("hello world"));
    // The provider always reports the remaining interim (possibly "")
    // alongside a final — simulate that here.
    act(() => session.interim(""));
    expect(result.current.interimText).toBe("");
  });

  it("press() is a no-op when disabled", () => {
    const { result } = setup({ enabled: false });
    act(() => result.current.press());
    expect(provider.startCalls).toHaveLength(0);
    expect(result.current.phase).toBe("idle");
  });

  it("press() surfaces an insecure-context error and never starts the provider", () => {
    // isSecureContext is captured once at mount via
    // isSecureContextForDictation() reading window.isSecureContext.
    const original = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      const { result } = setup();
      act(() => result.current.press());
      expect(provider.startCalls).toHaveLength(0);
      expect(result.current.error).toMatch(/https/i);
    } finally {
      if (original) Object.defineProperty(window, "isSecureContext", original);
    }
  });

  it("unmount aborts an in-progress session and does not insert", () => {
    const { result, unmount } = setup();
    act(() => result.current.press());
    const session = provider.startCalls[0];
    act(() => session.final("mid dictation"));

    unmount();
    expect(session.aborted).toBe(true);

    // A late onEnd firing after unmount must not throw or call onInsert —
    // the hook's cleanup already set discardRef before this fires.
    expect(() => session.end()).not.toThrow();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
