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
  pressSpy = vi.fn(async () => {});
  typeSpy = vi.fn(async () => {});
  selectOptionSpy = vi.fn(async () => []);
  checkSpy = vi.fn(async () => {});
  uncheckSpy = vi.fn(async () => {});
  waitForSpy = vi.fn(async () => {});
  hoverSpy = vi.fn(async () => {});
  scrollIntoViewIfNeededSpy = vi.fn(async () => {});
  innerTextSpy = vi.fn(async () => "inner-text-val");
  inputValueSpy = vi.fn(async () => "input-val");
  isCheckedSpy = vi.fn(async () => true);
  // Issue #382 (3.11) — resolveSearchRoot's own resolution path:
  // page.locator(frameSelector).elementHandle() then .contentFrame().
  // Defaults to "no handle" (selector matched nothing); tests targeting an
  // iframe host element override this to resolve a FakeFrame, or to
  // resolve a handle whose contentFrame() is null (matched a non-iframe
  // element).
  elementHandleSpy = vi.fn(
    async (): Promise<{ contentFrame: () => Promise<FakeFrame | null> } | null> => null,
  );

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
  async press(value: string) {
    return this.pressSpy(value);
  }
  async type(value: string) {
    return this.typeSpy(value);
  }
  async selectOption(value: unknown) {
    return this.selectOptionSpy(value);
  }
  async check() {
    return this.checkSpy();
  }
  async uncheck() {
    return this.uncheckSpy();
  }
  async waitFor() {
    return this.waitForSpy();
  }
  async hover() {
    return this.hoverSpy();
  }
  async scrollIntoViewIfNeeded() {
    return this.scrollIntoViewIfNeededSpy();
  }
  async innerText() {
    return this.innerTextSpy();
  }
  async inputValue() {
    return this.inputValueSpy();
  }
  async isChecked() {
    return this.isCheckedSpy();
  }
  async elementHandle() {
    return this.elementHandleSpy();
  }
}

// Issue #382 (3.11) — a fake `Frame`: implements exactly the SearchRoot
// surface executeBrowserAction/executeBrowserFind actually call on it
// (`locator`, `evaluate`, `waitForSelector`, `content`, the `getBy*`
// family), independent of FakePage so a frame-scoped action's snapshot/
// tagging is provably distinct from the top-level page's.
class FakeFrame {
  bodyLocator = new FakeLocator();
  refLocators = new Map<string, FakeLocator>();
  selectorLocators = new Map<string, FakeLocator>();
  taggedElementsResult: FakeSnapshotElement[] = [];
  evalResult: unknown = null;
  evaluateSpy = vi.fn();
  getByTextResult = new FakeLocator();
  getByRoleResult = new FakeLocator();
  getByLabelResult = new FakeLocator();
  getByPlaceholderResult = new FakeLocator();
  getByTestIdResult = new FakeLocator();
  waitForSelectorSpy = vi.fn(async () => {});
  contentSpy = vi.fn(async () => "<html>frame</html>");

  locator(selector: string) {
    if (selector === "body") return this.bodyLocator;
    const refMatch = /\[data-mullion-ref="([^"]+)"\]/.exec(selector);
    if (refMatch) return this.refLocators.get(refMatch[1]) ?? new FakeLocator();
    return this.selectorLocators.get(selector) ?? new FakeLocator();
  }
  async evaluate(script: string) {
    this.evaluateSpy(script);
    if (script.includes("data-mullion-ref")) return this.taggedElementsResult;
    return this.evalResult;
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
  async waitForSelector(selector: string) {
    return this.waitForSelectorSpy(selector);
  }
  async content() {
    return this.contentSpy();
  }
}

class FakePage extends EventEmitter {
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
  waitForTimeoutSpy = vi.fn(async () => {});
  waitForSelectorSpy = vi.fn(async () => {});
  contentSpy = vi.fn(async () => "<html></html>");

  keyboard = {
    down: vi.fn(async () => {}),
    up: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
  };

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
  async waitForTimeout(timeout: number) {
    return this.waitForTimeoutSpy(timeout);
  }
  async waitForSelector(selector: string) {
    return this.waitForSelectorSpy(selector);
  }
  async content() {
    return this.contentSpy();
  }
}

// Issue #381 (3.10) — a fake Playwright `Download`, implementing exactly the
// surface BrowserManager's page.on("download") handler calls. saveAs
// actually writes real bytes to the given path (not just a spy call) so the
// `download` action's own file-reading (for `contents`) has something real
// to read.
class FakeDownload {
  constructor(
    private readonly filename: string,
    private readonly contents = Buffer.from("fake download contents"),
    private readonly urlValue = "http://example.com/report.csv",
  ) {}

  saveAsSpy = vi.fn(async (destPath: string) => {
    fs.writeFileSync(destPath, this.contents);
  });

  suggestedFilename() {
    return this.filename;
  }

  url() {
    return this.urlValue;
  }

  async saveAs(destPath: string) {
    return this.saveAsSpy(destPath);
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
const { clampDownloadTimeoutMs, clampDownloadMaxBytes } =
  await import("../../src/routes/browser-automation.js");

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
      payload: { createDir: true, name: "p", cwd: "/tmp" },
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

    // Regression test for a real bug (found while building the opt-in e2e
    // suite against a live Playwright browser, issue #407): the ref-tagging
    // script was passed to Locator.evaluate() as a template-literal STRING
    // rather than a real function reference. Playwright's Locator.evaluate
    // only invokes its first argument when it's actually a function —
    // passed a string, it never runs the tagger at all, so `find` silently
    // returned an unusable result against any real browser. The FakeLocator
    // mock above returns a canned object regardless of what's passed as the
    // first argument, so none of the other tests in this file would catch a
    // regression back to the string form — this test asserts the actual
    // shape of what's passed, not just what the mock returns for it.
    it("passes a real function (not a string) to Locator.evaluate, and that function tags the element correctly", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const match = new FakeLocator();
      page.getByTextResult.allResult = [match];

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser/find`,
        payload: { by: "text", value: "Submit" },
      });
      expect(res.statusCode).toBe(200);

      expect(match.evaluateSpy).toHaveBeenCalledTimes(1);
      const [fn, arg] = match.evaluateSpy.mock.calls[0];
      expect(typeof fn).toBe("function");

      // Invoke the real tagger against a stub DOM element, exactly what
      // Playwright's in-page evaluation does for a real function argument
      // (see UtilityScript.evaluate: isFunction ? result(...params) : result).
      const setAttribute = vi.fn();
      const stubElement = {
        setAttribute,
        getAttribute: (name: string) => (name === "aria-label" ? "Submit form" : null),
        innerText: "",
        tagName: "BUTTON",
      };
      const tagged = fn(stubElement, arg);
      expect(setAttribute).toHaveBeenCalledWith(arg.refAttribute, arg.ref);
      expect(tagged).toEqual({ ref: arg.ref, role: "button", name: "Submit form", tag: "button" });

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

  describe("new browser automation features (Feature 3.7)", () => {
    it("supports press action on locator and keyboard", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "press", selector: "#target", value: "Enter" },
      });
      expect(res1.statusCode).toBe(200);
      expect(locator.pressSpy).toHaveBeenCalledWith("Enter");

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "press", value: "Space" },
      });
      expect(res2.statusCode).toBe(200);
      expect(page.keyboard.press).toHaveBeenCalledWith("Space");

      await app.close();
    });

    it("supports type action on locator and keyboard", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "type", selector: "#target", value: "hello" },
      });
      expect(res1.statusCode).toBe(200);
      expect(locator.typeSpy).toHaveBeenCalledWith("hello");

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "type", value: "world" },
      });
      expect(res2.statusCode).toBe(200);
      expect(page.keyboard.type).toHaveBeenCalledWith("world");

      await app.close();
    });

    it("supports select, check, and uncheck actions", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "select", selector: "#target", value: "opt1" },
      });
      expect(res1.statusCode).toBe(200);
      expect(locator.selectOptionSpy).toHaveBeenCalledWith("opt1");

      // Multi-select: `value` also accepts an array of strings (Phase 4,
      // #134 PR6's `mullion browser select` sends one for 2+ values) —
      // previously rejected by the ajv schema before it ever reached here.
      const resMulti = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "select", selector: "#target", value: ["opt1", "opt2"] },
      });
      expect(resMulti.statusCode).toBe(200);
      expect(locator.selectOptionSpy).toHaveBeenCalledWith(["opt1", "opt2"]);

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "check", selector: "#target" },
      });
      expect(res2.statusCode).toBe(200);
      expect(locator.checkSpy).toHaveBeenCalled();

      const res3 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "uncheck", selector: "#target" },
      });
      expect(res3.statusCode).toBe(200);
      expect(locator.uncheckSpy).toHaveBeenCalled();

      await app.close();
    });

    it("supports wait action with timeouts, selectors, and locators", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "wait", value: 1000 },
      });
      expect(res1.statusCode).toBe(200);
      expect(page.waitForTimeoutSpy).toHaveBeenCalledWith(1000);

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "wait", value: "#target" },
      });
      expect(res2.statusCode).toBe(200);
      expect(page.waitForSelectorSpy).toHaveBeenCalledWith("#target");

      const res3 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "wait", selector: "#target" },
      });
      expect(res3.statusCode).toBe(200);
      expect(locator.waitForSpy).toHaveBeenCalled();

      await app.close();
    });

    it("supports hover and scroll actions", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "hover", selector: "#target" },
      });
      expect(res1.statusCode).toBe(200);
      expect(locator.hoverSpy).toHaveBeenCalled();

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "scroll", selector: "#target" },
      });
      expect(res2.statusCode).toBe(200);
      expect(locator.scrollIntoViewIfNeededSpy).toHaveBeenCalled();

      await app.close();
    });

    it("supports get action to read innerText, value, checked, or html", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const locator = new FakeLocator();
      page.selectorLocators.set("#target", locator);

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "get", selector: "#target" },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().text).toBe("inner-text-val");
      expect(res1.json().value).toBe("input-val");
      expect(res1.json().checked).toBe(true);

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "get" },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().html).toBe("<html></html>");

      await app.close();
    });

    it("supports console and pageerror circular logging buffers", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];

      const consoleMsgMock = {
        type: () => "log",
        text: () => "Test log message",
      };
      page.emit("console", consoleMsgMock);

      const errorMock = new Error("Test page error");
      page.emit("pageerror", errorMock);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "console" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().logs).toBeDefined();
      expect(res.json().logs[0].text).toBe("Test log message");
      expect(res.json().errors[0].message).toBe("Test page error");

      await app.close();
    });

    it("supports dialog auto-accepting confirm/alert and overridable behavior", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];

      const acceptSpy = vi.fn();
      const dismissSpy = vi.fn();
      const mockDialog = (type: string) => ({
        type: () => type,
        accept: async (text: string) => acceptSpy(text),
        dismiss: async () => dismissSpy(),
      });

      page.emit("dialog", mockDialog("alert"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(acceptSpy).toHaveBeenCalled();

      page.emit("dialog", mockDialog("prompt"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(dismissSpy).toHaveBeenCalled();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "dialog", value: "accept", text: "override text" },
      });
      expect(res.statusCode).toBe(200);

      acceptSpy.mockClear();
      page.emit("dialog", mockDialog("prompt"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(acceptSpy).toHaveBeenCalledWith("override text");

      await app.close();
    });
  });

  describe("download action (issue #381, 3.10)", () => {
    it("returns immediately when a download is already buffered — no waiting", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];

      page.emit("download", new FakeDownload("report.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const start = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", timeout_ms: 5000 },
      });
      const elapsed = Date.now() - start;

      expect(res.statusCode).toBe(200);
      expect(res.json().downloads).toHaveLength(1);
      expect(res.json().downloads[0].filename).toBe("report.csv");
      // Proves it didn't wait out anywhere near the 5000ms timeout.
      expect(elapsed).toBeLessThan(2000);

      await app.close();
    });

    it("waits up to timeout_ms for a download that arrives after the call, and returns it", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];

      setTimeout(() => {
        page.emit("download", new FakeDownload("late.csv"));
      }, 100);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", timeout_ms: 2000 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().downloads).toHaveLength(1);
      expect(res.json().downloads[0].filename).toBe("late.csv");

      await app.close();
    });

    it("returns an empty list when the timeout elapses with no download", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", timeout_ms: 100 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().downloads).toEqual([]);

      await app.close();
    });

    // A wall-clock request/response test proving "timeout_ms: 999999999
    // doesn't hang the request" would itself have to wait out the clamped
    // 120s value. Asserted directly against the exported clamp functions
    // instead — deterministic, and doesn't need fake timers wrapped around
    // a whole app.inject() call.
    it("clampDownloadTimeoutMs clamps an over-cap value down to 120000, and defaults when omitted", () => {
      expect(clampDownloadTimeoutMs(999_999_999)).toBe(120_000);
      expect(clampDownloadTimeoutMs(undefined)).toBe(30_000);
      expect(clampDownloadTimeoutMs(500)).toBe(500);
      expect(clampDownloadTimeoutMs(-50)).toBe(0);
    });

    it("clampDownloadMaxBytes clamps an over-cap value down to the 1 MiB hard cap, and defaults to it when omitted", () => {
      expect(clampDownloadMaxBytes(100 * 1024 * 1024)).toBe(1_048_576);
      expect(clampDownloadMaxBytes(undefined)).toBe(1_048_576);
      expect(clampDownloadMaxBytes(1024)).toBe(1024);
      expect(clampDownloadMaxBytes(0)).toBe(1_048_576);
      expect(clampDownloadMaxBytes(-1)).toBe(1_048_576);
    });

    it("includes contents as base64 when requested and within max_bytes", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("small.csv", Buffer.from("a,b,c\n1,2,3")));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", contents: true },
      });

      expect(res.statusCode).toBe(200);
      const [entry] = res.json().downloads;
      expect(entry.truncated).toBeUndefined();
      expect(Buffer.from(entry.contents, "base64").toString("utf8")).toBe("a,b,c\n1,2,3");

      await app.close();
    });

    it("omits contents and sets truncated: true when the file exceeds max_bytes, without truncating the base64 string itself", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("big.bin", Buffer.alloc(2048, 1)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", contents: true, max_bytes: 1024 },
      });

      expect(res.statusCode).toBe(200);
      const [entry] = res.json().downloads;
      expect(entry.truncated).toBe(true);
      expect(entry.contents).toBeUndefined();

      await app.close();
    });

    it("bounds a single response's TOTAL contents payload to the 1 MiB cap, not just each entry individually (independent review finding)", async () => {
      // Each of these three is individually well under the default 1 MiB
      // max_bytes, so a purely per-entry check would happily base64 all
      // three into one response — reaching ~2.4 MiB of base64 across the
      // response, defeating the whole reason max_bytes is tied to the
      // control socket's 2 MiB line cap. The running budget must instead
      // truncate whichever entries don't fit in the CUMULATIVE 1 MiB, not
      // just check each one against the per-entry cap in isolation.
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const chunk = Buffer.alloc(400 * 1024, 1); // 400 KiB each, well under 1 MiB alone
      page.emit("download", new FakeDownload("first.bin", chunk));
      await new Promise((resolve) => setTimeout(resolve, 20));
      page.emit("download", new FakeDownload("second.bin", chunk));
      await new Promise((resolve) => setTimeout(resolve, 20));
      page.emit("download", new FakeDownload("third.bin", chunk));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", contents: true },
      });

      expect(res.statusCode).toBe(200);
      const downloads = res.json().downloads;
      expect(downloads).toHaveLength(3);
      const withContents = downloads.filter((d: { contents?: string }) => d.contents !== undefined);
      const totalBase64Bytes = withContents.reduce(
        (sum: number, d: { contents: string }) => sum + d.contents.length,
        0,
      );
      // Not all 3 can have fit (3 * 400 KiB = 1200 KiB > 1024 KiB budget) —
      // at least one must be truncated instead.
      expect(withContents.length).toBeLessThan(3);
      expect(downloads.some((d: { truncated?: boolean }) => d.truncated === true)).toBe(true);
      // The actual base64 emitted must stay within the 1 MiB raw-byte
      // budget's own base64-inflated bound (~4/3), not merely "less than
      // the sum of all three".
      expect(totalBase64Bytes).toBeLessThanOrEqual(Math.ceil((1024 * 1024 * 4) / 3));

      await app.close();
    });

    it("clamps an over-cap max_bytes down to the 1 MiB hard cap rather than exceeding it", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      // Bigger than 1 MiB — must still be reported truncated even though the
      // caller asked for a max_bytes far above the hard cap.
      page.emit("download", new FakeDownload("huge.bin", Buffer.alloc(2 * 1024 * 1024, 1)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", contents: true, max_bytes: 100 * 1024 * 1024 },
      });

      expect(res.statusCode).toBe(200);
      const [entry] = res.json().downloads;
      expect(entry.truncated).toBe(true);
      expect(entry.contents).toBeUndefined();

      await app.close();
    });

    it("omits both contents and truncated when contents wasn't requested at all", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("plain.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download" },
      });

      expect(res.statusCode).toBe(200);
      const [entry] = res.json().downloads;
      expect(entry.contents).toBeUndefined();
      expect(entry.truncated).toBeUndefined();

      await app.close();
    });

    it("returns downloads newest-first", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("first.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      page.emit("download", new FakeDownload("second.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download" },
      });

      expect(res.statusCode).toBe(200);
      const filenames = res.json().downloads.map((d: { filename: string }) => d.filename);
      expect(filenames).toEqual(["second.csv", "first.csv"]);

      await app.close();
    });

    it("clear removes exactly the returned entries, by identity, not the whole buffer", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("a.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res1 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", clear: true },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().downloads).toHaveLength(1);

      const res2 = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", timeout_ms: 50 },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().downloads).toEqual([]);

      await app.close();
    });

    it("clear does not drop a download that completes concurrently, between reading and clearing", async () => {
      const app = await buildApp();
      const { sessionId, projectId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("existing.csv"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Simulate a second download landing in the managed.downloads array
      // AFTER the route has already read it (to build its response) but
      // BEFORE it splices — by monkeypatching indexOf on the array to push a
      // concurrent entry the first time it's called, mid-clear.
      const managed = await app.browser.getOrLaunch(projectId);
      const originalIndexOf = managed.downloads.indexOf.bind(managed.downloads);
      let injected = false;
      managed.downloads.indexOf = ((...args: Parameters<typeof originalIndexOf>) => {
        if (!injected) {
          injected = true;
          managed.downloads.push({
            filename: "concurrent.csv",
            path: "/tmp/concurrent.csv",
            url: "http://example.com/concurrent.csv",
            size: 3,
            timestamp: Date.now(),
          });
        }
        return originalIndexOf(...args);
      }) as typeof originalIndexOf;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download", clear: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().downloads.map((d: { filename: string }) => d.filename)).toEqual([
        "existing.csv",
      ]);
      // The concurrently-arrived entry must survive the clear — a blunt
      // `length = 0`/reassignment would have discarded it too.
      expect(managed.downloads.some((d) => d.filename === "concurrent.csv")).toBe(true);
      expect(managed.downloads.some((d) => d.filename === "existing.csv")).toBe(false);

      await app.close();
    });

    it("sanitizes a suggestedFilename containing '../' and path separators before saving", async () => {
      const app = await buildApp();
      const { sessionId, projectId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      page.emit("download", new FakeDownload("../../../etc/passwd"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "download" },
      });

      expect(res.statusCode).toBe(200);
      const [entry] = res.json().downloads;
      expect(entry.filename).not.toContain("..");
      expect(entry.filename).not.toContain("/");
      const managed = await app.browser.getOrLaunch(projectId);
      const expectedDir = path.join(
        app.config.BROWSER_DATA_DIR,
        "downloads",
        `project-${projectId}`,
      );
      const resolvedExpectedDir = fs.existsSync(expectedDir)
        ? fs.realpathSync(expectedDir)
        : path.resolve(expectedDir);
      expect(
        path.resolve(managed.downloads[0].path).startsWith(resolvedExpectedDir + path.sep),
      ).toBe(true);

      await app.close();
    });

    it("evicts the oldest entries beyond the 50-entry cap and deletes their files from disk", async () => {
      const app = await buildApp();
      const { projectId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const managed = await app.browser.getOrLaunch(projectId);

      // Poll for each download's own entry to land before firing the next
      // — a blind fixed sleep here would be flaky (the handler's real,
      // if tiny, disk I/O 51 times over won't reliably fit inside an
      // arbitrary constant) and firing all 51 with no per-step wait would
      // leave no ordering guarantee between concurrently in-flight
      // handlers, making "file-0 was the one evicted" a race.
      for (let i = 0; i < 51; i++) {
        page.emit("download", new FakeDownload(`file-${i}.txt`));
        const deadline = Date.now() + 2000;
        while (managed.downloads.at(-1)?.filename !== `file-${i}.txt` && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      expect(managed.downloads).toHaveLength(50);
      expect(managed.downloads.some((d) => d.filename === "file-0.txt")).toBe(false);

      await app.close();
    });
  });

  describe("frame field (issue #382, 3.11)", () => {
    /** Wires up `page.locator("#iframe-host").elementHandle()` to resolve a
     * fresh FakeFrame's contentFrame(), the same two-step resolution
     * resolveSearchRoot performs against a real Playwright Page. */
    function bindFrame(page: FakePage, selector: string) {
      const hostLocator = new FakeLocator();
      const frame = new FakeFrame();
      hostLocator.elementHandleSpy.mockResolvedValue({
        contentFrame: async () => frame,
      });
      page.selectorLocators.set(selector, hostLocator);
      return frame;
    }

    it("click with frame resolves into the iframe and clicks the real target inside it", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const frame = bindFrame(page, "#iframe-host");
      const inner = new FakeLocator();
      frame.selectorLocators.set("#inner-btn", inner);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "click", frame: "#iframe-host", selector: "#inner-btn" },
      });

      expect(res.statusCode).toBe(200);
      expect(inner.clickSpy).toHaveBeenCalled();

      await app.close();
    });

    it("throws a distinct error when the frame selector matches no element at all (Hermes review, PR #429)", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      // FakeLocator's elementHandleSpy defaults to resolving null — a
      // locator that never matches any element, distinct from the
      // "matched, but not an iframe" case below.
      page.selectorLocators.set("#nonexistent", new FakeLocator());

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "click", frame: "#nonexistent", selector: "#inner-btn" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("matched no element");

      await app.close();
    });

    it("throws when the frame selector does not resolve to an iframe", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const hostLocator = new FakeLocator();
      hostLocator.elementHandleSpy.mockResolvedValue({ contentFrame: async () => null });
      page.selectorLocators.set("#not-an-iframe", hostLocator);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "click", frame: "#not-an-iframe", selector: "#inner-btn" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("element is not an iframe");

      await app.close();
    });

    it("rejects frame on navigate/screenshot/dialog/console/errors/download", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);

      for (const payload of [
        { action: "navigate", url: "https://example.com", frame: "#x" },
        { action: "screenshot", frame: "#x" },
        { action: "dialog", frame: "#x" },
        { action: "console", frame: "#x" },
        { action: "errors", frame: "#x" },
        { action: "download", frame: "#x" },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/browser`,
          payload,
        });
        expect(res.statusCode, `action ${payload.action}`).toBe(400);
        expect(res.json().message).toContain("does not take a 'frame' field");
      }

      await app.close();
    });

    it("rejects frame on press/type when no target is given, but allows it with one", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const frame = bindFrame(page, "#iframe-host");
      const inner = new FakeLocator();
      frame.selectorLocators.set("#inner-input", inner);

      const noTarget = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "press", frame: "#iframe-host", value: "Enter" },
      });
      expect(noTarget.statusCode).toBe(400);
      expect(noTarget.json().message).toContain("requires a target");

      const withTarget = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: {
          action: "press",
          frame: "#iframe-host",
          selector: "#inner-input",
          value: "Enter",
        },
      });
      expect(withTarget.statusCode).toBe(200);
      expect(inner.pressSpy).toHaveBeenCalledWith("Enter");

      await app.close();
    });

    it("response envelope includes frame and a frame-scoped snapshot, not the page's", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const frame = bindFrame(page, "#iframe-host");
      frame.taggedElementsResult = [
        { ref: "e1", role: "button", name: "Inner button", tag: "button" },
      ];
      frame.bodyLocator.ariaSnapshotSpy.mockResolvedValue("- button: Inner button");
      page.taggedElementsResult = [
        { ref: "e1", role: "button", name: "Page button", tag: "button" },
      ];
      page.bodyLocator.ariaSnapshotSpy.mockResolvedValue("- button: Page button");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "snapshot", frame: "#iframe-host" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.frame).toBe("#iframe-host");
      expect(body.snapshot.tree).toBe("- button: Inner button");
      expect(body.snapshot.elements).toEqual([
        { ref: "e1", role: "button", name: "Inner button", tag: "button" },
      ]);
      // url/title stay page-level regardless of frame (issue #382 design note).
      expect(body.url).toBe(page.url());
      expect(body.title).toBe(page.titleValue);

      await app.close();
    });

    it("no frame field on a response when the request didn't use one", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "snapshot" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().frame).toBeUndefined();

      await app.close();
    });

    it("wait's numeric-timeout branch always uses page, ignoring frame", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      bindFrame(page, "#iframe-host");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "wait", frame: "#iframe-host", value: 500 },
      });

      expect(res.statusCode).toBe(200);
      expect(page.waitForTimeoutSpy).toHaveBeenCalledWith(500);

      await app.close();
    });

    it("wait's selector branch resolves against the frame when frame is given", async () => {
      const app = await buildApp();
      const { sessionId } = await createProjectAndSession(app);
      const page = launchedPages[0];
      const frame = bindFrame(page, "#iframe-host");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "wait", frame: "#iframe-host", value: "#inner-el" },
      });

      expect(res.statusCode).toBe(200);
      expect(frame.waitForSelectorSpy).toHaveBeenCalledWith("#inner-el");
      expect(page.waitForSelectorSpy).not.toHaveBeenCalled();

      await app.close();
    });

    describe("POST /api/sessions/:id/browser/find with frame", () => {
      it("resolves matches within the frame, not the page", async () => {
        const app = await buildApp();
        const { sessionId } = await createProjectAndSession(app);
        const page = launchedPages[0];
        const frame = bindFrame(page, "#iframe-host");
        const match = new FakeLocator();
        match.evaluateSpy.mockResolvedValue({
          ref: "e1",
          role: "link",
          name: "Inner link",
          tag: "a",
        });
        frame.getByTextResult.allResult = [match];
        page.getByTextResult.allResult = [new FakeLocator()];

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/browser/find`,
          payload: { by: "text", value: "Inner link", frame: "#iframe-host" },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.matchCount).toBe(1);
        expect(body.elements).toEqual([{ ref: "e1", role: "link", name: "Inner link", tag: "a" }]);

        await app.close();
      });

      it("throws when frame doesn't resolve to an iframe", async () => {
        const app = await buildApp();
        const { sessionId } = await createProjectAndSession(app);
        const page = launchedPages[0];
        const hostLocator = new FakeLocator();
        hostLocator.elementHandleSpy.mockResolvedValue({ contentFrame: async () => null });
        page.selectorLocators.set("#not-an-iframe", hostLocator);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/browser/find`,
          payload: { by: "text", value: "x", frame: "#not-an-iframe" },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().message).toContain("element is not an iframe");

        await app.close();
      });
    });
  });
});
