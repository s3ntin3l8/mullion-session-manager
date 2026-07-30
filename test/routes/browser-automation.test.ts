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
});
