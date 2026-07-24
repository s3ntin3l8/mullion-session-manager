import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Real integration test: a genuine WebSocket client against a real listening
// server (app.inject() can't drive a full-duplex upgrade) — same reasoning
// as test/routes/terminal.test.ts. node-pty/systemd-run/dtach are faked
// purely as a side effect of POST /api/sessions eagerly spawning a (mocked)
// pty (src/services/session-backend.ts); this route itself never touches
// app.pty. Playwright is faked the same way test/services/browser-manager.test.ts
// fakes it — never launch a real Chromium in a unit test.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  onData() {
    return { dispose: () => {} };
  }
  onExit() {
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

class FakePage extends EventEmitter {
  private currentUrl: string;
  frameContent = "frame-1";
  titleValue = "Test Page";
  screenshotCalls = 0;
  mouseSpy = { move: vi.fn(), down: vi.fn(), up: vi.fn(), click: vi.fn(), wheel: vi.fn() };
  keyboardSpy = { down: vi.fn(), up: vi.fn(), press: vi.fn() };
  gotoSpy = vi.fn();
  goBackSpy = vi.fn();
  goForwardSpy = vi.fn();
  reloadSpy = vi.fn();

  mouse = {
    move: async (x: number, y: number) => this.mouseSpy.move(x, y),
    down: async (opts?: unknown) => this.mouseSpy.down(opts),
    up: async (opts?: unknown) => this.mouseSpy.up(opts),
    click: async (x: number, y: number, opts?: unknown) => this.mouseSpy.click(x, y, opts),
    wheel: async (dx: number, dy: number) => this.mouseSpy.wheel(dx, dy),
  };
  keyboard = {
    down: async (key: string) => this.keyboardSpy.down(key),
    up: async (key: string) => this.keyboardSpy.up(key),
    press: async (key: string) => this.keyboardSpy.press(key),
  };

  constructor(url: string) {
    super();
    this.currentUrl = url;
  }

  url() {
    return this.currentUrl;
  }

  mainFrame() {
    return this;
  }

  async screenshot() {
    this.screenshotCalls++;
    return Buffer.from(this.frameContent);
  }

  async goto(url: string) {
    this.gotoSpy(url);
    this.currentUrl = url;
    this.emit("framenavigated", this);
  }

  async goBack() {
    this.goBackSpy();
  }

  async goForward() {
    this.goForwardSpy();
  }

  async reload() {
    this.reloadSpy();
  }

  async title() {
    return this.titleValue;
  }
}

class FakeContext {
  async newPage(url: string) {
    return new FakePage(url);
  }
}

class FakeBrowser extends EventEmitter {
  connected = true;
  isConnected() {
    return this.connected;
  }
  async newContext() {
    return new FakeContext();
  }
  async close() {
    this.connected = false;
  }
  simulateCrash() {
    this.connected = false;
    this.emit("disconnected");
  }
}

const launchedPages: FakePage[] = [];

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const browser = new FakeBrowser();
      const context = await browser.newContext();
      // Real BrowserManager.getOrLaunch() calls context.newPage() with no
      // args (Playwright's Page starts at about:blank) — stash a page keyed
      // by launch order so tests can grab a handle without threading
      // browser-manager internals through this mock.
      const page = await context.newPage("about:blank");
      launchedPages.push(page);
      // Real chromium.launch() only returns a Browser; newContext/newPage
      // happen inside BrowserManager. Re-implementing that here would
      // duplicate src/services/browser-manager.ts's own logic in the mock,
      // so instead this mock's `browser.newContext()` is overridden to
      // return the *same* context/page every time, matching what
      // BrowserManager actually does (one context+page per launch).
      browser.newContext = async () => ({
        newPage: async () => page,
        storageState: async () => ({ cookies: [], origins: [] }),
      });
      return browser;
    }),
  },
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `browser-route-test-${process.pid}.db`);

async function waitUntilReal(check: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("condition never became true");
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

function collectMessages(ws: WebSocket): Array<{ binary: boolean; data: Buffer | string }> {
  // Frame capture runs continuously once BROWSER_ENABLED is on, so any test
  // using this helper may receive binary frames regardless of what it's
  // actually asserting on — default binaryType is "blob", and Buffer.from()
  // can't take a Blob directly.
  ws.binaryType = "arraybuffer";
  const messages: Array<{ binary: boolean; data: Buffer | string }> = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      messages.push({ binary: false, data: event.data });
    } else {
      messages.push({ binary: true, data: Buffer.from(event.data as ArrayBuffer) });
    }
  });
  return messages;
}

describe("browser route (/ws/browser/:sessionId)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // High framerate keeps this test's real-time waits short — the route's
    // frame loop uses a genuine setInterval, not a mockable virtual clock.
    process.env.BROWSER_FRAMERATE = "100";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.BROWSER_FRAMERATE;
  });

  async function buildAndListen(browserEnabled = true) {
    if (browserEnabled) process.env.BROWSER_ENABLED = "true";
    else delete process.env.BROWSER_ENABLED;
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  async function createProjectAndSession(app: Awaited<ReturnType<typeof buildApp>>) {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = session.json().id as number;
    return { projectId, sessionId };
  }

  it("rejects when BROWSER_ENABLED is false", async () => {
    const { app, port } = await buildAndListen(false);
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");
    expect(launchedPages).toHaveLength(0);

    await app.close();
  });

  it("rejects an unknown sessionId before the WS upgrade completes", async () => {
    const { app, port } = await buildAndListen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/999999`);
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a non-integer sessionId path param", async () => {
    const { app, port } = await buildAndListen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/not-a-number`);
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("sends an error and closes the socket when the project browser fails to launch", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    // Exhaust the pool (BROWSER_MAX_INSTANCES default 4) with unrelated
    // projects so this session's own getOrLaunch() rejects with "pool
    // exhausted" — exercising the route's launch-failure path without
    // reaching into BrowserManager internals.
    for (let i = 0; i < 4; i++) {
      await app.browser.getOrLaunch(9000 + i);
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    ws.binaryType = "arraybuffer";
    const messages = collectMessages(ws);
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("open");

    await waitUntilReal(() =>
      messages.some((m) => !m.binary && JSON.parse(m.data as string).type === "error"),
    );
    await waitUntilReal(() => ws.readyState === ws.CLOSED);

    await app.close();
  });

  it("streams JPEG frames, skipping byte-identical repeats (frame diffing)", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    ws.binaryType = "arraybuffer";
    const messages = collectMessages(ws);
    await waitForOpenOrClose(ws);

    // First message is the initial JSON "url" announcement.
    await waitUntilReal(() => messages.length > 0);
    expect(messages[0].binary).toBe(false);
    expect(JSON.parse(messages[0].data as string)).toEqual({ type: "url", url: "about:blank" });

    const page = launchedPages[launchedPages.length - 1];

    // Several capture ticks pass with unchanged content — still only one
    // binary frame (the diffing skip), not one per tick.
    await waitUntilReal(() => page.screenshotCalls >= 3);
    const binaryCountAfterIdleTicks = messages.filter((m) => m.binary).length;
    expect(binaryCountAfterIdleTicks).toBe(1);
    expect((messages.find((m) => m.binary)!.data as Buffer).toString("utf8")).toBe("frame-1");

    // Change the frame content — the next tick must send a new binary frame.
    page.frameContent = "frame-2";
    await waitUntilReal(() => messages.filter((m) => m.binary).length === 2);
    const frames = messages.filter((m) => m.binary);
    expect((frames[1].data as Buffer).toString("utf8")).toBe("frame-2");

    ws.close();
    await app.close();
  });

  it("forwards mouse/keyboard input to the page", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    await waitForOpenOrClose(ws);
    const page = launchedPages[launchedPages.length - 1];

    ws.send(JSON.stringify({ type: "mouse", action: "click", x: 10, y: 20, button: "left" }));
    await waitUntilReal(() => page.mouseSpy.click.mock.calls.length > 0);
    expect(page.mouseSpy.click).toHaveBeenCalledWith(10, 20, { button: "left" });

    ws.send(JSON.stringify({ type: "mouse", action: "move", x: 30, y: 40 }));
    await waitUntilReal(() => page.mouseSpy.move.mock.calls.length > 0);
    expect(page.mouseSpy.move).toHaveBeenCalledWith(30, 40);

    ws.send(JSON.stringify({ type: "mouse", action: "down", x: 5, y: 6 }));
    await waitUntilReal(() => page.mouseSpy.down.mock.calls.length > 0);
    expect(page.mouseSpy.down).toHaveBeenCalledWith({ button: "left" });

    ws.send(JSON.stringify({ type: "mouse", action: "up", button: "right", x: 0, y: 0 }));
    await waitUntilReal(() => page.mouseSpy.up.mock.calls.length > 0);
    expect(page.mouseSpy.up).toHaveBeenCalledWith({ button: "right" });

    ws.send(JSON.stringify({ type: "mouse", action: "wheel", x: 0, y: 0, deltaX: 1, deltaY: 2 }));
    await waitUntilReal(() => page.mouseSpy.wheel.mock.calls.length > 0);
    expect(page.mouseSpy.wheel).toHaveBeenCalledWith(1, 2);

    ws.send(JSON.stringify({ type: "key", action: "press", key: "Enter" }));
    await waitUntilReal(() => page.keyboardSpy.press.mock.calls.length > 0);
    expect(page.keyboardSpy.press).toHaveBeenCalledWith("Enter");

    ws.send(JSON.stringify({ type: "key", action: "down", key: "Shift" }));
    await waitUntilReal(() => page.keyboardSpy.down.mock.calls.length > 0);
    expect(page.keyboardSpy.down).toHaveBeenCalledWith("Shift");

    ws.send(JSON.stringify({ type: "key", action: "up", key: "Shift" }));
    await waitUntilReal(() => page.keyboardSpy.up.mock.calls.length > 0);
    expect(page.keyboardSpy.up).toHaveBeenCalledWith("Shift");

    ws.close();
    await app.close();
  });

  it("logs and keeps the connection open when input dispatch throws", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    await waitForOpenOrClose(ws);
    const page = launchedPages[launchedPages.length - 1];
    page.mouseSpy.click.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    ws.send(JSON.stringify({ type: "mouse", action: "click", x: 1, y: 1 }));
    await waitUntilReal(() => page.mouseSpy.click.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ws.readyState).toBe(ws.OPEN);

    ws.close();
    await app.close();
  });

  it("forwards navigate/back/forward/reload to the page", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    await waitForOpenOrClose(ws);
    const page = launchedPages[launchedPages.length - 1];

    ws.send(JSON.stringify({ type: "navigate", url: "https://example.com" }));
    await waitUntilReal(() => page.gotoSpy.mock.calls.length > 0);
    expect(page.gotoSpy).toHaveBeenCalledWith("https://example.com");

    ws.send(JSON.stringify({ type: "back" }));
    await waitUntilReal(() => page.goBackSpy.mock.calls.length > 0);

    ws.send(JSON.stringify({ type: "forward" }));
    await waitUntilReal(() => page.goForwardSpy.mock.calls.length > 0);

    ws.send(JSON.stringify({ type: "reload" }));
    await waitUntilReal(() => page.reloadSpy.mock.calls.length > 0);

    ws.close();
    await app.close();
  });

  it("rejects navigation to a non-http(s) URL", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    await waitForOpenOrClose(ws);
    const page = launchedPages[launchedPages.length - 1];

    ws.send(JSON.stringify({ type: "navigate", url: "file:///etc/passwd" }));
    // Give the (would-be) dispatch a moment to not happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.gotoSpy).not.toHaveBeenCalled();

    ws.close();
    await app.close();
  });

  it("sends url + title updates on navigation", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    const messages = collectMessages(ws);
    await waitForOpenOrClose(ws);
    const page = launchedPages[launchedPages.length - 1];
    page.titleValue = "New Title";

    ws.send(JSON.stringify({ type: "navigate", url: "https://example.com/page" }));

    await waitUntilReal(() =>
      messages.some(
        (m) =>
          !m.binary &&
          JSON.parse(m.data as string).type === "url" &&
          JSON.parse(m.data as string).url === "https://example.com/page",
      ),
    );
    await waitUntilReal(() =>
      messages.some(
        (m) =>
          !m.binary &&
          JSON.parse(m.data as string).type === "title" &&
          JSON.parse(m.data as string).title === "New Title",
      ),
    );

    ws.close();
    await app.close();
  });

  it("notifies the client when the browser disconnects", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    const messages = collectMessages(ws);
    await waitForOpenOrClose(ws);

    const browser = (await import("playwright")).chromium.launch;
    const lastBrowser = (await vi.mocked(browser).mock.results.at(-1)?.value) as FakeBrowser;
    lastBrowser.simulateCrash();

    await waitUntilReal(() =>
      messages.some((m) => !m.binary && JSON.parse(m.data as string).type === "exited"),
    );

    ws.close();
    await app.close();
  });

  it("ignores malformed and unknown control messages without crashing the connection", async () => {
    const { app, port } = await buildAndListen();
    const { sessionId } = await createProjectAndSession(app);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/browser/${sessionId}`);
    await waitForOpenOrClose(ws);

    ws.send("not json{{{");
    ws.send(JSON.stringify({ type: "unknown-thing" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ws.readyState).toBe(ws.OPEN);

    ws.close();
    await app.close();
  });
});
