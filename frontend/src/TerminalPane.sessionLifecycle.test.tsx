// @vitest-environment jsdom
// The session's lifecycle over the socket: the retired 'viewed' ack,
// and the reconnect-vs-session-ended decision (P13).
//
// Split out of the former frontend/src/TerminalPane.test.tsx, which had grown
// past the file-size ceiling (scripts/max-file-lines.baseline.json). The mock
// preamble and the shared helpers now live in ./test/terminal-pane-mocks.ts
// and ./test/terminal-pane-harness.tsx.

import { describe, it, expect, vi, afterEach } from "vitest";

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

import { screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { useDashboardStore } from "./store/index.js";
import {
  renderPane,
  stubFakeWebSocket,
  fakeSocket,
  fakeWsSend,
  getLatestTermInstance,
  makeMinimalSession,
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

// fix: status-clearing-semantics — the "viewed" ack (and the `active` prop
// that gated it) is gone; a session's rich status now clears only via a
// genuine keystroke or a resolving hook (see pty-manager.ts's write()), never
// on a mere tab-switch/reconnect. Pin the regression: mounting and
// reconnecting a pane sends no "viewed" control frame at all, regardless of
// document visibility.
describe("TerminalPane no longer sends a 'viewed' ack (fix: status-clearing-semantics)", () => {
  afterEach(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  function controlMessagesSent(): unknown[] {
    return fakeWsSend.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
  }

  it("sends no 'viewed' message once the socket is open", async () => {
    stubFakeWebSocket(true);
    renderPane();

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    expect(controlMessagesSent().some((msg) => (msg as { type?: string }).type === "viewed")).toBe(
      false,
    );
  });

  it("sends no 'viewed' message on a reconnect", async () => {
    stubFakeWebSocket(false);
    renderPane();

    act(() => {
      fakeSocket.readyState = 1;
      for (const handler of fakeSocket._openHandlers) handler();
    });

    await waitFor(() => expect(fakeSocket.readyState).toBe(1));
    expect(controlMessagesSent().some((msg) => (msg as { type?: string }).type === "viewed")).toBe(
      false,
    );
  });
});

// P13 — the WS close listener used to retry with backoff regardless of why
// the connection closed, then show a generic "Disconnected / Retry now"
// that can never succeed once the session is genuinely gone (killed, or its
// program exited). Two signals now distinguish "gone" from "network blip":
// an `{type:"exited"}` control message (sent the instant the PTY exits,
// terminal.ts's onExit), and cross-checking store.sessions at close time —
// the close event's own code/reason carry no usable signal here (see the
// close listener's own comment in TerminalPane.tsx for why: a reconnect
// against an already-killed session fails at the WS opening handshake, which
// every browser reports as code 1006/empty reason regardless of cause).
describe("TerminalPane reconnect vs. session-ended (P13)", () => {
  function enableReconnect(maxAttempts = 5) {
    act(() => {
      useDashboardStore.setState((s) => ({
        settings: {
          ...s.settings,
          terminal: { ...s.settings.terminal, reconnect: { enabled: true, maxAttempts } },
        },
      }));
    });
  }

  it('shows "Session ended" (no retry) when the session is absent from store.sessions at close time', () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect();
    // `sessionsLoaded: true` is what makes an absent session trustworthy as
    // "confirmed gone" rather than "store hasn't fetched yet" — see the
    // next test for the initial-load-race case this guards against
    // (Hermes review, PR #592).
    useDashboardStore.setState({ sessions: [], sessionsLoaded: true });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry now")).not.toBeInTheDocument();
  });

  // Hermes review (PR #592): `!stored` alone isn't trustworthy as "gone" —
  // a pane can hit its very first close before refreshSessions()'s first
  // response ever lands (e.g. restored by dockview racing a backend
  // restart), where `sessions` is `[]` for every live session, not just
  // dead ones. `sessionsLoaded` distinguishes "confirmed empty" from
  // "haven't checked yet", so this must fall through to the ordinary
  // retry-with-backoff path instead of getting stuck on "Session ended".
  it('does NOT show "Session ended" for a close before the store has ever loaded (sessionsLoaded still false), even with an empty sessions list', () => {
    vi.useFakeTimers();
    try {
      stubFakeWebSocket(false);
      renderPane();
      enableReconnect();
      useDashboardStore.setState({ sessions: [], sessionsLoaded: false });

      act(() => {
        for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
      expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "Session ended" when store.sessions reports this session as killed', () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect();
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "killed" })],
    });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  it('shows "Session ended" immediately on an {type:"exited"} message, without waiting for close', () => {
    stubFakeWebSocket(true);
    renderPane();
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "active" })],
    });

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({ data: JSON.stringify({ type: "exited" }) });
      }
    });

    expect(screen.getByText("Session ended")).toBeInTheDocument();
  });

  // Issue #2168 - a live session whose pty-host protocol this build cannot
  // attach to must not read as the program having exited.
  it('says the process is still running on an {type:"exited",reason:"incompatible"} message', () => {
    stubFakeWebSocket(true);
    renderPane();

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({ data: JSON.stringify({ type: "exited", reason: "incompatible" }) });
      }
    });

    expect(screen.getByText("Can't reconnect after the update")).toBeInTheDocument();
    expect(screen.getByText(/Its process is still running/)).toBeInTheDocument();
    expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
  });

  // Issue #1520 — a {type:"resync"} frame means the server dropped output
  // under backpressure; xterm must be reset before the fresh replay lands.
  it('resets xterm on a {type:"resync"} message and keeps the session live', () => {
    stubFakeWebSocket(true);
    renderPane();
    const term = getLatestTermInstance() as unknown as { reset: ReturnType<typeof vi.fn> };

    act(() => {
      for (const handler of fakeSocket._messageHandlers) {
        handler({ data: JSON.stringify({ type: "resync" }) });
      }
    });

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
  });

  it("an ordinary close (e.g. code 1006, abnormal closure) still retries with backoff when the session is still active in the store", () => {
    vi.useFakeTimers();
    try {
      stubFakeWebSocket(false);
      renderPane();
      enableReconnect();
      useDashboardStore.setState({
        sessions: [makeMinimalSession({ id: 1, status: "active" })],
      });

      act(() => {
        for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
      });
      // The close handler only SCHEDULES the retry (RECONNECT_BASE_DELAY_MS,
      // TerminalPane.tsx) — status flips to "reconnecting" once that timer
      // actually fires and connect() re-runs, not synchronously on close.
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
      expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the ordinary Disconnected/Retry state (not Session ended) once backoff is exhausted against a still-active session", () => {
    stubFakeWebSocket(false);
    renderPane();
    enableReconnect(0);
    useDashboardStore.setState({
      sessions: [makeMinimalSession({ id: 1, status: "active" })],
    });

    act(() => {
      for (const handler of fakeSocket._closeHandlers) handler({ code: 1006, reason: "" });
    });

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText("Retry now")).toBeInTheDocument();
    expect(screen.queryByText("Session ended")).not.toBeInTheDocument();
  });
});
