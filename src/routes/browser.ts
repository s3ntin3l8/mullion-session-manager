import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Page, Frame } from "playwright";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions, projects } from "../db/schema.js";
import { recordSessionBrowserBinding } from "../services/session-browsers.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { resolveBrowserFramerate } from "../services/runtime-config.js";
import { getStoredSettings } from "../services/settings.js";

// Phase 3, issue #180 — streams a project's Playwright-controlled Chromium
// page to the frontend BrowserPane (#181) as binary JPEG frames over
// WebSocket, and proxies mouse/keyboard/navigation input back. Modeled on
// src/routes/terminal.ts's attachSocketToSession: preValidation rejects a
// bad request before the upgrade, backpressure drops frames rather than
// queuing them, and per-connection state is torn down on socket close.
//
// Keyed by :sessionId (matching #180's own route shape) but resolves to the
// session's *project* browser — BrowserManager pools one Chromium instance
// per project (#179), not per session. Explicit session<->browser binding
// (which browser a session's automation calls target by default) is #182;
// this route only needs the session's project to find/launch the right
// pooled instance.
//
// Frame capture is per-connection, not fanned out from a single shared
// capture loop: simpler and correct for the common case (one viewer per
// project), at the cost of duplicate screenshot() calls if multiple
// sessions in the same project open a BrowserPane simultaneously. Worth
// revisiting (a shared per-project broadcaster) if that turns out to matter
// in practice.

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// Mirrors routes/device.ts's own CLIPBOARD_MAX_BYTES (scrcpy server's
// CONTROL_MSG_CLIPBOARD_TEXT_MAX_LENGTH) — that constant isn't exported (and
// importing it here would pull @yume-chan/scrcpy into this route for no
// reason), so this is a separate constant with the same value: a paste into
// a page has no analogous wire-protocol limit of its own, but reusing the
// device feature's already-chosen sanity cap is more defensible than
// inventing a new magic number. Keep the two in sync if either changes.
const BROWSER_CLIPBOARD_MAX_BYTES = (1 << 18) - 14;

interface MouseInputMessage {
  type: "mouse";
  action: "move" | "down" | "up" | "click" | "wheel";
  // Only meaningful for move/down/click (validated below) — up/wheel don't
  // use a position, so requiring them there would mislead callers into
  // sending values that are silently ignored.
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  deltaX?: number;
  deltaY?: number;
}

interface KeyInputMessage {
  type: "key";
  action: "down" | "up" | "press";
  key: string;
}

interface NavigateInputMessage {
  type: "navigate";
  url: string;
}

interface HistoryInputMessage {
  type: "back" | "forward" | "reload";
}

// Paste: host -> page. Sent by BrowserPane.tsx's own `paste` DOM listener,
// fired only on an explicit host paste gesture (never a page-initiated
// clipboard read) — see this route's own copy/cut comment below for the
// matching page -> host direction and the security posture both share.
interface ClipboardInputMessage {
  type: "clipboard";
  text: string;
}

// Copy/cut: page -> host, but only ever in response to one of these, which
// BrowserPane.tsx sends solely from its own keydown handler on an explicit
// Ctrl/Cmd+C or +X gesture inside the pane — never from a page-initiated
// clipboard write (issue #1478, an explicit descope, not an oversight: the
// pane can browse untrusted content, so auto-syncing whatever a page's own
// script writes to its in-page clipboard would let any page silently plant
// data on the real host clipboard).
interface CopyInputMessage {
  type: "copy";
}
interface CutInputMessage {
  type: "cut";
}

type BrowserInputMessage =
  | MouseInputMessage
  | KeyInputMessage
  | NavigateInputMessage
  | HistoryInputMessage
  | ClipboardInputMessage
  | CopyInputMessage
  | CutInputMessage;

const MOUSE_ACTIONS_REQUIRING_POSITION = new Set(["move", "down", "click"]);

function isMouseMessage(value: unknown): value is MouseInputMessage {
  const v = value as Partial<MouseInputMessage> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    v.type !== "mouse" ||
    typeof v.action !== "string" ||
    !["move", "down", "up", "click", "wheel"].includes(v.action)
  ) {
    return false;
  }
  if (MOUSE_ACTIONS_REQUIRING_POSITION.has(v.action)) {
    return typeof v.x === "number" && typeof v.y === "number";
  }
  return true;
}

function isKeyMessage(value: unknown): value is KeyInputMessage {
  const v = value as Partial<KeyInputMessage> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.type === "key" &&
    typeof v.action === "string" &&
    ["down", "up", "press"].includes(v.action) &&
    typeof v.key === "string"
  );
}

function isNavigateMessage(value: unknown): value is NavigateInputMessage {
  const v = value as Partial<NavigateInputMessage> | null;
  return typeof v === "object" && v !== null && v.type === "navigate" && typeof v.url === "string";
}

function isHistoryMessage(value: unknown): value is HistoryInputMessage {
  const v = value as Partial<HistoryInputMessage> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    (v.type === "back" || v.type === "forward" || v.type === "reload")
  );
}

// Same byte cap enforced at parse time as routes/device.ts's own clipboard
// message (see BROWSER_CLIPBOARD_MAX_BYTES above) — an oversize message is
// silently dropped (parseInputMessage returns null), same as any other
// malformed/unrecognized control message this route already ignores.
function isClipboardMessage(value: unknown): value is ClipboardInputMessage {
  const v = value as Partial<ClipboardInputMessage> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.type === "clipboard" &&
    typeof v.text === "string" &&
    Buffer.byteLength(v.text, "utf8") <= BROWSER_CLIPBOARD_MAX_BYTES
  );
}

function isCopyOrCutMessage(value: unknown): value is CopyInputMessage | CutInputMessage {
  const v = value as Partial<CopyInputMessage | CutInputMessage> | null;
  return typeof v === "object" && v !== null && (v.type === "copy" || v.type === "cut");
}

function parseInputMessage(value: unknown): BrowserInputMessage | null {
  if (isMouseMessage(value)) return value;
  if (isKeyMessage(value)) return value;
  if (isNavigateMessage(value)) return value;
  if (isHistoryMessage(value)) return value;
  if (isClipboardMessage(value)) return value;
  if (isCopyOrCutMessage(value)) return value;
  return null;
}

// Only http(s) — page.goto() otherwise happily navigates a headless
// Chromium this process controls to file:// (reads the host filesystem) or
// chrome:// internals, which a screenshot would then exfiltrate straight
// back over this same authenticated WS. Mirrors BrowserPanel.tsx's own
// isDangerousIframeSrc guard on the existing iframe preview.
export function isSafeNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Runs inside the page to read the current selection ahead of a copy/cut —
// see dispatchInput's "copy"/"cut" case for why this must happen BEFORE any
// key is pressed (a cut destroys the selection). Written as a plain string
// wrapped in a self-invoking IIFE, not a typed TS function, same reasoning
// as browser-automation.ts's own TAG_INTERACTIVE_ELEMENTS_SCRIPT: this
// project's tsconfig has no "dom" lib (it's a Node backend), so
// document/window/HTMLInputElement aren't typecheckable here anyway, and a
// bare (non-self-invoking) function string passed to Playwright's evaluate
// evaluates to the function value itself rather than being called.
//
// Main frame only (`page.evaluate` always targets the page's main frame) —
// a selection inside a cross-origin iframe isn't reachable this way; that
// gap is tracked as issue #1477, not solved here.
//
// Wrapped in try/catch: a contenteditable <div> has no `.value` (checked
// with `typeof el.value === "string"` below, not just the `selectionStart`
// probe alone, which a contenteditable div can also satisfy depending on
// the browser), and some <input> types (number/email/color) throw a
// DOMException merely from *reading* `.selectionStart`/`.selectionEnd` —
// this must never let an uncaught rejection reach dispatchInput's caller,
// since that would skip the subsequent `page.keyboard.press(...)` entirely
// and silently swallow the user's Ctrl/Cmd+C or +X.
const READ_SELECTION_SCRIPT = `
(() => {
  try {
    const el = document.activeElement;
    if (
      el &&
      "selectionStart" in el &&
      typeof el.value === "string" &&
      typeof el.selectionStart === "number" &&
      typeof el.selectionEnd === "number"
    ) {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
  } catch {
    // Fall through to the generic selection below.
  }
  return window.getSelection()?.toString() ?? "";
})()
`;

async function dispatchInput(
  app: FastifyInstance,
  socket: WebSocket,
  page: Page,
  message: BrowserInputMessage,
): Promise<void> {
  switch (message.type) {
    case "mouse":
      switch (message.action) {
        // x/y are guaranteed present by isMouseMessage's action-specific
        // check for these three actions — the ?? 0 fallback is defensive
        // typing only, it's never actually reached.
        case "move":
          await page.mouse.move(message.x ?? 0, message.y ?? 0);
          break;
        case "down":
          await page.mouse.move(message.x ?? 0, message.y ?? 0);
          await page.mouse.down({ button: message.button ?? "left" });
          break;
        case "up":
          await page.mouse.up({ button: message.button ?? "left" });
          break;
        case "click":
          await page.mouse.click(message.x ?? 0, message.y ?? 0, {
            button: message.button ?? "left",
          });
          break;
        case "wheel":
          await page.mouse.wheel(message.deltaX ?? 0, message.deltaY ?? 0);
          break;
      }
      break;
    case "key":
      switch (message.action) {
        case "down":
          await page.keyboard.down(message.key);
          break;
        case "up":
          await page.keyboard.up(message.key);
          break;
        case "press":
          await page.keyboard.press(message.key);
          break;
      }
      break;
    case "navigate":
      if (!isSafeNavigationUrl(message.url)) {
        app.log.warn({ url: message.url }, "rejected unsafe browser navigate target");
        // Tell the client, not just the server log — a caller with no
        // other feedback channel (e.g. the BrowserPane's own URL bar)
        // otherwise sees a silently-ignored navigate.
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Refusing to navigate to non-http(s) URL: ${message.url}`,
            }),
          );
        }
        return;
      }
      await page.goto(message.url);
      break;
    case "back":
      await page.goBack();
      break;
    case "forward":
      await page.goForward();
      break;
    case "reload":
      await page.reload();
      break;
    case "clipboard":
      // Host -> page paste. Byte cap already enforced at parse time
      // (isClipboardMessage). insertText (not a `type`/keypress simulation)
      // handles Unicode/emoji in one shot and doesn't depend on the page's
      // own keydown handlers to build up the string character by character.
      await page.keyboard.insertText(message.text);
      break;
    case "copy":
    case "cut": {
      // Read BEFORE pressing the key: a cut's Ctrl+X both copies and
      // deletes the selection, so reading after the press would see an
      // already-empty selection. The reply is sent before the key press too
      // (order matters here, not just for the read) so the client's host
      // clipboard write and the page's own copy/cut handlers don't race in
      // a surprising order from the caller's perspective.
      const text = (await page.evaluate(READ_SELECTION_SCRIPT)) as string;
      if (text && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "clipboard", text }));
      }
      await page.keyboard.press(message.type === "copy" ? "Control+c" : "Control+x");
      break;
    }
  }
}

export interface AttachBrowserParams {
  sessionId: number;
  projectId: number;
}

/** Attaches a browser WS socket to the session's project browser: launches
 * (or reuses) the pooled Chromium instance, streams diffed JPEG frames at
 * BROWSER_FRAMERATE, and proxies input/navigation. Exported for tests. */
export async function attachSocketToBrowser(
  app: FastifyInstance,
  socket: WebSocket,
  { sessionId, projectId }: AttachBrowserParams,
): Promise<void> {
  let managed;
  try {
    managed = await app.browser.getOrLaunch(projectId);
  } catch (err) {
    app.log.error({ err, sessionId, projectId }, "failed to launch project browser");
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "error", message: (err as Error).message }));
      socket.close();
    }
    return;
  }

  // The socket may already be gone by the time the (possibly slow, first-
  // launch) getOrLaunch() above resolves.
  if (socket.readyState !== socket.OPEN) return;

  // #182 — "when a session spawns a browser pane, record the binding."
  recordSessionBrowserBinding(app, sessionId, projectId);

  const { page, browser } = managed;
  let closed = false;
  let lastFrameHash: string | null = null;

  socket.send(JSON.stringify({ type: "url", url: page.url() }));

  async function captureAndSend() {
    if (closed || socket.readyState !== socket.OPEN) return;
    // Same backpressure posture as terminal.ts: drop this tick for a slow
    // client rather than queuing frames and growing memory unbounded.
    if (socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;

    let frame: Buffer;
    try {
      frame = await page.screenshot({ type: "jpeg", quality: 80 });
    } catch {
      // Page mid-navigation, or the browser/page just closed underneath
      // us — skip this tick, the 'disconnected' listener below handles a
      // real teardown.
      return;
    }

    // Frame diffing (#180): skip sending a byte-identical frame.
    const hash = createHash("sha1").update(frame).digest("hex");
    if (hash === lastFrameHash) return;
    lastFrameHash = hash;

    if (socket.readyState === socket.OPEN) socket.send(frame);
  }

  // Agent hosts have no settings DB (see app.ts's agent branch) and stream
  // at their own env default.
  const framerate = app.hasDecorator("db")
    ? resolveBrowserFramerate(getStoredSettings(app.db), app)
    : Math.max(1, app.config.BROWSER_FRAMERATE);
  const frameTimer = setInterval(
    () => {
      captureAndSend().catch((err) => {
        app.log.warn({ err, sessionId, projectId }, "browser frame capture failed");
      });
    },
    Math.round(1000 / framerate),
  );

  const onNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame() || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: "url", url: page.url() }));
    page
      .title()
      .then((title) => {
        if (socket.readyState === socket.OPEN)
          socket.send(JSON.stringify({ type: "title", title }));
      })
      .catch((err) => {
        app.log.warn({ err, sessionId, projectId }, "failed to read page title after navigation");
      });
  };
  page.on("framenavigated", onNavigated);

  const onDisconnected = () => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "exited" }));
  };
  browser.once("disconnected", onDisconnected);

  socket.on("message", (data, isBinary) => {
    // Unlike terminal.ts's dual raw-bytes/JSON channel, browser input is
    // JSON-only — there's no raw-byte fast path analogous to PTY stdin.
    if (isBinary) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      app.log.warn({ sessionId, projectId }, "dropped malformed browser control message");
      return;
    }

    const message = parseInputMessage(parsed);
    if (!message) return;
    dispatchInput(app, socket, page, message).catch((err) => {
      app.log.warn({ err, sessionId, projectId }, "browser input dispatch failed");
    });
  });

  socket.on("close", () => {
    closed = true;
    clearInterval(frameTimer);
    page.off("framenavigated", onNavigated);
    browser.off("disconnected", onDisconnected);
  });
}

// `clipboard`/`copy`/`cut` flow through this proxy unchanged, like every
// other control message: it forwards opaque JSON bytes in both directions
// with no per-type handling. The one caveat is the backpressure drop each
// direction already has below — a control frame sent while the buffered
// bytes exceed BACKPRESSURE_MAX_BUFFERED_BYTES is silently dropped just like
// a JPEG frame would be, so delivery isn't guaranteed under sustained
// backpressure (pre-existing behavior, not new to these message types).
function proxyToRemoteBrowser(
  app: FastifyInstance,
  browserSocket: WebSocket,
  hostId: string,
  sessionId: number,
  projectId: number,
): void {
  const closeBrowser = () => {
    if (browserSocket.readyState === browserSocket.OPEN) browserSocket.close();
  };

  let upstream: ReturnType<ReturnType<typeof getRemoteHostClient>["openBrowserWs"]>;
  try {
    upstream = getRemoteHostClient(app, hostId).openBrowserWs(sessionId, projectId);
  } catch (err) {
    app.log.error({ err, hostId, sessionId }, "failed to open remote browser WS upgrade");
    closeBrowser();
    return;
  }

  const closeUpstream = () => {
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  };

  browserSocket.on("message", (data, isBinary) => {
    if (upstream.readyState !== upstream.OPEN) return;
    if (upstream.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    upstream.send(data, { binary: isBinary });
  });
  browserSocket.on("close", closeUpstream);

  upstream.on("close", closeBrowser);
  upstream.on("error", (err) => {
    app.log.error({ err, hostId, sessionId }, "remote browser ws upstream error");
    closeBrowser();
  });
  upstream.on("open", () => {
    // Upstream opened
  });
  upstream.on("message", (data, isBinary) => {
    if (browserSocket.readyState !== browserSocket.OPEN) return;
    if (browserSocket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
    browserSocket.send(data, { binary: isBinary });
  });
}

export async function browserRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { sessionId: string } }>(
    "/ws/browser/:sessionId",
    {
      websocket: true,
      // Same "reject before upgrade" posture as terminal.ts's route.
      preValidation: async (request, reply) => {
        if (!app.config.BROWSER_ENABLED) {
          return reply.badRequest(
            "Browser feature is disabled — set BROWSER_ENABLED=true (see issue #179).",
          );
        }

        const sessionId = Number(request.params.sessionId);
        if (!Number.isInteger(sessionId)) {
          return reply.badRequest("sessionId path param is required");
        }

        const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
        if (!row) return reply.notFound(`No session ${sessionId}`);
        if (row.status === "killed") return reply.badRequest(`Session ${sessionId} was killed`);
        if (row.status === "exited") return reply.badRequest(`Session ${sessionId} exited`);
      },
    },
    (socket, req) => {
      // preValidation above already confirmed this session exists.
      const sessionId = Number(req.params.sessionId);
      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      const [project] = app.db.select().from(projects).where(eq(projects.id, row.projectId)).all();
      if (project && project.hostId !== LOCAL_HOST_ID) {
        proxyToRemoteBrowser(app, socket, project.hostId, sessionId, row.projectId);
      } else {
        void attachSocketToBrowser(app, socket, { sessionId, projectId: row.projectId });
      }
    },
  );
}
