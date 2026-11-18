// @vitest-environment jsdom
// Voice dictation: the hotkey's wiring to the recognizer, a completed
// dictation's paste, and the coarse-pointer case where the mic moves into
// the key bar.
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// IMPORT ORDER MATTERS: the mocks module is imported BEFORE the harness.
// Vitest evaluates a test file's imports in order, and the harness pulls in
// the mocked modules (TerminalPane -> @xterm/xterm), whose vi.mock factories
// call back into the mocks module — so the mocks module has to be evaluated
// (and its exports initialized) first. See
// frontend/src/test/terminal-pane-mocks.ts's own header comment.
import {
  mockApiFactory,
  mockRepaintRegistryFactory,
  mockInputRegistryFactory,
  mockXtermFactory,
  mockFitAddonFactory,
  mockWebglAddonFactory,
  mockUnicode11AddonFactory,
  mockSearchAddonFactory,
} from "./test/terminal-pane-mocks.js";

import { renderHook, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import { useVoiceControls } from "./lib/terminalVoiceRegistry.js";
import {
  renderPane,
  stubFakeWebSocket,
  getLatestTermInstance,
  setupTerminalPaneTestLifecycle,
} from "./test/terminal-pane-harness.js";

vi.mock("./api/index.js", () => mockApiFactory());
vi.mock("./terminalRepaintRegistry.js", () => mockRepaintRegistryFactory());
vi.mock("./terminalInputRegistry.js", () => mockInputRegistryFactory());
vi.mock("@xterm/xterm", () => mockXtermFactory());
vi.mock("@xterm/addon-fit", () => mockFitAddonFactory());
vi.mock("@xterm/addon-webgl", () => mockWebglAddonFactory());
vi.mock("@xterm/addon-unicode11", () => mockUnicode11AddonFactory());
vi.mock("@xterm/addon-search", () => mockSearchAddonFactory());

setupTerminalPaneTestLifecycle();

describe("TerminalPane voice dictation", () => {
  // Minimal fake, tracked by instance so a test can drive its
  // onresult/onend callbacks directly — the full restart/error/timing
  // state machine is exercised exhaustively at the hook level
  // (voice/useVoiceDictation.test.ts); what's worth covering here is only
  // the WIRING: the hotkey reaches useVoiceDictation's press()/release(),
  // and a completed dictation reaches term.paste (not term.input), with a
  // refocus.
  class FakeSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      fakeRecognitionInstances.push(this);
    }
  }
  let fakeRecognitionInstances: FakeSpeechRecognition[];

  beforeEach(() => {
    fakeRecognitionInstances = [];
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
  });

  afterEach(() => {
    delete (window as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  function latestRecognition(): FakeSpeechRecognition {
    return fakeRecognitionInstances[fakeRecognitionInstances.length - 1]!;
  }

  // A single final SpeechRecognitionResult-shaped entry: an array whose
  // index [0] is the top alternative (webSpeechProvider.ts reads
  // result[0]?.transcript) with an extra own `isFinal` property
  // (result.isFinal) — mirroring the real SpeechRecognitionResult shape
  // closely enough for the provider's own reader to work unmodified.
  function makeFinalResult(transcript: string) {
    return Object.assign([{ transcript }], { isFinal: true });
  }

  function fireFinal(recognition: FakeSpeechRecognition, transcript: string) {
    act(() => {
      recognition.onresult?.({
        resultIndex: 0,
        results: [makeFinalResult(transcript)],
      });
    });
  }

  // Fires the voice chord's keydown/keyup pair attachKeyConflictHandler and
  // TerminalPane's own window keyup listener are wired to — see
  // terminalKeys.ts's chord branch and TerminalPane.tsx's
  // voiceHotkeyPressRef/onVoiceHotkeyKeyup for the two halves. Defaults to
  // the shipped Ctrl+Shift+Space chord; a test that rebinds the hotkey via
  // settings passes the new one explicitly (#1119).
  function pressVoiceHotkey(
    chord: {
      code: string;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    } = {
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    },
  ) {
    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() => {
      handler({
        type: "keydown",
        key: chord.code,
        code: chord.code,
        ctrlKey: chord.ctrlKey ?? false,
        shiftKey: chord.shiftKey ?? false,
        metaKey: chord.metaKey ?? false,
        altKey: chord.altKey ?? false,
        repeat: false,
        preventDefault: vi.fn(),
      });
    });
  }

  function releaseVoiceHotkey(code = "Space") {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code }));
    });
  }

  it("swallows Ctrl+Shift+Space and starts recognition when the voice hotkey is enabled", () => {
    stubFakeWebSocket(true);
    renderPane();

    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    const preventDefault = vi.fn();
    let result = true;
    act(() => {
      result = handler({
        type: "keydown",
        key: " ",
        code: "Space",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault,
      }) as boolean;
    });

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(fakeRecognitionInstances).toHaveLength(1);
    expect(latestRecognition().start).toHaveBeenCalledTimes(1);
  });

  it("does not start recognition on Ctrl+Shift+Space when the hotkey setting is off", () => {
    stubFakeWebSocket(true);
    renderPane();
    // Patched AFTER renderPane() (not before) since renderPane() itself
    // unconditionally overwrites the whole settings object — the
    // settings-sync effect's own [terminalSettings] dep is what re-attaches
    // the key handler with the updated getVoiceChord getter.
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            voice: { ...s.settings.terminal.voice, hotkeyEnabled: false },
          },
        },
      }));
    });

    const term = getLatestTermInstance();
    const calls = term.attachCustomKeyEventHandler.mock.calls;
    const handler = calls[calls.length - 1]![0] as (event: unknown) => boolean;
    act(() =>
      handler({
        type: "keydown",
        key: " ",
        code: "Space",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
        repeat: false,
        preventDefault: vi.fn(),
      }),
    );

    expect(fakeRecognitionInstances).toHaveLength(0);
  });

  it("a rebound hotkey (#1119) starts on its own chord and releases on its own code, not the old default's", () => {
    stubFakeWebSocket(true);
    renderPane();
    // Patched AFTER renderPane() for the same reason as the test above —
    // the settings-sync effect's [terminalSettings] dep is what re-attaches
    // the key handler (and re-parses voiceChordRef) with the new chord.
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            voice: { ...s.settings.terminal.voice, hotkey: "Ctrl+Shift+Comma" },
          },
        },
      }));
    });

    // The OLD default chord must no longer start dictation at all.
    pressVoiceHotkey({ code: "Space", ctrlKey: true, shiftKey: true });
    expect(fakeRecognitionInstances).toHaveLength(0);

    // The rebound chord starts it.
    pressVoiceHotkey({ code: "Comma", ctrlKey: true, shiftKey: true });
    expect(fakeRecognitionInstances).toHaveLength(1);
    const recognition = latestRecognition();
    expect(recognition.start).toHaveBeenCalledTimes(1);

    // A keyup for the OLD default's code must be a complete no-op — the
    // held code is captured at press time (TerminalPane.tsx's
    // voiceHotkeyHeldCode) and stays armed only for "Comma", so this must
    // not even count as the release that lets a later real release fire.
    releaseVoiceHotkey("Space");
    expect(recognition.stop).not.toHaveBeenCalled();

    // The configured code's keyup IS the real release — quick, so it
    // latches rather than stops (same threshold classification as the
    // tap-to-latch test below), proving onVoiceHotkeyKeyup matched it.
    releaseVoiceHotkey("Comma");
    expect(recognition.stop).not.toHaveBeenCalled(); // latched, not stopped

    // Second press on the same rebound chord is what actually stops a
    // latched dictation — confirms the tap-tap wiring still works with a
    // non-default chord end to end.
    pressVoiceHotkey({ code: "Comma", ctrlKey: true, shiftKey: true });
    expect(recognition.stop).toHaveBeenCalledTimes(1);
  });

  it("a completed tap-to-latch dictation calls term.paste once (not term.input), and refocuses the terminal", async () => {
    // Deliberately tap-to-latch, not hold-then-release: a real hold's
    // release is classified by elapsed wall-clock time against
    // pushToTalk.ts's HOLD_THRESHOLD_MS, which a synchronous test can't
    // reliably land on either side of without fake timers (and fake timers
    // don't mix cleanly with this file's real waitFor below). A quick
    // keydown->keyup->keydown sequence exercises the same
    // press/release/finalize wiring deterministically: two real-time-close
    // events always classify as "latch," so the SECOND press is what stops
    // and inserts, exactly like a physical tap-tap.
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();
    term.focus.mockClear();

    pressVoiceHotkey();
    expect(fakeRecognitionInstances).toHaveLength(1);
    const recognition = latestRecognition();

    releaseVoiceHotkey();
    expect(recognition.stop).not.toHaveBeenCalled(); // latched, not stopped

    fireFinal(recognition, "add a test for the parser");

    pressVoiceHotkey(); // second tap: stops and inserts
    expect(recognition.stop).toHaveBeenCalledTimes(1);

    act(() => recognition.onend?.());

    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith("add a test for the parser ");
    });
    expect(term.input).not.toHaveBeenCalledWith("add a test for the parser ");
    expect(term.focus).toHaveBeenCalled();
  });

  it("backgrounding the tab force-stops a TAPPED (latched) dictation and still inserts it — release() alone can't reach a latched dictation", async () => {
    // The gap this covers: a tap-to-latch dictation (started from the mic
    // button, not a held hotkey) has no "hold" for a keyup/blur pair tied
    // to the hotkey wiring to ever see — TerminalPane's own phase-driven
    // blur/visibilitychange/pagehide effect (not the hotkey-hold-specific
    // keyup listener) is what has to catch this, regardless of which
    // gesture started the dictation. Driven via the hotkey here purely
    // because pressVoiceHotkey()/releaseVoiceHotkey() are the test
    // helpers already in this file; the mic button reaches the same
    // press()/release() calls on the same controller.
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();

    pressVoiceHotkey();
    const recognition = latestRecognition();
    releaseVoiceHotkey(); // quick release -> latches, does not stop
    expect(recognition.stop).not.toHaveBeenCalled();

    fireFinal(recognition, "dictated while the tab was backgrounded");

    act(() => window.dispatchEvent(new Event("blur")));
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    expect(recognition.abort).not.toHaveBeenCalled(); // force-stop inserts, never discards

    act(() => recognition.onend?.());

    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith("dictated while the tab was backgrounded ");
    });
  });

  it("turning off 'Enable dictation' mid-hold aborts the recognizer and discards the buffer — never inserts", async () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance();

    pressVoiceHotkey();
    const recognition = latestRecognition();
    fireFinal(recognition, "should never reach the prompt");

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: {
            ...s.settings.terminal,
            voice: { ...s.settings.terminal.voice, enabled: false },
          },
        },
      }));
    });

    expect(recognition.abort).toHaveBeenCalledTimes(1);
    act(() => recognition.onend?.());

    expect(term.paste).not.toHaveBeenCalledWith(
      expect.stringContaining("should never reach the prompt"),
    );
    // The mic button unmounts along with it — nothing left visible to
    // interact with.
    expect(screen.queryByRole("button", { name: /dictation/i })).not.toBeInTheDocument();
  });
});

describe("TerminalPane voice mic on a coarse pointer (moves into the key bar)", () => {
  class FakeSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
  }

  beforeEach(() => {
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    delete (window as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it("publishes its controls for the key bar instead of rendering the floating mic", () => {
    stubFakeWebSocket(true);
    const { unmount } = renderPane();
    expect(document.querySelector(".terminal-voice-btn")).toBeNull();

    const { result } = renderHook(() => useVoiceControls(1));
    expect(result.current).toBeDefined();
    expect(result.current!.phase).toBe("idle");
    act(() => result.current!.press());
    expect(result.current!.phase).toBe("listening");
    act(() => result.current!.cancel());

    unmount();
    expect(result.current).toBeUndefined();
  });
});
