import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// POST /api/sessions/:id/browser and its /find sibling are plain REST
// endpoints, so app.inject() (not a real WebSocket) exercises them fully —
// no server/listen setup needed, unlike test/routes/browser.test.ts.
// node-pty/child_process are faked purely as a side effect of POST
// /api/sessions eagerly spawning a (mocked) pty (session-backend.ts); these
// routes never touch app.pty. Playwright is faked the same way
// test/services/browser-manager.test.ts and test/routes/browser.test.ts fake
// it — never launch a real Chromium in a unit test.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
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

interface FakeSnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
}

class FakeLocator {
  clickSpy = vi.fn(async () => {});
  fillSpy = vi.fn(async (_value: string) => {});
  evaluateSpy = vi.fn(async (_script: string, arg?: unknown) => ({
    ref: arg,
    role: "button",
    name: "Submit",
    tag: "button",
  }));
  ariaSnapshotSpy = vi.fn(async () => "- generic: Hello");
  allResult: FakeLocator[] = [];

  async click() {
    return this.clickSpy();
  }
  async fill(value: string) {
    return this.fillSpy(value);
  }
  async evaluate(script: string, arg?: unknown) {
    return this.evaluateSpy(script, arg);
  }
  async ariaSnapshot() {
    return this.ariaSnapshotSpy();
  }
  async all() {
    return this.allResult;
  }
}

class FakePage {
  currentUrl = "about:blank";
  titleValue = "Test Page";
  screenshotBuffer = Buffer.from("PNGDATA");
  evalResult: unknown = null;
  taggedElementsResult: FakeSnapshotElement[] = [];
  gotoSpy = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  evaluateSpy = vi.fn();
  bodyLocator = new FakeLocator();
  refLocators = new Map<string, FakeLocator>();
  selectorLocators = new Map<string, FakeLocator>();
  getByTextResult = new FakeLocator();
  getByRoleResult = new FakeLocator();
  getByLabelResult = new FakeLocator();
  getByPlaceholderResult = new FakeLocator();
  getByTestIdResult = new FakeLocator();

  url() {
    return this.currentUrl;
  }
  async title() {
    return this.titleValue;
  }
  async goto(url: string, opts?: unknown) {
    return this.gotoSpy(url, opts);
  }
  async screenshot() {
    return this.screenshotBuffer;
  }
  async evaluate(script: string) {
    this.evaluateSpy(script);
    if (script.includes("data-mullion-ref")) return this.taggedElementsResult;
    return this.evalResult;
  }
  locator(selector: string) {
    if (selector === "body") return this.bodyLocator;
    const refMatch = /\[data-mullion-ref="([^"]+)"\]/.exec(selector);
    if (refMatch) return this.refLocators.get(refMatch[1]) ?? new FakeLocator();
    return this.selectorLocators.get(selector) ?? new FakeLocator();
  }
  getByText() {
    return this.getByTextResult;
  }
  getByRole() {
    return this.getByRoleResult;
  }
  getByLabel() {
    return this.getByLabelResult;
  }
  getByPlaceholder() {
    return this.getByPlaceholderResult;
  }
  getByTestId() {
    return this.getByTestIdResult;
  }
}

class FakeBrowser extends EventEmitter {
  connected = true;
  isConnected() {
    return this.connected;
  }
  async newContext() {
    return { newPage: async () => new FakePage(), storageState: async () => ({}) };
  }
  async close() {
    this.connected = false;
  }
}

const launchedPages: FakePage[] = [];

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const browser = new FakeBrowser();
      const page = new FakePage();
      launchedPages.push(page);
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

const tmpDb = path.join(os.tmpdir(), `browser-automation-test-${process.pid}.db`);

describe("browser automation API (issue #183)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.BROWSER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.BROWSER_ENABLED;
  });

  afterEach(() => {
    launchedPages.length = 0;
  });

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
    // Pre-launches the project's browser (idempotent — the route handler's
    // own getOrLaunch reuses this same pooled instance) so launchedPages[0]
    // is populated *before* each test configures its FakePage's return
    // values, rather than only becoming available partway through the
    // route handler under test. Swallowed when the disabled-flag test below
    // has deliberately turned BROWSER_ENABLED off first — that test never
    // reads launchedPages anyway.
    await app.browser.getOrLaunch(projectId).catch(() => {});
    return { projectId, sessionId: session.json().id as number };
  }

  it("400s when BROWSER_ENABLED is false", async () => {
    delete process.env.BROWSER_ENABLED;
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(400);

    process.env.BROWSER_ENABLED = "true";
    await app.close();
  });

  it("404s for an unknown session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/999999/browser",
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400s for a non-integer session id", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/not-a-number/browser",
      payload: { action: "snapshot" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("snapshot returns url/title/tree/elements", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    page.taggedElementsResult = [{ ref: "e1", role: "button", name: "Go", tag: "button" }];
    page.bodyLocator.ariaSnapshotSpy.mockResolvedValue("- button: Go");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "snapshot" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.url).toBe("about:blank");
    expect(body.title).toBe("Test Page");
    expect(body.snapshot.tree).toBe("- button: Go");
    expect(body.snapshot.elements).toEqual([
      { ref: "e1", role: "button", name: "Go", tag: "button" },
    ]);

    await app.close();
  });

  it("navigate calls page.goto with the given url and wait_until", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "navigate", url: "https://example.com", wait_until: "networkidle" },
    });

    expect(res.statusCode).toBe(200);
    expect(page.gotoSpy).toHaveBeenCalledWith("https://example.com", { waitUntil: "networkidle" });

    await app.close();
  });

  it("rejects navigate to a non-http(s) url", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "navigate", url: "file:///etc/passwd" },
    });

    expect(res.statusCode).toBe(400);
    expect(page.gotoSpy).not.toHaveBeenCalled();

    await app.close();
  });

  it("click resolves a ref and clicks it", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    const target = new FakeLocator();
    page.refLocators.set("e1", target);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "click", ref: "e1" },
    });

    expect(res.statusCode).toBe(200);
    expect(target.clickSpy).toHaveBeenCalled();

    await app.close();
  });

  it("click resolves a raw selector and clicks it", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    const target = new FakeLocator();
    page.selectorLocators.set("#submit", target);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "click", selector: "#submit" },
    });

    expect(res.statusCode).toBe(200);
    expect(target.clickSpy).toHaveBeenCalled();

    await app.close();
  });

  it("click without a selector or ref is a 400", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "click" },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("fill resolves a ref and fills it with the given value", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    const target = new FakeLocator();
    page.refLocators.set("e2", target);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "fill", ref: "e2", value: "hello world" },
    });

    expect(res.statusCode).toBe(200);
    expect(target.fillSpy).toHaveBeenCalledWith("hello world");

    await app.close();
  });

  it("eval runs the script in the page and returns its result", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    page.evalResult = 42;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "eval", script: "1 + 41" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe(42);
    expect(page.evaluateSpy).toHaveBeenCalledWith("1 + 41");

    await app.close();
  });

  it("screenshot returns a base64 PNG", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "screenshot" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().screenshot).toBe(Buffer.from("PNGDATA").toString("base64"));

    await app.close();
  });

  it("returns 400 with the error message when an action throws (e.g. element not found)", async () => {
    const app = await buildApp();
    const { sessionId } = await createProjectAndSession(app);
    const page = launchedPages[0];
    const target = new FakeLocator();
    target.clickSpy.mockRejectedValueOnce(new Error("element not found: #missing"));
    page.selectorLocators.set("#missing", target);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "click", selector: "#missing" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("element not found");

    await app.close();
  });

  describe("POST /api/sessions/:id/browser/find", () => {
    it("finds elements by text and tags each with a ref", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const match1 = new FakeLocator();
      const match2 = new FakeLocator();
      match1.evaluateSpy.mockResolvedValue({ ref: "e1", role: "link", name: "Home", tag: "a" });
      match2.evaluateSpy.mockResolvedValue({ ref: "e2", role: "link", name: "Home", tag: "a" });
      page.getByTextResult.allResult = [match1, match2];

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser/find`,
        payload: { by: "text", value: "Home" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.matchCount).toBe(2);
      expect(body.elements).toEqual([
        { ref: "e1", role: "link", name: "Home", tag: "a" },
        { ref: "e2", role: "link", name: "Home", tag: "a" },
      ]);

      await app.close();
    });

    it("caps results at the given limit", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const matches = Array.from({ length: 5 }, (_, i) => {
        const m = new FakeLocator();
        m.evaluateSpy.mockResolvedValue({ ref: `e${i}`, role: "button", name: "x", tag: "button" });
        return m;
      });
      page.getByRoleResult.allResult = matches;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser/find`,
        payload: { by: "role", value: "button", limit: 2 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.matchCount).toBe(5);
      expect(body.elements).toHaveLength(2);

      await app.close();
    });

    it("finds by label/placeholder/testid via the matching Playwright locator method", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const labelMatch = new FakeLocator();
      labelMatch.evaluateSpy.mockResolvedValue({
        ref: "e1",
        role: "textbox",
        name: "Email",
        tag: "input",
      });
      page.getByLabelResult.allResult = [labelMatch];

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser/find`,
        payload: { by: "label", value: "Email" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().elements).toEqual([
        { ref: "e1", role: "textbox", name: "Email", tag: "input" },
      ]);

      await app.close();
    });

    it("400s on an invalid `by` value", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/1/browser/find",
        payload: { by: "bogus", value: "x" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s for an unknown session", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/browser/find",
        payload: { by: "text", value: "Home" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns 400 with the error message when the locator query throws", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.getByTestIdResult.allResult = [];
      vi.spyOn(page.getByTestIdResult, "all").mockRejectedValueOnce(
        new Error("evaluation failed: bad selector"),
      );

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser/find`,
        payload: { by: "testid", value: "submit-btn" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("bad selector");

      await app.close();
    });
  });
});
