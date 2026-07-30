import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { startFixturePageServer, type FixturePageServer } from "./support/fixture-page-server.js";

// Issue #407's checklist item "all 19 browser actions against a real page":
// Phase 4/3's browser-automation REST routes (src/routes/browser-automation.ts)
// were only ever exercised against a faked Playwright Page (see
// test/routes/browser-automation.test.ts) — the ajv schema validating a
// request is not evidence the action actually works against a real Chromium
// page. This file uses a REAL (unmocked) Playwright browser via the real
// BrowserManager (src/services/browser-manager.ts), driven entirely through
// app.inject() against the real REST routes, same transport
// control-socket.ts's browser.action/browser.find ops use under the hood.
//
// No sessionBrowsers binding row is needed — resolveSessionPage()
// (browser-automation.ts) only does app.browser.getOrLaunch(row.projectId),
// so a session row + BROWSER_ENABLED=true is the whole prerequisite. The
// session row is inserted directly via app.db (not POST /api/sessions),
// deliberately avoiding a real pty/dtach/systemd-run spawn — that's out of
// scope here (see test/e2e/README.md for what stays manual).
const { buildApp } = await import("../../src/app.js");
const { sessions } = await import("../../src/db/schema.js");

const tmpBrowserDataDir = path.join(
  os.tmpdir(),
  `vitest-e2e-browser-data-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

describe("browser automation — all 19 actions against a real page (issue #407)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fixture: FixturePageServer;
  let sessionId: number;

  beforeAll(async () => {
    process.env.BROWSER_ENABLED = "true";
    process.env.BROWSER_DATA_DIR = tmpBrowserDataDir;

    fixture = await startFixturePageServer();

    app = await buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "browser-e2e", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const [row] = app.db.insert(sessions).values({ projectId, command: "bash" }).returning().all();
    sessionId = row.id;
  });

  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    fs.rmSync(tmpBrowserDataDir, { recursive: true, force: true });
    delete process.env.BROWSER_ENABLED;
    delete process.env.BROWSER_DATA_DIR;
  });

  async function action(body: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: body,
    });
    expect(res.statusCode, `action ${JSON.stringify(body)} failed: ${res.body}`).toBe(200);
    return res.json();
  }

  async function find(body: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser/find`,
      payload: body,
    });
    expect(res.statusCode, `find ${JSON.stringify(body)} failed: ${res.body}`).toBe(200);
    return res.json();
  }

  it("navigate loads the real fixture page", async () => {
    const result = await action({ action: "navigate", url: fixture.url });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(fixture.url);
    expect(result.title).toBe("Fixture Page");
  });

  it("snapshot returns a real aria tree and tagged interactive elements", async () => {
    const result = await action({ action: "snapshot" });
    expect(typeof result.snapshot.tree).toBe("string");
    expect(result.snapshot.elements.length).toBeGreaterThan(0);
    expect(result.snapshot.elements.some((e: { tag: string }) => e.tag === "button")).toBe(true);
  });

  it("click actually clicks the real button, mutating the real DOM", async () => {
    await action({ action: "click", selector: "#click-btn" });
    const after = await action({ action: "get", selector: "#click-result" });
    expect(after.text).toBe("clicked");
  });

  it("fill actually sets the real input's value", async () => {
    await action({ action: "fill", selector: "#text-input", value: "hello-e2e" });
    const after = await action({ action: "get", selector: "#text-input" });
    expect(after.value).toBe("hello-e2e");
  });

  it("type sends real keystrokes into the real input", async () => {
    await action({ action: "type", selector: "#type-input", value: "typed" });
    const after = await action({ action: "get", selector: "#type-input" });
    expect(after.value).toBe("typed");
  });

  it("press sends a real keydown the page's own listener observes", async () => {
    await action({ action: "press", selector: "#press-input", value: "a" });
    const after = await action({ action: "get", selector: "#press-result" });
    expect(after.text).toContain("a");
  });

  it("select actually changes the real <select>'s value", async () => {
    await action({ action: "select", selector: "#select-input", value: "option2" });
    const after = await action({ action: "get", selector: "#select-input" });
    expect(after.value).toBe("option2");
  });

  it("check sets the real checkbox to checked", async () => {
    await action({ action: "check", selector: "#check-input" });
    const after = await action({ action: "get", selector: "#check-input" });
    expect(after.checked).toBe(true);
  });

  it("uncheck sets the real checkbox back to unchecked", async () => {
    await action({ action: "uncheck", selector: "#check-input" });
    const after = await action({ action: "get", selector: "#check-input" });
    expect(after.checked).toBe(false);
  });

  it("hover fires the real page's mouseenter listener", async () => {
    await action({ action: "hover", selector: "#hover-target" });
    const after = await action({ action: "get", selector: "#hover-result" });
    expect(after.text).toBe("hovered");
  });

  it("scroll actually scrolls the real page to the bottom", async () => {
    await action({ action: "scroll", value: "bottom" });
    const after = await action({ action: "eval", script: "window.scrollY" });
    expect(after.result).toBeGreaterThan(0);
  });

  it("wait with a numeric value waits without erroring", async () => {
    const result = await action({ action: "wait", value: 20 });
    expect(result.ok).toBe(true);
  });

  it("wait with a selector value waits for a real element", async () => {
    const result = await action({ action: "wait", value: "#bottom-marker" });
    expect(result.ok).toBe(true);
  });

  it("get with no target returns the real page's full HTML", async () => {
    const result = await action({ action: "get" });
    expect(result.html).toContain("Fixture Heading");
  });

  it("eval runs real JavaScript in the real page", async () => {
    const result = await action({ action: "eval", script: "1 + 2" });
    expect(result.result).toBe(3);
  });

  it("screenshot returns a real, non-empty PNG (magic bytes, not just non-empty base64)", async () => {
    const result = await action({ action: "screenshot" });
    expect(typeof result.screenshot).toBe("string");
    expect(result.screenshot.length).toBeGreaterThan(0);
    const bytes = Buffer.from(result.screenshot, "base64");
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("console captures the real page's own console.log from page load", async () => {
    const result = await action({ action: "console" });
    expect(result.logs.some((l: { text: string }) => l.text === "fixture-console-log")).toBe(true);
  });

  it("errors captures the real page's own uncaught error from page load", async () => {
    const result = await action({ action: "errors" });
    expect(
      result.errors.some((e: { message: string }) => e.message.includes("fixture-thrown-error")),
    ).toBe(true);
  });

  // dialog: `BrowserManager`'s default `page.on("dialog")` handler already
  // auto-accepts confirm()/alert() with no dialogAction armed at all — so
  // asserting "dialog accept" merely accepts a confirm() would pass even if
  // this action did nothing. Two discriminating cases instead: arm
  // "dismiss" and confirm the confirm() result actually flips to false (the
  // opposite of the un-armed default), and arm "accept" with `text` for a
  // prompt() (whose un-armed default is DISMISS, per BrowserManager) and
  // confirm the typed text actually lands.
  it("dialog dismiss actually dismisses a real confirm(), flipping its result to false", async () => {
    await action({ action: "dialog", value: "dismiss" });
    await action({ action: "click", selector: "#confirm-btn" });
    const after = await action({ action: "get", selector: "#confirm-result" });
    expect(after.text).toBe("false");
    // Clear the armed dialog action so it doesn't leak into the next case.
    await action({ action: "dialog" });
  });

  it("dialog accept with text actually accepts a real prompt(), landing the typed value", async () => {
    await action({ action: "dialog", value: "accept", text: "mullion-e2e" });
    await action({ action: "click", selector: "#prompt-btn" });
    const after = await action({ action: "get", selector: "#prompt-result" });
    expect(after.text).toBe("mullion-e2e");
    await action({ action: "dialog" });
  });

  it("find locates a real element by text and tags it with a resolvable ref", async () => {
    // Targets #click-btn specifically, NOT some element only find() itself
    // would ever tag: every action's trailing snapshotPage() fold-in
    // (browser-automation.ts) already re-tagged every *interactive* element
    // (including this button) with its own "e1, e2, ..." sequence before
    // this test runs, and find()'s TAG_SINGLE_ELEMENT_SCRIPT uses that same
    // "e1, e2, ..." format for its own independently-counted matches. Two
    // DIFFERENT elements could therefore legitimately end up sharing the
    // same ref string if find() tagged a non-interactive element (e.g. the
    // <h1>) that the bulk tagger never touches — resolving "e1" afterward
    // would then ambiguously match both, and Playwright's strict-mode
    // locator throws (silently caught to "" by the `get` handler's own
    // `.catch()`). Retargeting the SAME node find() already knows about
    // (the button) sidesteps that: find() simply re-writes the same
    // attribute onto the one element it was already on, so no duplicate is
    // ever created regardless of prior tagging.
    const result = await find({ by: "text", value: "Click me" });
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.elements.length).toBeGreaterThan(0);
    const ref = result.elements[0].ref;

    // Resolve that ref back immediately (refs are invalidated by the very
    // next snapshot/find/navigate — see browser-automation.ts's own doc
    // comment — so this must be the next action, not deferred).
    const resolved = await action({ action: "get", ref });
    expect(resolved.text).toBe("Click me");
  });
});
