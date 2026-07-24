import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import type { Page, Frame } from "playwright";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";

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

interface MouseInputMessage {
  type: "mouse";
  action: "move" | "down" | "up" | "click" | "wheel";
  x: number;
  y: number;
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

type BrowserInputMessage =
  MouseInputMessage | KeyInputMessage | NavigateInputMessage | HistoryInputMessage;

function isMouseMessage(value: unknown): value is MouseInputMessage {
  const v = value as Partial<MouseInputMessage> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.type === "mouse" &&
    typeof v.action === "string" &&
    ["move", "down", "up", "click", "wheel"].includes(v.action) &&
    typeof v.x === "number" &&
    typeof v.y === "number"
  );
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

function parseInputMessage(value: unknown): BrowserInputMessage | null {
  if (isMouseMessage(value)) return value;
  if (isKeyMessage(value)) return value;
  if (isNavigateMessage(value)) return value;
  if (isHistoryMessage(value)) return value;
  return null;
}

// Only http(s) — page.goto() otherwise happily navigates a headless
// Chromium this process controls to file:// (reads the host filesystem) or
// chrome:// internals, which a screenshot would then exfiltrate straight
// back over this same authenticated WS. Mirrors BrowserPanel.tsx's own
// isDangerousIframeSrc guard on the existing iframe preview.
function isSafeNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function dispatchInput(
  app: FastifyInstance,
  page: Page,
  message: BrowserInputMessage,
): Promise<void> {
  switch (message.type) {
    case "mouse":
      switch (message.action) {
        case "move":
          await page.mouse.move(message.x, message.y);
          break;
        case "down":
          await page.mouse.move(message.x, message.y);
          await page.mouse.down({ button: message.button ?? "left" });
          break;
        case "up":
          await page.mouse.up({ button: message.button ?? "left" });
          break;
        case "click":
          await page.mouse.click(message.x, message.y, { button: message.button ?? "left" });
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

  const framerate = Math.max(1, app.config.BROWSER_FRAMERATE);
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
      .catch(() => {});
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
    dispatchInput(app, page, message).catch((err) => {
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
      void attachSocketToBrowser(app, socket, { sessionId, projectId: row.projectId });
    },
  );
}
