import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  startFixturePageServer,
  DOWNLOAD_CSV_FILENAME,
  DOWNLOAD_CSV_CONTENTS,
  type FixturePageServer,
} from "./support/fixture-page-server.js";

// Issue #407's checklist item "all 19 browser actions against a real page"
// (now 20, with issue #381's `download` action added):
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

describe("browser automation — all 20 actions against a real page (issue #407)", () => {
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

  // Issue #381 (3.10) — the load-bearing scenario this whole feature exists
  // for: the download event fires during `click` (the PRECEDING action),
  // not during this `download` call itself. Deliberately does NOT assert
  // the already-buffered (immediate) path here — that's covered by the
  // mocked suite (test/routes/browser-automation.test.ts) — so this real
  // Chromium run exercises the actual wait-for-a-later-download race the
  // launch-time listener design exists to handle.
  it("download captures a real file download triggered by the preceding click, including base64 round-trip via --contents", async () => {
    await action({ action: "click", selector: "#download-link" });

    const result = await action({ action: "download", timeout_ms: 5000, contents: true });
    expect(result.downloads.length).toBeGreaterThan(0);
    const entry = result.downloads[0];
    expect(entry.filename).toContain(DOWNLOAD_CSV_FILENAME);
    expect(entry.size).toBe(Buffer.byteLength(DOWNLOAD_CSV_CONTENTS));
    expect(fs.existsSync(entry.path)).toBe(true);
    expect(fs.readFileSync(entry.path, "utf8")).toBe(DOWNLOAD_CSV_CONTENTS);
    expect(entry.truncated).toBeUndefined();
    expect(Buffer.from(entry.contents, "base64").toString("utf8")).toBe(DOWNLOAD_CSV_CONTENTS);

    // Clear it so it doesn't leak into any later test in this file that also
    // calls the `download` action with no target download of its own.
    await action({ action: "download", clear: true });
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

  // Issue #382 (3.11) — the `frame` field, against a REAL iframe (a
  // genuinely separate Playwright Frame/document), not the mocked FakeFrame
  // in test/routes/browser-automation.test.ts. This is the only suite that
  // can prove ref-tagging and locator resolution actually work inside a
  // real iframe's own document tree. Not itself a nested (iframe-in-iframe)
  // scenario — that's the documented v1 gap, not something this suite
  // exercises.
  describe("frame field — real iframe", () => {
    it("snapshot with frame returns the iframe's own aria tree and tagged elements, not the page's", async () => {
      const result = await action({ action: "snapshot", frame: "#frame-host" });
      expect(result.frame).toBe("#frame-host");
      expect(typeof result.snapshot.tree).toBe("string");
      expect(result.snapshot.elements.some((e: { tag: string }) => e.tag === "button")).toBe(true);
      // The top-level page's own document has no #frame-click-btn (that id
      // only exists inside the iframe's document) — proves this genuinely
      // searched the frame's own tree, not the page's. Checked via `eval`
      // (an immediate DOM query), not `get` with a selector: `get`'s
      // locator.innerText()/inputValue()/isChecked() calls each wait out
      // Playwright's full default actionability timeout when a selector
      // matches nothing, which would make this assertion take upwards of a
      // minute for a completely expected "not found" case.
      const inTopLevelDoc = await action({
        action: "eval",
        script: "document.getElementById('frame-click-btn') === null",
      });
      expect(inTopLevelDoc.result).toBe(true);
    });

    it("click with frame actually clicks the real button inside the iframe's own document", async () => {
      await action({
        action: "click",
        frame: "#frame-host",
        selector: "#frame-click-btn",
      });
      const after = await action({
        action: "get",
        frame: "#frame-host",
        selector: "#frame-click-result",
      });
      expect(after.text).toBe("frame-clicked");
    });

    it("fill with frame sets the real input's value inside the iframe", async () => {
      await action({
        action: "fill",
        frame: "#frame-host",
        selector: "#frame-text-input",
        value: "hello-frame",
      });
      const after = await action({
        action: "get",
        frame: "#frame-host",
        selector: "#frame-text-input",
      });
      expect(after.value).toBe("hello-frame");
    });

    it("eval with frame runs real JavaScript inside the iframe's own window/document", async () => {
      const result = await action({
        action: "eval",
        frame: "#frame-host",
        script: "document.getElementById('frame-heading').textContent",
      });
      expect(result.result).toBe("Fixture Frame Heading");
    });

    it("find with frame locates a real element inside the iframe and tags it with a resolvable ref", async () => {
      const result = await find({
        by: "text",
        value: "Click me (in frame)",
        frame: "#frame-host",
      });
      expect(result.matchCount).toBeGreaterThan(0);
      const ref = result.elements[0].ref;

      const resolved = await action({ action: "get", frame: "#frame-host", ref });
      expect(resolved.text).toBe("Click me (in frame)");
    });

    it("a frame selector that doesn't resolve to an iframe is a 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "click", frame: "#click-btn", selector: "#anything" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("element is not an iframe");
    });

    it("frame is rejected on navigate", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "navigate", url: fixture.url, frame: "#frame-host" },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
