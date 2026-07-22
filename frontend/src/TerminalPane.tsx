import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ImageIcon, RefreshIcon, SpinnerIcon, WifiOffIcon } from "./icons.js";
import { useDashboardStore } from "./store.js";
import { buildXtermTheme, getSchemeBackground } from "./terminalTheme.js";
import { api, type AppSettings } from "./api.js";
import { registerTerminalRepaint, unregisterTerminalRepaint } from "./terminalRepaintRegistry.js";

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
export function TerminalPane(props: {
  params: TerminalPaneParams;
  // Fires with the raw OSC 0/2 title string the instant xterm parses it from
  // the stream (issue #69) — real-time, unlike session.lastTitle which only
  // reaches the client on the ~4s session poll. Optional and dockview-agnostic
  // like the rest of this component's props (see the header comment above):
  // Dock.tsx, which renders a terminal with no real dockview panel, simply
  // omits it.
  onTitleChange?: (title: string) => void;
}) {
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
  // Issue #68: surfaces the image-upload round trip (paste or the "attach
  // image" button below) as a small toast, same spirit as the copy toast
  // above — an upload is a real network request, unlike an ordinary paste,
  // so silently doing nothing while it's in flight (or on failure) would
  // read as broken rather than slow.
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Exposes the mount effect's own upload-and-inject logic to the "attach
  // image" button's file input handler below, same pattern as retryRef/
  // pasteHandlerRef — the button lives in this component's render, but the
  // logic needs the mount effect's closures (pasteToTerminal, `destroyed`).
  const uploadImageRef = useRef<(blob: Blob) => void>(() => {});
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
  // Exposes the mount effect's `repaint` (full every-row re-raster, see the
  // registry comment above) to the settings-sync effect's font-load path
  // below, for the same reason refitRef exists — closed over the real
  // term/webglAddon instances rather than captured once.
  const repaintRef = useRef<() => void>(() => {});
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
  // Mirrors `ws` for the settings-sync effect below so the OSC color push on
  // theme toggle can reach the PTY without the mount effect's closure going
  // stale across reconnects.
  const wsRef = useRef<WebSocket | null>(null);
  // Tracks the previous theme value so the settings-sync effect only pushes
  // OSC color sequences on an actual dark/light toggle, not on every unrelated
  // pref update (font size, cursor blink, etc.).
  const prevThemeRef = useRef(theme);
  // Queues OSC color bytes when theme toggles but the socket isn't OPEN
  // (connecting/reconnecting/failed). The socket open handler below drains
  // this so a toggle that happens during a reconnect is not lost — the
  // running program always sees the current theme once the connection is
  // restored.
  const pendingOscRef = useRef<string | null>(null);
  // Mirrors `terminalSettings` for the reconnect/copy/paste logic inside the
  // mount effect's closures (connect(), onSelectionChange, contextmenu) —
  // those read `prefsRef.current` rather than a value captured once at
  // construction, so e.g. a reconnect that happens minutes into a session
  // uses whatever maxAttempts is current, not whatever was true at mount.
  const prefsRef = useRef(terminalSettings);
  const pasteHandlerRef = useRef<() => void>(() => {});
  const copyHandlerRef = useRef<() => void>(() => {});
  // Mirrors `props.onTitleChange` for the same reason as prefsRef above — the
  // mount effect's term.onTitleChange subscription (below) is created once
  // and must not go stale if the caller passes a new callback identity later.
  const onTitleChangeRef = useRef(props.onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = props.onTitleChange;
  });

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

    // Runtime GPU context loss (driver reset, backgrounded-tab context
    // eviction, GPU hiccup) — as opposed to WebGL being unavailable at
    // *creation* time, handled by the catch below. WebglAddon has no
    // onContextRestored event, so there's no signal to retry on; a blind
    // timer-retry could only loop. Instead: dispose the addon so xterm
    // reverts to its default DOM renderer, null the ref so the repaint()
    // closure and resize path's `webglAddonRef.current?.clearTextureAtlas()`
    // calls below become harmless no-ops against a live DOM-rendered
    // terminal, then force one full re-raster so the DOM renderer paints
    // the current buffer immediately instead of leaving a frozen/blank
    // screen until the next byte of PTY output arrives. Speculative
    // hardening (issue #107 "Fix 2") — this path has never been observed
    // to fire in practice; #107's actual symptoms traced to two other,
    // already-fixed causes (#124, #129).
    let webglContextLossSub: IDisposable | null = null;
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
      // Fall back to the DOM renderer on context loss — see comment above.
      webglContextLossSub = webglAddon.onContextLoss(() => {
        // Guards against a double-firing context-loss event (rare, but some
        // GPU drivers can raise it more than once) re-disposing an
        // already-disposed addon and double-repainting.
        if (!webglAddonRef.current) return;
        console.warn("[terminal] WebGL context lost — falling back to DOM renderer");
        webglAddon.dispose();
        webglAddonRef.current = null;
        term.refresh(0, term.rows - 1);
      });
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

    // Real-time tab title tracking (issue #69) — fires whenever the running
    // program emits an OSC 0/2 title sequence (e.g. a shell running `claude`
    // then `opencode` retitles itself), independent of the ~4s session poll
    // that lastTitle rides on.
    const titleSub = term.onTitleChange((title) => onTitleChangeRef.current?.(title));

    // Answers OSC 10/11/12 *query* requests ("ESC ] 10|11|12 ; ? BEL") the way
    // a real terminal emulator does (issue #91). Terminal-aware CLIs send this
    // at their own startup to detect whether they're on a light or dark
    // background before choosing colors — confirmed Claude Code does this by
    // capturing its raw PTY output. xterm.js parses the query internally but
    // doesn't expose a way to answer it (no `onColor`/report event on the
    // public Terminal API), so left unanswered the CLI falls back to colors
    // tuned for a dark terminal — which is exactly why a "selected" menu row
    // can end up invisible against one of Mullion's light color schemes: the
    // highlight color is fine on a dark background and washes out on a light
    // one. `parser.registerOscHandler` is public API (not gated behind
    // allowProposedApi) and, per xterm.js's own dispatch order, runs *before*
    // its built-in OSC 10/11/12 handling (handlers are walked last-registered-
    // first) — so this only adds the missing "report" half. Anything other
    // than the query form ("?") is left unhandled (`return false`) and falls
    // through to xterm's own existing SET handling.
    const OSC_COLOR_IDENTS: ReadonlyArray<[number, "foreground" | "background" | "cursor"]> = [
      [10, "foreground"],
      [11, "background"],
      [12, "cursor"],
    ];
    const oscColorSubs = OSC_COLOR_IDENTS.map(([ident, key]) =>
      term.parser.registerOscHandler(ident, (data) => {
        if (data !== "?") return false;
        if (ws?.readyState !== WebSocket.OPEN) return true;
        const hex = term.options.theme?.[key];
        if (typeof hex !== "string") return true;
        const clean = hex.replace("#", "");
        // OSC report replies use 16-bit-per-channel `rgb:` form (each 8-bit
        // hex byte doubled), the convention real terminal emulators use —
        // distinct from the plain `#rrggbb` form used for the SET push below.
        const [r, g, b] = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)];
        ws.send(new TextEncoder().encode(`\x1b]${ident};rgb:${r}${r}/${g}${g}/${b}${b}\x07`));
        return true;
      }),
    );

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

    // Full every-row re-raster (issue #107) — unlike `refit`/`fit()`, this
    // isn't gated on a cols/rows delta, so it also heals a terminal whose grid
    // size never changed (the common case: another panel opening doesn't
    // resize *this* one). `clearTextureAtlas()` forces the WebGL renderer to
    // rebuild its glyph texture atlas; `term.refresh()` then repaints every
    // row from it, including the static input/status band that a mere scroll
    // can never reach (scrolling only repaints the rows that scroll).
    const repaint = () => {
      webglAddonRef.current?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    };
    repaintRef.current = repaint;
    registerTerminalRepaint(props.params.sessionId, repaint);

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

    // OSC 52 — clipboard write requested by the foreground program. Claude
    // Code / opencode both copy this way while they own mouse reporting
    // (DECSET 1000/1002/1003/1006): a plain drag then goes to the app
    // instead of xterm's local selection, so `onSelectionChange` above never
    // fires — copy-on-select silently does nothing and the app's own OSC 52
    // write is the only thing that actually carries the text. xterm.js core
    // has no OSC 52 handling (unlike its built-in OSC 10/11/12 support
    // above), so without this handler the escape sequence is just dropped
    // and the CLI's "copied" toast is a lie. Registered the same way as the
    // OSC 10/11/12 handlers above rather than via @xterm/addon-clipboard —
    // there's no stable release of that addon for xterm 6 (0.2.0 predates
    // the @xterm/xterm peer dep and targets xterm 5; the next one requires
    // an xterm 6 beta), and a manual handler keeps control over the
    // read direction (see below).
    //
    // Gated on the "Allow programs to set the clipboard" setting
    // (terminal.clipboardWrite, default on) rather than copyOnSelect — this
    // is the app explicitly writing the clipboard, not a passive selection,
    // so it's a distinct preference with its own toggle.
    //
    // SECURITY: write only, never read. An OSC 52 *read* query (Pd === "?")
    // is swallowed and never answered, unconditionally — regardless of the
    // toggle above. Answering it would hand any program running in this PTY
    // (including code an agent executes) the contents of the user's system
    // clipboard.
    const osc52Sub = term.parser.registerOscHandler(52, (data) => {
      // Pc is optional per spec — some programs (e.g. tmux) omit it and send
      // just the base64 payload with no leading ";". Fall back to treating
      // the whole string as the payload in that case.
      const semi = data.indexOf(";");
      const payload = semi === -1 ? data : data.slice(semi + 1); // drop the Pc selection spec, unused
      if (payload === "?") return true; // read query — swallow, never reply
      if (!prefsRef.current.clipboardWrite) return true;
      let text: string;
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
      } catch {
        return false; // malformed base64 — leave unhandled
      }
      copyToClipboard(text);
      return true;
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

    // Issue #68: the CLI running in this PTY is a host process — it can't
    // read the browser's clipboard, and even if raw image bytes reached it
    // over the WS/PTY byte stream there's no terminal image protocol (Sixel/
    // Kitty/iTerm2) or renderer in this stack to make sense of them anyway.
    // The only thing that actually works is a file the CLI can open by path:
    // upload the image, write it under the session's own cwd (backend), then
    // inject that path into the terminal exactly like a text paste. A
    // trailing space keeps it from running straight into whatever the user
    // types next.
    function uploadAndInjectImage(blob: Blob): void {
      setUploadState("uploading");
      api
        .uploadSessionImage(props.params.sessionId, blob)
        .then(({ path }) => {
          if (destroyed) return;
          pasteToTerminal(`${path} `);
          setUploadState("idle");
        })
        .catch((err: unknown) => {
          console.warn("[terminal] image upload failed:", err);
          if (!destroyed) setUploadState("error");
        });
    }
    uploadImageRef.current = uploadAndInjectImage;

    // Checks the clipboard for an image entry (a screenshot or copied photo,
    // as opposed to copied text) and, if found, routes it through the upload
    // path above instead of a text paste. navigator.clipboard.read() needs a
    // secure context/permission and is less broadly supported than
    // readText() — any failure here (denied, unavailable, no image type
    // present) resolves false so the caller falls through to the ordinary
    // text-paste path rather than surfacing an error for what is, from the
    // user's perspective, just a normal paste.
    async function tryImagePaste(): Promise<boolean> {
      if (!navigator.clipboard?.read) return false;
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (!imageType) continue;
          uploadAndInjectImage(await item.getType(imageType));
          return true;
        }
      } catch (err) {
        console.warn("[terminal] clipboard image read unavailable, falling back to text:", err);
      }
      return false;
    }

    // Cmd+V / Shift+Insert paste handler — reads from the system clipboard
    // and writes to the PTY, regardless of the pasteOnRightClick setting.
    // Registered via attachKeyConflictHandler above so it works even when
    // the browser wants to intercept the chord itself.
    pasteHandlerRef.current = () => {
      tryImagePaste()
        .then((handled) => {
          if (handled) return;
          return readClipboard().then((text) => {
            if (text) pasteToTerminal(text);
          });
        })
        .catch(() => {});
    };

    // "Paste on right-click" (Settings -> Terminal behavior) — replaces the
    // browser's own context menu with a direct paste when enabled, matching
    // common terminal-emulator convention. Same image-first behavior as the
    // keyboard paste handler above.
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.pasteOnRightClick) return;
      event.preventDefault();
      tryImagePaste()
        .then((handled) => {
          if (handled) return;
          return readClipboard().then((text) => {
            if (text) pasteToTerminal(text);
          });
        })
        .catch(() => {});
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
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        // The URL's cols/rows were captured when this connect() call was
        // made, which can be stale if a deferred refit (below) corrected
        // the terminal's size in the meantime — send whatever the terminal's
        // current size actually is now that the socket is open, rather than
        // waiting for the next real resize to reach the backend PTY.
        sendResizeIfOpen();
        // Drain any OSC color push that was queued while the socket was
        // not OPEN (theme toggle during a reconnect).  The running program
        // always sees the latest theme once the connection is restored.
        const pending = pendingOscRef.current;
        if (pending) {
          socket.send(new TextEncoder().encode(pending));
          pendingOscRef.current = null;
        }
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
      osc52Sub.dispose();
      dataSub.dispose();
      titleSub.dispose();
      oscColorSubs.forEach((sub) => sub.dispose());
      webglContextLossSub?.dispose();
      ws?.close();
      term.dispose();
      termRef.current = null;
      webglAddonRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
      pendingOscRef.current = null;
      refitRef.current = () => {};
      repaintRef.current = () => {};
      unregisterTerminalRepaint(props.params.sessionId);
      uploadImageRef.current = () => {};
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
    const xtermTheme = buildXtermTheme(terminalSettings.colorScheme, theme);
    term.options.theme = xtermTheme;
    // Notify the running program of a theme change by pushing color
    // sequences through the PTY (arrives on the program's STDIN): OSC 10/11
    // SET (foreground/background) for tools that read it directly from
    // stdin, plus a DEC `\x1b[?997;1n`/`;2n` "color scheme update"
    // notification carrying the resolved dark/light mode for tools that
    // instead react to that and re-query (e.g. opencode — see issue #99 and
    // the PR description for the full mechanism). Both are harmless for
    // tools that don't handle them — unknown OSC/CSI is consumed silently in
    // raw mode. Gated behind a theme comparison to avoid re-sending
    // identical bytes on unrelated pref changes (font size, cursor blink,
    // etc.). When the socket isn't OPEN (connecting/reconnecting/failed),
    // the bytes are queued in pendingOscRef so the socket open handler above
    // drains them when the connection is restored — otherwise a theme
    // toggle during a reconnect would be silently lost.
    if (theme !== prevThemeRef.current) {
      const dec997Notification = theme === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n";
      const oscPush =
        `\x1b]10;${xtermTheme.foreground}\x07` +
        `\x1b]11;${xtermTheme.background}\x07` +
        dec997Notification;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(oscPush));
      } else {
        pendingOscRef.current = oscPush;
      }
      prevThemeRef.current = theme;
    }
    attachKeyConflictHandler(
      term,
      reservedKeysFromSettings(terminalSettings.keyCapture),
      () => pasteHandlerRef.current(),
      () => copyHandlerRef.current(),
    );

    // The WebGL renderer caches glyphs (size and color both) in a texture
    // atlas; reassigning these options alone leaves already-rendered glyphs
    // showing their old font/size/color until the atlas is rebuilt. Cleared
    // immediately (not deferred to `repaintRef.current()` below) so a
    // color-only change (theme toggle, no font-load wait involved) doesn't
    // sit stale until that later call fires — `repaint()` clearing it again
    // afterward is a harmless no-op double-clear, not a correctness issue.
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
    //
    // `repaintRef.current()` runs alongside it, unconditionally (issue #107):
    // `refit`'s `fit()` early-returns without repainting when the grid size
    // doesn't change, which is the common case for a same-size mount/font
    // finishing its fetch — so without this, a terminal whose WebGL glyph
    // atlas got corrupted at construction time (see the registry comment
    // near the top of this file) would never get a first real repaint.
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts
        .load(`${terminalSettings.fontSize}px "${terminalSettings.fontFamily}"`)
        .then(() => {
          refitRef.current();
          repaintRef.current();
        })
        .catch(() => {});
    } else {
      refitRef.current();
      repaintRef.current();
    }
  }, [terminalSettings, theme]);

  // Auto-dismisses the "upload failed" toast — "uploading" instead clears
  // itself the moment uploadAndInjectImage's promise settles (see the mount
  // effect above), so this only ever fires for the error state.
  useEffect(() => {
    if (uploadState !== "error") return;
    const timer = setTimeout(() => setUploadState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [uploadState]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {
        // Padding + border-box (not the outer wrapper) is deliberate — see
        // issue #91: `.xterm` is a normal-flow child of whatever element
        // `term.open()` is called on, so padding here visually insets the
        // rendered terminal on all sides, and FitAddon.fit() reads this same
        // element's content-box width/height, so the computed cols/rows
        // already account for it (no clipping/overflow). border-box keeps
        // this div's own occupied size at exactly 100% of its parent —
        // without it, width:100% + padding would add the padding on top and
        // overflow the pane. The four absolutely-positioned overlay siblings
        // below resolve their offsets against the *outer* `position:
        // relative` wrapper, not this div, so they're unaffected either way.
      }
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          // xterm's own canvas covers the terminal area itself, but not the
          // padding ring around it — without an explicit background here,
          // that ring (and the dockview chrome peeking through it) shows
          // through as an unrelated color when it doesn't match the active
          // scheme (issue #132). getSchemeBackground (not buildXtermTheme)
          // since only the background is needed here, not a full 16-color
          // xterm theme object.
          background: getSchemeBackground(terminalSettings.colorScheme, theme),
          padding: `${terminalSettings.padding}px`,
          boxSizing: "border-box",
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so selecting the same file again still fires onChange.
          event.target.value = "";
          if (file) uploadImageRef.current(file);
        }}
      />
      <button
        className="pane-tab-btn terminal-attach-image-btn"
        title="Attach image"
        onClick={() => fileInputRef.current?.click()}
      >
        <ImageIcon size={14} />
      </button>
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
      {uploadState !== "idle" && (
        <div className={`terminal-upload-indicator ${uploadState === "error" ? "error" : ""}`}>
          {uploadState === "uploading" ? "Uploading image…" : "Image upload failed"}
        </div>
      )}
    </div>
  );
}
