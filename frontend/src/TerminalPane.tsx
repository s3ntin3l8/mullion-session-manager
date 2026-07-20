import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { RefreshIcon, SpinnerIcon, WifiOffIcon } from "./icons.js";
import { useDashboardStore } from "./store.js";
import { buildXtermTheme } from "./terminalTheme.js";
import type { AppSettings } from "./api.js";

export interface TerminalPaneParams {
  sessionId: number;
}

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed";

// Ctrl+R (readline reverse-search, extremely common) collides with page
// refresh, Ctrl+L (clear screen) and Ctrl+K (kill-line) collide with
// address-bar-focus in some browsers — Settings -> Terminal behavior's
// "Key-conflict handling" list (settings.terminal.keyCapture) makes each of
// the three independently toggleable. Browsers reserve some other combos
// (Ctrl+W/T/N — close/open tab, new window) at a level JS categorically
// cannot override; deliberately not attempted here since preventDefault()
// on those is a silent no-op anyway.
function reservedKeysFromSettings(keyCapture: AppSettings["terminal"]["keyCapture"]): Set<string> {
  const keys = new Set<string>();
  if (keyCapture.ctrlR) keys.add("r");
  if (keyCapture.ctrlL) keys.add("l");
  if (keyCapture.ctrlK) keys.add("k");
  return keys;
}

function readClipboard(): Promise<string | null> {
  if (!navigator.clipboard) {
    console.warn("[terminal] clipboard API not available (not a secure context)");
    return Promise.resolve(null);
  }
  return navigator.clipboard.readText().catch(() => {
    console.warn("[terminal] clipboard read denied");
    return null;
  });
}

function attachKeyConflictHandler(
  term: Terminal,
  reservedKeys: Set<string>,
  onPaste?: () => void,
  onCopy?: () => void,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown") {
      const key = event.key.toLowerCase();
      // Paste: Cmd+V (macOS) or Shift+Insert (Linux/Windows) — deliberately
      // picked over plain Ctrl+V, which is vim's Visual Block mode and
      // readline's quoted-insert (both bound to raw 0x16); stealing it
      // unconditionally would break both with no opt-out. Shift+Insert is
      // the classic X11/Linux terminal convention (xterm, PuTTY, ...) for
      // exactly this reason — never claimed by a shell program or a
      // browser. Ctrl+Shift+V, the more "modern" alternative, was rejected:
      // it's Chrome/Firefox's own "paste as plain text" combo in some
      // contexts and risked confusion; Shift+Insert has no such history.
      // Cmd+V doesn't collide with anything on macOS since vim/readline
      // bind the *Ctrl* form, not Cmd.
      const isPasteChord =
        (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && key === "v") ||
        (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && key === "insert");
      if (isPasteChord) {
        event.preventDefault();
        onPaste?.();
        return false;
      }
      // Copy: Ctrl+Insert (Linux/Windows), the Shift+Insert paste
      // convention's copy counterpart. Plain Ctrl+C is deliberately left
      // alone — it's SIGINT, and xterm.js already copies a selection to
      // the clipboard on Ctrl+C via its own native "copy" event listener,
      // but *also* unconditionally forwards the ETX byte to the PTY
      // regardless of selection, so plain Ctrl+C interrupts whatever's
      // running in the shell every time. Ctrl+Shift+C (the more "modern"
      // alternative) was rejected: it's Chrome/Firefox's native "Inspect
      // Element" DevTools shortcut, handled by the browser chrome above
      // the page — preventDefault() in page JS can't reliably stop it, the
      // same class of un-overridable combo as Ctrl+W/T/N above. Ctrl+Insert
      // has no such collision. Cmd+C (macOS) needs no handling here:
      // meta-only chords are never translated to PTY control bytes by
      // xterm, so it already only triggers the browser's native copy.
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && key === "insert") {
        event.preventDefault();
        onCopy?.();
        return false;
      }
      // Browser-reserved combos the user opted into this app
      if (event.ctrlKey && !event.altKey && !event.metaKey && reservedKeys.has(key)) {
        event.preventDefault();
      }
    }
    return true;
  });
}

// One xterm.js instance + one WebSocket per session, bound to a session id
// (not to the panel's own lifetime) — closing this panel only tears down the
// browser-side view; the WS close handler in terminal.ts explicitly does not
// kill the session, matching the "browser tab close never kills the session"
// premise from the plan. Deliberately typed on just `params` (not the full
// IDockviewPanelProps) — this component never touches `api`/`containerApi`,
// so it can be reused outside a dockview panel too (see Dock.tsx, which
// renders a dock monitor's terminal without a real dockview panel at all).
export function TerminalPane(props: { params: TerminalPaneParams }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  // Bumped on every successful copy so the "Copied" toast below remounts
  // (via its `key`) instead of reusing the same DOM node. `copied` alone
  // can't do this: a second copy while the first toast is still showing
  // sets it true -> true, a no-op React skips, so the CSS fade animation
  // (mount-triggered) wouldn't restart and the toast could vanish mid-fade
  // right after the second copy.
  const [copyToastKey, setCopyToastKey] = useState(0);
  // Exposes a manual "Retry now" (design's Disconnected state) without
  // remounting the terminal/xterm instance itself — `connect`/backoff live
  // inside the effect below (closed over the real WS + timer), so this ref
  // is how the render's button reaches in and calls them directly.
  const retryRef = useRef<() => void>(() => {});
  // Exposes the mount effect's `refit` (fit + send-resize-on-delta) to the
  // settings-sync effect below, so a font-load-triggered re-fit (fontSize/
  // fontFamily change, or the web font simply finishing its own fetch) tells
  // the backend PTY about any resulting grid-size change instead of silently
  // resizing xterm without it — see that effect's own comment.
  const refitRef = useRef<() => void>(() => {});
  // Reactive: drives the settings-sync effect below whenever ANY terminal
  // pref changes — including the *first* change, which is the async
  // GET /api/settings hydration resolving after this pane has already
  // mounted with DEFAULT_SETTINGS (store.ts seeds those synchronously so
  // construction never blocks on the fetch). Without this, a pane whose
  // settings hadn't loaded yet at mount time would be permanently stuck on
  // defaults (fontSize 14, Geist Mono, ...) until manually remounted — this
  // selector is what makes every terminal pref "live" rather than
  // "read once at construction," which server-persistence requires (a
  // synchronous localStorage read never had this race). Referentially
  // stable across unrelated settings changes: store.ts's deepMerge only
  // creates a new `terminal` object when a patch actually touches it.
  const terminalSettings = useDashboardStore((s) => s.settings.terminal);
  const theme = useDashboardStore((s) => s.theme);
  // Populated by the mount effect once the terminal/WebGL/fit addons exist,
  // so the settings-sync effect below can update the *same* live instance
  // instead of only ever seeing the value captured at construction.
  const termRef = useRef<Terminal | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Mirrors `terminalSettings` for the reconnect/copy/paste logic inside the
  // mount effect's closures (connect(), onSelectionChange, contextmenu) —
  // those read `prefsRef.current` rather than a value captured once at
  // construction, so e.g. a reconnect that happens minutes into a session
  // uses whatever maxAttempts is current, not whatever was true at mount.
  const prefsRef = useRef(terminalSettings);
  const pasteHandlerRef = useRef<() => void>(() => {});
  const copyHandlerRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial construction reads whatever's in prefsRef right now — DEFAULT_
    // SETTINGS if GET /api/settings hasn't resolved yet, otherwise the real
    // persisted values. The settings-sync effect below corrects every
    // visual option in place the moment hydration completes (or any later
    // change happens), so this is genuinely just a *starting* value, not a
    // "read once" value.
    const prefs = prefsRef.current;
    const fontFamily = `'${prefs.fontFamily}', 'Geist Mono', monospace`;
    const term = new Terminal({
      cursorBlink: prefs.cursorBlink,
      cursorStyle: prefs.cursorStyle,
      fontSize: prefs.fontSize,
      scrollback: prefs.scrollback,
      fontFamily,
      // Resolved from the selected scheme's literal palette (not app CSS
      // tokens) — xterm's `theme` option is passed straight to the renderer
      // (canvas fillStyle / WebGL texture atlas), which doesn't resolve CSS
      // custom properties on its own.
      theme: buildXtermTheme(prefs.colorScheme, theme),
      // Unicode11Addon reads term.unicode, which xterm gates behind this
      // flag as a "proposed" (not yet stabilized) API.
      allowProposedApi: true,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());
    attachKeyConflictHandler(
      term,
      reservedKeysFromSettings(prefs.keyCapture),
      () => pasteHandlerRef.current(),
      () => copyHandlerRef.current(),
    );
    // Note: no separate "wait for the web font to load, then re-fit" step
    // here — the settings-sync effect below runs immediately after this
    // mount effect (on every render, including the first) and already does
    // exactly that as part of applying `terminalSettings` to the live
    // instance, so a second copy of that logic here would just be redundant.

    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
    } catch (err) {
      // Not every environment has a usable WebGL context (e.g. some headless
      // or GPU-restricted setups) — xterm falls back to its default DOM
      // renderer automatically, so this is a soft failure, not a blocker.
      console.warn("[terminal] WebGL renderer unavailable, using default renderer", err);
    }

    term.open(container);
    fitAddon.fit();

    let destroyed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    const dataSub = term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    let lastCols = term.cols;
    let lastRows = term.rows;
    const sendResizeIfOpen = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        const message: ResizeMessage = { type: "resize", cols: term.cols, rows: term.rows };
        ws.send(JSON.stringify(message));
      }
    };
    const refit = () => {
      fitAddon.fit();
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      sendResizeIfOpen();
    };
    refitRef.current = refit;
    const resizeObserver = new ResizeObserver(refit);
    resizeObserver.observe(container);
    // Redundant on top of the ResizeObserver above — Chromium doesn't
    // always fire a ResizeObserver notification for every viewport change
    // that shrinks/grows this element (observed missing the transition when
    // DevTools docks/undocks, which resizes the viewport without a plain
    // window resize). A plain `resize` listener catches those misses.
    window.addEventListener("resize", refit);

    let copyToastTimer: ReturnType<typeof setTimeout> | null = null;

    // Shared by "copy on select" and the Ctrl+Insert handler below.
    function copyToClipboard(text: string): void {
      if (!navigator.clipboard) {
        console.warn("[terminal] clipboard API not available (not a secure context)");
        return;
      }
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          if (destroyed) return;
          setCopied(true);
          setCopyToastKey((k) => k + 1);
          if (copyToastTimer) clearTimeout(copyToastTimer);
          copyToastTimer = setTimeout(() => {
            if (destroyed) return;
            setCopied(false);
          }, 1500);
        })
        .catch((err: unknown) => {
          console.warn("[terminal] clipboard write failed:", err);
        });
    }

    // "Copy on select" (Settings -> Terminal behavior) — xterm doesn't copy
    // to the system clipboard on its own; onSelectionChange only fires when
    // the selection actually changes, so a click that clears a selection
    // (empty string) is a no-op here rather than clobbering the clipboard.
    const selectionSub = term.onSelectionChange(() => {
      if (!prefsRef.current.copyOnSelect) return;
      const text = term.getSelection();
      if (text) copyToClipboard(text);
    });

    // Ctrl+Insert — explicit copy, independent of "copy on select" (so it
    // still works when that's turned off). Registered via
    // attachKeyConflictHandler above so it works even when the browser
    // wants to intercept it itself. No-ops when there's no selection.
    copyHandlerRef.current = () => {
      if (term.hasSelection()) copyToClipboard(term.getSelection());
    };

    // Strips a trailing newline from clipboard text before it reaches the
    // PTY. Clipboard content copied from a terminal commonly ends in `\n`;
    // sent as-is, that lands on the shell as Enter and the pasted command
    // executes immediately instead of sitting at the prompt for review
    // (see issue #66). Routing through term.paste() below (rather than a
    // raw ws.send) additionally wraps the text in bracketed-paste escapes
    // (`\x1b[200~`/`\x1b[201~`) whenever the foreground app has enabled
    // bracketed paste mode (DECSET 2004 — bash/zsh/most TUIs) — the backend
    // PTY is a raw passthrough (routes/terminal.ts, pty-manager.ts) with no
    // filtering, so it needs no special support for this; xterm generates
    // and the shell interprets the escapes entirely client/foreground-app
    // side.
    function pasteToTerminal(text: string): void {
      const trimmed = text.replace(/[\r\n]+$/, "");
      if (trimmed) term.paste(trimmed);
    }

    // Cmd+V / Shift+Insert paste handler — reads from the system clipboard
    // and writes to the PTY, regardless of the pasteOnRightClick setting.
    // Registered via attachKeyConflictHandler above so it works even when
    // the browser wants to intercept the chord itself.
    pasteHandlerRef.current = () => {
      readClipboard().then((text) => {
        if (text) pasteToTerminal(text);
      });
    };

    // "Paste on right-click" (Settings -> Terminal behavior) — replaces the
    // browser's own context menu with a direct paste when enabled, matching
    // common terminal-emulator convention.
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.pasteOnRightClick) return;
      event.preventDefault();
      readClipboard().then((text) => {
        if (text) pasteToTerminal(text);
      });
    };
    container.addEventListener("contextmenu", onContextMenu);

    // Reconnects on any drop (network blip, backend redeploy, laptop sleep)
    // with capped exponential backoff — up to prefs.reconnect.maxAttempts,
    // unless auto-reconnect is disabled entirely — then gives up and shows a
    // "failed" state rather than retrying forever against a session that may
    // genuinely be gone. A successful reconnect needs no special handling to
    // restore output: the server always replays its scrollback buffer to a
    // newly-attaching client (see terminal.ts), so the same catch-up path
    // used for "reopen a detached panel" also covers "the WS silently
    // dropped and came back."
    const RECONNECT_BASE_DELAY_MS = 500;
    const RECONNECT_MAX_DELAY_MS = 8000;
    function connect(): void {
      if (destroyed) return;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      setReconnectAttempt(reconnectAttempt);

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/ws/terminal?sessionId=${props.params.sessionId}&cols=${term.cols}&rows=${term.rows}`;
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      ws = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        // The URL's cols/rows were captured when this connect() call was
        // made, which can be stale if a deferred refit (below) corrected
        // the terminal's size in the meantime — send whatever the terminal's
        // current size actually is now that the socket is open, rather than
        // waiting for the next real resize to reach the backend PTY.
        sendResizeIfOpen();
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return;
        term.write(new Uint8Array(event.data as ArrayBuffer));
      });

      socket.addEventListener("close", () => {
        if (destroyed) return;
        const reconnectPrefs = prefsRef.current.reconnect;
        if (!reconnectPrefs.enabled || reconnectAttempt >= reconnectPrefs.maxAttempts) {
          setStatus("failed");
          return;
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
          RECONNECT_MAX_DELAY_MS,
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    // "Retry now" (design's Disconnected state) — reset backoff to attempt
    // 0 and reconnect immediately, without remounting the terminal itself.
    retryRef.current = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectAttempt = 0;
      connect();
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (copyToastTimer) clearTimeout(copyToastTimer);
      resizeObserver.disconnect();
      window.removeEventListener("resize", refit);
      container.removeEventListener("contextmenu", onContextMenu);
      selectionSub.dispose();
      dataSub.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      refitRef.current = () => {};
    };
    // theme intentionally excluded — mount effect must not recreate the
    // terminal on theme toggle; theme updates flow through the settings-sync
    // effect below which updates term.options.theme in-place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.params.sessionId]);

  // Applies every terminal pref to the *live* instance in place — this is
  // what fixes the async-hydration race noted above (a pane that mounted
  // before GET /api/settings resolved gets corrected the moment it does)
  // and, for scheme/theme in particular, is also the ordinary "user changed
  // a setting" live-update path (without this, an already-open terminal
  // would keep whatever it was constructed with until the whole pane
  // remounts). Runs once right after the mount effect above too (re-applying
  // the same values it just built) — harmless and simpler than guarding
  // against it.
  useEffect(() => {
    prefsRef.current = terminalSettings;
    const term = termRef.current;
    if (!term) return;

    term.options.cursorBlink = terminalSettings.cursorBlink;
    term.options.cursorStyle = terminalSettings.cursorStyle;
    term.options.scrollback = terminalSettings.scrollback;
    term.options.fontSize = terminalSettings.fontSize;
    term.options.fontFamily = `'${terminalSettings.fontFamily}', 'Geist Mono', monospace`;
    term.options.theme = buildXtermTheme(terminalSettings.colorScheme, theme);
    attachKeyConflictHandler(
      term,
      reservedKeysFromSettings(terminalSettings.keyCapture),
      () => pasteHandlerRef.current(),
      () => copyHandlerRef.current(),
    );

    // The WebGL renderer caches glyphs (size and color both) in a texture
    // atlas; reassigning these options alone leaves already-rendered glyphs
    // showing their old font/size/color until the atlas is rebuilt.
    webglAddonRef.current?.clearTextureAtlas();

    // fontSize/fontFamily changes affect cell measurement, so the terminal
    // needs a re-fit — deferred behind the web font's own load promise the
    // same way the mount effect's initial fit is, in case this is the font
    // actually finishing its fetch rather than a user-initiated change. Goes
    // through the mount effect's own `refit` (via refitRef) rather than a
    // raw `fitAddon.fit()` so that, if the font's final metrics do change the
    // grid size, the backend PTY is told about it the same way any other
    // resize is — otherwise this could silently desync xterm's grid from the
    // PTY's size with no resize message ever sent to reconcile them.
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts
        .load(`${terminalSettings.fontSize}px "${terminalSettings.fontFamily}"`)
        .then(() => refitRef.current())
        .catch(() => {});
    } else {
      refitRef.current();
    }
  }, [terminalSettings, theme]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {status !== "open" && (
        <div className={`terminal-status-overlay ${status}`}>
          {status === "connecting" && (
            <>
              <SpinnerIcon size={22} className="terminal-status-spinner connecting" />
              <span className="terminal-status-text">Connecting…</span>
              <span className="terminal-status-subtext">attaching to host</span>
            </>
          )}
          {status === "reconnecting" && (
            <>
              <SpinnerIcon size={22} className="terminal-status-spinner reconnecting" />
              <span className="terminal-status-text">
                Reconnecting… <span style={{ color: "var(--muted)" }}>({reconnectAttempt})</span>
              </span>
              <span className="terminal-status-subtext">connection dropped · retrying</span>
            </>
          )}
          {status === "failed" && (
            <>
              <WifiOffIcon size={22} style={{ color: "var(--r)" }} />
              <span className="terminal-status-text">Disconnected</span>
              <button className="terminal-status-retry" onClick={() => retryRef.current()}>
                <RefreshIcon size={13} />
                Retry now
              </button>
            </>
          )}
        </div>
      )}
      {copied && (
        <div key={copyToastKey} className="terminal-copy-indicator">
          Copied
        </div>
      )}
    </div>
  );
}
