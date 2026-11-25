// @vitest-environment jsdom
// The OSC surface: the 10/11 colour push on a theme change, the
// 10/11/12 query responder, the query replies guarded during a scrollback
// replay, and the OSC 52 clipboard write.
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi } from "vitest";

// IMPORT ORDER MATTERS: the mocks module is imported BEFORE the harness.
// Vitest evaluates a test file's imports in order, and the harness pulls in
// the mocked modules (TerminalPane -> @xterm/xterm), whose vi.mock factories
// call back into the mocks module — so the mocks module has to be evaluated
// (and its exports initialized) first. See
// frontend/src/test/terminal-pane-mocks.ts's own header comment.
import {
  oscHandlers,
  csiHandlers,
  dcsHandlers,
  mockApiFactory,
  mockRepaintRegistryFactory,
  mockInputRegistryFactory,
  mockXtermFactory,
  mockFitAddonFactory,
  mockWebglAddonFactory,
  mockUnicode11AddonFactory,
  mockSearchAddonFactory,
} from "./test/terminal-pane-mocks.js";

import { waitFor } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import type { ResolvedTheme } from "./store/index.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  fakeWsSend,
  getLatestTermInstance,
  decodedOscSends,
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

describe("TerminalPane OSC push", () => {
  it("sends OSC 10/11 bytes on theme toggle when socket is OPEN", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState({ theme: "light" as ResolvedTheme });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does NOT send when socket is CLOSED, but sends on open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    // act() here (rather than a bare setState) forces the settings-sync
    // effect to flush before the next line — without it, the effect that
    // queues the OSC bytes into pendingOscRef hasn't necessarily run yet by
    // the time the socket's "open" handler is fired manually below, so the
    // drain would find nothing queued and silently no-op.
    act(() => {
      useDashboardStore.setState({ theme: "light" as ResolvedTheme });
    });

    expect(fakeWsSend).not.toHaveBeenCalled();

    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    // The open handler also fires a resize send (component's own
    // sendResizeIfOpen), so the OSC push isn't necessarily the first call —
    // scan every send for the one matching the OSC 10/11 format.
    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });

    // Toggle back to dark — prevThemeRef was advanced when the queued bytes
    // were stored, so this correctly detects a new change and sends again.
    fakeWsSend.mockClear();
    act(() => {
      useDashboardStore.setState({ theme: "dark" as ResolvedTheme });
    });

    await waitFor(() => {
      expect(decodedOscSends().length).toBeGreaterThan(0);
    });
  });

  it("does not send on unrelated pref changes (cursor blink)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState((s) => ({
      settings: { ...s.settings, terminal: { ...s.settings.terminal, cursorBlink: false } },
    }));

    await vi.waitFor(() => {
      expect(fakeWsSend).not.toHaveBeenCalled();
    });
  });

  it("appends the DEC 997 notification matching the resolved mode (issue #99)", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    useDashboardStore.setState({ theme: "light" as ResolvedTheme });
    await waitFor(() => {
      expect(decodedOscSends().some((s) => s.endsWith("\x1b[?997;2n"))).toBe(true);
    });

    fakeWsSend.mockClear();
    useDashboardStore.setState({ theme: "dark" as ResolvedTheme });
    await waitFor(() => {
      expect(decodedOscSends().some((s) => s.endsWith("\x1b[?997;1n"))).toBe(true);
    });
  });
});

describe("TerminalPane OSC 10/11/12 query responder (issue #91)", () => {
  // Every send is a raw byte payload here (unlike decodedOscSends() above,
  // which filters for the `#rrggbb` SET-push format) — decode all of them.
  function decodedSends(): string[] {
    return fakeWsSend.mock.calls
      .map((call) => call[0] as unknown)
      .filter((arg): arg is ArrayBufferView => ArrayBuffer.isView(arg))
      .map((bytes) => new TextDecoder().decode(bytes));
  }

  it("answers an OSC 11 background query with the live scheme's background, rgb: doubled-hex form", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    // Mullion Dark's dark background is #0d0d0d (terminalSchemes.ts).
    expect(decodedSends()).toContain("\x1b]11;rgb:0d0d/0d0d/0d0d\x07");
  });

  it("answers OSC 10 (foreground) and OSC 12 (cursor) queries too", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    oscHandlers.get(10)!("?");
    oscHandlers.get(12)!("?");

    // Mullion Dark's dark foreground/cursor is #ededed.
    expect(decodedSends()).toContain("\x1b]10;rgb:eded/eded/eded\x07");
    expect(decodedSends()).toContain("\x1b]12;rgb:eded/eded/eded\x07");
  });

  it("does not answer (and reports unhandled) a non-query OSC 11 payload, leaving it for xterm's own SET handling", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("#112233");

    expect(handled).toBe(false);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });

  it("swallows the query without sending when the socket isn't open", async () => {
    stubFakeWebSocket(false);
    renderPane();

    const handled = oscHandlers.get(11)!("?");

    expect(handled).toBe(true);
    expect(fakeWsSend).not.toHaveBeenCalled();
  });

  it("still answers an OSC 11 query during replay (before the first geometry frame)", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(11)!("?");

    // Codex fixes its palette from the reply it gets shortly after launch, so
    // a query still in the backlog must not be dropped on the floor.
    expect(handled).toBe(true);
    expect(decodedSends()).toContain("\x1b]11;rgb:0d0d/0d0d/0d0d\x07");
  });
});

describe("TerminalPane terminal query replies during scrollback replay", () => {
  function sendGeometryFrame(): void {
    for (const handler of fakeSocket._messageHandlers) {
      handler({
        data: JSON.stringify({ type: "geometry", cols: 80, rows: 24, minCols: 40, minRows: 10 }),
      });
    }
  }

  const QUERY_KEYS = ["n", "?n", ">c", "$p", "?$p"];

  it("registers a handler for every guarded query family", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    for (const key of QUERY_KEYS) expect(csiHandlers.has(key)).toBe(true);
  });

  it("leaves DA1 unguarded (so xterm's reply falls through during replay) but guards DA2", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    expect(csiHandlers.has("c")).toBe(false);
    expect(csiHandlers.has(">c")).toBe(true);
  });

  it("swallows CPR/DSR/DA2/DECRQM queries replayed before the first geometry frame", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    for (const key of QUERY_KEYS) expect(csiHandlers.get(key)!()).toBe(true);
  });

  it("swallows a replayed DECRQSS and lets a live one through", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    expect(dcsHandlers.get("$q")!()).toBe(true);
    sendGeometryFrame();
    expect(dcsHandlers.get("$q")!()).toBe(false);
  });

  it("lets xterm answer the same queries once replay is complete (live output)", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    sendGeometryFrame();

    for (const key of QUERY_KEYS) expect(csiHandlers.get(key)!()).toBe(false);
  });

  it("re-arms the guard when the server resyncs with a fresh replay", async () => {
    stubFakeWebSocket(true);
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();
    expect(csiHandlers.get("n")!()).toBe(false);

    for (const handler of fakeSocket._messageHandlers) {
      handler({ data: JSON.stringify({ type: "resync" }) });
    }

    expect(csiHandlers.get("n")!()).toBe(true);
  });
});

describe("TerminalPane OSC 52 clipboard write", () => {
  function stubClipboardWrite() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  // Every connection starts "replaying" until its first geometry frame (see
  // TerminalPane.tsx's own comment on `replaying`) — attachSocketToSession
  // (routes/terminal.ts) sends an optional scrollback backlog frame followed
  // unconditionally by a "geometry" frame on every attach and reattach, and
  // the mock socket here never sends either on its own. Every test in this
  // describe block below that means to exercise LIVE OSC 52 handling (as
  // opposed to the replay-guard tests further down) calls this first, to
  // simulate "past replay" the same way a real reattach settles.
  function sendGeometryFrame(): void {
    for (const handler of fakeSocket._messageHandlers) {
      handler({
        data: JSON.stringify({ type: "geometry", cols: 80, rows: 24, minCols: 40, minRows: 10 }),
      });
    }
  }

  it("writes the decoded payload to the clipboard on an OSC 52 set", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();

    const handled = oscHandlers.get(52)!(`c;${btoa("hello from claude")}`);

    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello from claude"));
  });

  it("never replies to an OSC 52 read query, regardless of the clipboardWrite setting", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();
    fakeWsSend.mockClear();

    const handled = oscHandlers.get(52)!("c;?");

    expect(handled).toBe(true);
    expect(fakeWsSend).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write to the clipboard when clipboardWrite is turned off", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();

    act(() => {
      useDashboardStore.setState((s) => ({
        settings: { ...s.settings, terminal: { ...s.settings.terminal, clipboardWrite: false } },
      }));
    });

    const handled = oscHandlers.get(52)!(`c;${btoa("should not be copied")}`);

    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes the payload when Pc is omitted (some programs, e.g. tmux, skip it)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();

    const handled = oscHandlers.get(52)!(btoa("no Pc here"));

    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("no Pc here"));
  });

  it("leaves malformed base64 unhandled", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    sendGeometryFrame();

    const handled = oscHandlers.get(52)!("c;not-valid-base64!!!");

    expect(handled).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy an OSC 52 sequence seen before the first geometry frame (replay)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const handled = oscHandlers.get(52)!(`c;${btoa("stale scrollback copy")}`);

    expect(handled).toBe(true); // swallowed, not left unhandled
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies an OSC 52 sequence seen after the first geometry frame (live output)", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    sendGeometryFrame();
    const handled = oscHandlers.get(52)!(`c;${btoa("live copy")}`);

    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("live copy"));
  });

  it("still swallows an OSC 52 read query during replay, before any geometry frame", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));

    const handled = oscHandlers.get(52)!("c;?");

    expect(handled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a second geometry frame on the same connection does not re-arm the replay guard", async () => {
    stubFakeWebSocket(true);
    const writeText = stubClipboardWrite();
    renderPane();
    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    const term = getLatestTermInstance() as unknown as { write: ReturnType<typeof vi.fn> };

    sendGeometryFrame();
    const zeroLengthWrites = () =>
      term.write.mock.calls.filter((call: unknown[]) => {
        const data = call[0];
        return data instanceof Uint8Array && data.length === 0;
      });
    expect(zeroLengthWrites()).toHaveLength(1);

    sendGeometryFrame();
    expect(zeroLengthWrites()).toHaveLength(1); // not queued again

    const handled = oscHandlers.get(52)!(`c;${btoa("still live")}`);
    expect(handled).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("still live"));
  });

  // Self-review finding: a stale geometry-sentinel write callback from a
  // SUPERSEDED connection must not clear the replay guard for the
  // connection that replaced it. xterm's write queue is shared across
  // reconnects and drains asynchronously (unlike this test's default
  // synchronous `write` mock), so the old connection's own callback can, in
  // principle, fire after a new connect() has already started — the
  // `myGeneration === connectionGeneration` check is what makes that
  // harmless. Overrides `term.write` here to capture callbacks instead of
  // firing them immediately, so the test controls exactly when each
  // connection's sentinel "completes".
  it("ignores a stale replay-complete callback from a connection a reconnect has since superseded", async () => {
    vi.useFakeTimers();
    try {
      stubFakeWebSocket(true);
      const writeText = stubClipboardWrite();
      // Not `await waitFor(...)` for readyState here (the usual pattern in
      // this describe block) — `waitFor` polls on real timers, which would
      // hang against vi.useFakeTimers() above. readyState is already 1
      // synchronously (stubFakeWebSocket(true) sets it before render), so
      // there's nothing to actually wait for.
      renderPane();
      const term = getLatestTermInstance() as unknown as { write: ReturnType<typeof vi.fn> };
      const pendingWrites: Array<() => void> = [];
      term.write.mockImplementation((_data: unknown, cb?: () => void) => {
        if (cb) pendingWrites.push(cb);
      });
      act(() => {
        useDashboardStore.setState((s) => ({
          settings: {
            ...s.settings,
            terminal: { ...s.settings.terminal, reconnect: { enabled: true, maxAttempts: 5 } },
          },
        }));
      });

      // Generation 1: its geometry sentinel is queued but not yet fired.
      sendGeometryFrame();
      expect(pendingWrites).toHaveLength(1);
      expect(oscHandlers.get(52)!(`c;${btoa("gen1 still replaying")}`)).toBe(true);
      expect(writeText).not.toHaveBeenCalled();

      // The connection drops and a reconnect fires — this is a NEW
      // generation as far as the replay guard is concerned, even though the
      // test harness's fake WebSocket constructor returns the same object.
      act(() => {
        for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      // Generation 2's own geometry sentinel is now also queued (both
      // connections' message listeners are attached to the same fake
      // socket, so this frame reaches gen1's handler too — a no-op there,
      // since gen1 already saw its own first geometry frame).
      sendGeometryFrame();
      expect(pendingWrites).toHaveLength(2);
      expect(oscHandlers.get(52)!(`c;${btoa("still mid-reconnect")}`)).toBe(true);
      expect(writeText).not.toHaveBeenCalled();

      // Generation 2's own callback fires — now, and only now, live OSC 52
      // copies should land. writeText is called synchronously inside
      // copyToClipboard (only its `.then()` — irrelevant here — is async),
      // so no waitFor is needed even under fake timers.
      pendingWrites[1]!();
      expect(oscHandlers.get(52)!(`c;${btoa("live on gen 2")}`)).toBe(true);
      expect(writeText).toHaveBeenCalledWith("live on gen 2");

      // The real hazard: the STALE generation-1 callback fires even later —
      // arriving AFTER generation 2 has already genuinely completed its own
      // replay. An implementation that assigns unconditionally (rather than
      // checking `myGeneration === connectionGeneration`) would downgrade
      // replayCompleteGeneration back to 1 here, spuriously re-entering
      // "still replaying" for a connection that finished replay long ago.
      pendingWrites[0]!();
      expect(oscHandlers.get(52)!(`c;${btoa("still live after stale callback")}`)).toBe(true);
      expect(writeText).toHaveBeenCalledWith("still live after stale callback");
    } finally {
      vi.useRealTimers();
    }
  });
});
