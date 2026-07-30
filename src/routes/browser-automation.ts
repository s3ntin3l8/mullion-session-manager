import type { FastifyInstance } from "fastify";
import type { Frame, Page } from "playwright";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import { sessions, projects } from "../db/schema.js";
import { isSafeNavigationUrl } from "./browser.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import type { DownloadEntry } from "../services/browser-manager.js";

// Phase 3, issue #183 — REST API for an agent to control a session's bound
// browser programmatically: navigate/snapshot/click/fill/eval/screenshot,
// plus a `find` helper to locate elements. Same trust boundary as the rest
// of Mullion's API: gated by BROWSER_ENABLED (#179) and the existing global
// auth gate (src/plugins/auth.ts) — no separate authorization model. `eval`
// is arbitrary in-page JS execution; treat it the same as shell access
// through a terminal session — it's scoped to whatever this browser can
// reach (including any authenticated site the agent navigates it to), not a
// new privilege beyond what an authenticated caller already has elsewhere.
//
// Element refs: NOT Playwright's own internal ariaSnapshot({mode:"ai"}) ref
// scheme (its aria-ref selector engine is undocumented/internal — not a
// stable public API to build a shipped feature on). Instead, `snapshot` and
// `find` tag matched elements with a `data-mullion-ref` attribute via a
// plain page.evaluate() call (public API only), and `click`/`fill` resolve
// a `ref` back via `page.locator('[data-mullion-ref="..."]')`. Refs are
// only valid until the next navigation or snapshot/find call re-tags the
// page — callers should treat them as short-lived, not persisted.

export const REF_ATTRIBUTE = "data-mullion-ref";

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
}

// Runs inside the page. Written as a plain string wrapped in a
// self-invoking IIFE (not a typed TS function) — this project's tsconfig
// has no "dom" lib (it's a Node backend), so document/window/Element
// aren't typecheckable here anyway.
//
// IMPORTANT, confirmed empirically against a real Chromium (issue #407,
// test/e2e/browser-actions.e2e.test.ts — test/routes/browser-automation.
// test.ts's mocked Page can't catch this): Playwright evaluates a STRING
// pageFunction as a bare EXPRESSION, not by invoking it as a function. This
// IIFE works because self-invocation IS the expression's own value. A bare,
// non-self-invoking function string like `(el, ref) => {...}`, evaluated
// with `arg`s the way a real function reference would be, does NOT get
// invoked at all — it evaluates to the function value itself and the whole
// call silently resolves to `undefined`. Nor does a locator's own matched
// element get any implicit binding inside a string's IIFE scope (there's no
// "arguments[0]" or similar) — see TAG_SINGLE_ELEMENT_SCRIPT below, which
// needs that element and so must be a real function reference instead.
export const TAG_INTERACTIVE_ELEMENTS_SCRIPT = `
(() => {
  const results = [];
  let counter = 0;
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  };
  const nodes = document.querySelectorAll(
    'a, button, input, textarea, select, iframe, [role], [contenteditable="true"], [tabindex]'
  );
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const ref = "e" + (++counter);
    el.setAttribute("${REF_ATTRIBUTE}", ref);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.innerText ? el.innerText.trim().slice(0, 200) : "") ||
      el.getAttribute("value") ||
      "";
    results.push({ ref, role, name, tag: el.tagName.toLowerCase() });
  }
  return results;
})()
`;

// Tags a single already-resolved locator match (used by /find, where
// matches come from getByRole/getByText/etc. rather than a bulk selector
// query) with the next available ref.
//
// A REAL function reference, deliberately NOT a string like
// TAG_INTERACTIVE_ELEMENTS_SCRIPT above — see that constant's own doc
// comment for why a string here would silently no-op instead of tagging
// anything (issue #407). `el` is typed `any` (not `Element`), same
// no-"dom"-lib reasoning as that comment gives; a real function still
// type-checks fine since nothing here is typed against DOM globals either
// way. `refAttribute` is passed through `arg` rather than interpolated
// into a template string (the way `${REF_ATTRIBUTE}` is above) — a real
// function reference is sent to the browser via its own source text with
// no access to this module's outer scope, so REF_ATTRIBUTE must cross that
// boundary as data, not as a closure.
function tagSingleElement(
  el: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- no "dom" lib; see comment above
  args: { ref: string; refAttribute: string },
): SnapshotElement {
  const { ref, refAttribute } = args;
  el.setAttribute(refAttribute, ref);
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const name =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    (el.innerText ? el.innerText.trim().slice(0, 200) : "") ||
    el.getAttribute("value") ||
    "";
  return { ref, role, name, tag: el.tagName.toLowerCase() };
}

// Issue #382 (3.11) — a `frame` field resolves to a real Playwright `Frame`
// (never a `FrameLocator`, which has no `.evaluate()` — see this file's own
// design notes in the PR/issue), so anywhere the code used to hard-code
// `Page` can instead accept whichever root the caller named. `Page` and
// `Frame` share the exact method surface every caller below actually uses
// (`.locator()`, `.evaluate()`, `.getBy*()`), so a plain union works without
// needing separate overloads per root kind.
export type SearchRoot = Page | Frame;

/** Resolves an optional `frame` CSS selector (a selector for the IFRAME HOST
 * element, not the frame's own body) into the `Frame` object to search/act
 * within. Always resolved against the top-level `page` — nested iframes
 * (an iframe inside an iframe) are an explicit v1 scope cut, not supported.
 * `page.locator(selector).elementHandle()` throws Playwright's own "strict
 * mode" error when `frameSelector` matches more than one element; that's
 * allowed to propagate as-is into the caller's 400 — an ambiguous selector
 * should error, not silently pick one. */
export async function resolveSearchRoot(page: Page, frameSelector?: string): Promise<SearchRoot> {
  if (!frameSelector) return page;
  const handle = await page.locator(frameSelector).elementHandle();
  if (!handle) throw new Error(`frame selector matched no element: ${frameSelector}`);
  const frame = await handle.contentFrame();
  if (!frame) throw new Error(`element is not an iframe: ${frameSelector}`);
  return frame;
}

export async function snapshotPage(
  root: SearchRoot,
): Promise<{ tree: string; elements: SnapshotElement[] }> {
  const [tree, elements] = await Promise.all([
    // Playwright's public, documented aria-snapshot API (page.accessibility
    // was removed in favor of this) — a human/agent-readable YAML-ish tree,
    // independent of the ref-tagging above.
    root.locator("body").ariaSnapshot(),
    root.evaluate<SnapshotElement[]>(TAG_INTERACTIVE_ELEMENTS_SCRIPT),
  ]);
  return { tree, elements };
}

export interface RefOrSelector {
  selector?: string;
  ref?: string;
  /** Issue #382 — a CSS selector for an iframe host element; when present,
   * this action resolves against that frame's own document rather than the
   * top-level page. See `resolveSearchRoot`. */
  frame?: string;
}

export function resolveLocator(root: SearchRoot, target: RefOrSelector) {
  if (target.ref) return root.locator(`[${REF_ATTRIBUTE}="${target.ref}"]`);
  if (target.selector) return root.locator(target.selector);
  return null;
}

/** Scroll the root's own document to absolute coordinates (a frame's
 * `window` is its own, independent browsing context, so this scrolls the
 * frame's document when `root` is a `Frame` — not the top-level page).
 * Resolve sentinels like "bottom" before calling. */
async function scrollPage(root: SearchRoot, x: number, y: number): Promise<void> {
  await root.evaluate(`window.scrollTo(${x}, ${y})`);
}

export type AgentAction =
  | {
      action: "navigate";
      url: string;
      wait_until?: "load" | "domcontentloaded" | "networkidle" | "commit";
    }
  | ({ action: "snapshot" } & Pick<RefOrSelector, "frame">)
  | ({ action: "click" } & RefOrSelector)
  | ({ action: "fill"; value: string } & RefOrSelector)
  | ({ action: "eval"; script: string } & Pick<RefOrSelector, "frame">)
  | { action: "screenshot" }
  | ({ action: "press"; value: string } & RefOrSelector)
  | ({ action: "type"; value: string } & RefOrSelector)
  | ({ action: "select"; value: string | string[] } & RefOrSelector)
  | ({ action: "check" } & RefOrSelector)
  | ({ action: "uncheck" } & RefOrSelector)
  | ({ action: "wait"; value?: string | number } & RefOrSelector)
  | { action: "dialog"; value?: "accept" | "dismiss"; text?: string }
  | ({ action: "hover" } & RefOrSelector)
  | ({ action: "scroll"; value?: "top" | "bottom"; x?: number; y?: number } & RefOrSelector)
  | ({ action: "get" } & RefOrSelector)
  | { action: "console" }
  | { action: "errors" }
  // Issue #381 (3.10) — see executeBrowserAction's "download" case for full
  // semantics: a download event fires during the PRECEDING action (e.g. a
  // click), not during this action's own call, so this only ever reads/
  // waits on a listener installed once at launch time
  // (BrowserManager.getOrLaunch) — never starts a download itself.
  | {
      action: "download";
      /** Default 30000ms; clamped to a max of 120000ms (never rejected —
       * an agent-supplied value above the cap is silently clamped down, so
       * it can't hang the request indefinitely). */
      timeout_ms?: number;
      /** When true, include the file's contents as base64 in the response
       * (subject to max_bytes below). Default false. */
      contents?: boolean;
      /** Default AND hard cap: 1048576 (1 MiB) — see the constant's own
       * comment near DOWNLOAD_MAX_BYTES_CAP for why this can't be raised. */
      max_bytes?: number;
      /** When true, remove the entries returned in this response from the
       * in-memory downloads buffer afterward. */
      clear?: boolean;
    };

// Issue #382 — page-or-manager-level actions that don't make sense scoped to
// an iframe (there's no per-frame navigation, screenshot, dialog queue,
// console/error buffer, or download buffer — those all live on the
// page/ManagedBrowser, not a frame). `frame` is rejected with a 400 on
// these, same posture as `resolveLocator`'s own "requires a selector or
// ref" errors below.
const FRAME_DISALLOWED_ACTIONS = new Set<AgentAction["action"]>([
  "navigate",
  "screenshot",
  "dialog",
  "console",
  "errors",
  // Issue #381 (3.10) — same reasoning as its siblings above: downloads are
  // a manager-level buffer (ManagedBrowser.downloads), not scoped to any
  // one frame's document.
  "download",
]);

// Issue #381 (3.10) — the `download` action's own tunables. Not enforced via
// the ajv schema's `maximum` (that would REJECT an over-limit value with a
// 400); the spec calls for CLAMPING instead, so an agent-supplied value
// above either cap is silently brought down to it rather than erroring.
const DOWNLOAD_DEFAULT_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_TIMEOUT_MS = 120_000;
// The control socket (src/plugins/control-socket.ts's MAX_LINE_BYTES) caps
// an NDJSON line at 2 MiB, and base64 inflates raw bytes by ~4/3 — so 1 MiB
// raw becomes ~1.37 MiB of base64, safely under that 2 MiB cap even with
// the rest of the JSON envelope added on top. Do NOT raise this: a larger
// cap would make `mullion browser download --contents` trip the socket's
// own oversized-line guard on exactly the large files it exists to help
// fetch. This is both the DEFAULT and the HARD CAP — an agent-supplied
// `max_bytes` above this is clamped down to it, never allowed to exceed it.
const DOWNLOAD_MAX_BYTES_CAP = 1_048_576;
// How often the wait-for-a-download poll loop checks managed.downloads —
// a plain setTimeout poll (not an event-emitter wait) so eviction/clear
// don't need to coordinate with any pending waiter's own state.
const DOWNLOAD_POLL_INTERVAL_MS = 50;

// Exported so the clamping rules themselves (not just their effect on a
// full request/response round trip) can be asserted directly and
// deterministically — a wall-clock test proving "an agent-supplied
// timeout_ms of 999999999 doesn't hang the request" would otherwise have to
// either actually wait out the clamped 120s or reach for fake timers around
// a whole app.inject() call.
export function clampDownloadTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DOWNLOAD_DEFAULT_TIMEOUT_MS;
  return Math.max(0, Math.min(value, DOWNLOAD_MAX_TIMEOUT_MS));
}

export function clampDownloadMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DOWNLOAD_MAX_BYTES_CAP;
  }
  return Math.min(value, DOWNLOAD_MAX_BYTES_CAP);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds every `download` action response entry from a buffered list of
 * `DownloadEntry` values, reading each file's contents only when requested.
 * See executeBrowserAction's "download" case for the full response-shape
 * contract (`truncated: true` rather than a silently-omitted `contents`
 * field when an entry doesn't fit).
 *
 * Two independent bounds, not one: `maxBytes` (from `clampDownloadMaxBytes`)
 * still gates any single entry, but `managed.downloads` can hold up to
 * `MAX_DOWNLOADS` buffered entries at once — encoding every one of them at
 * up to `maxBytes` each would let a single response's total payload reach
 * far past the 2 MiB control-socket line cap the `DOWNLOAD_MAX_BYTES_CAP`
 * comment's safety argument assumes for a *single* download. `budgetBytes`
 * (initialized to `DOWNLOAD_MAX_BYTES_CAP` at the call site, decremented
 * here as each entry consumes it) is the total across the whole response,
 * so that argument holds regardless of how many downloads are buffered.
 * Sequential by construction (not `Promise.all`) — the running budget is
 * only meaningful processed newest-first, one at a time, and this also
 * means an entry beyond the exhausted budget is never even read from disk
 * (closing the CLI's own cost concern: `--out` only ever uses entry 0, so
 * paying to encode 49 others it discards was pure waste). */
async function buildDownloadResponseEntries(
  entries: DownloadEntry[],
  wantContents: boolean,
  maxBytes: number,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let budgetBytes = DOWNLOAD_MAX_BYTES_CAP;
  for (const entry of entries) {
    const base = {
      filename: entry.filename,
      path: entry.path,
      url: entry.url,
      size: entry.size,
      timestamp: entry.timestamp,
    };
    if (!wantContents) {
      results.push(base);
      continue;
    }
    // entry.size is a best-effort stat() taken right after saveAs() — if
    // that stat failed it defaults to 0 (see BrowserManager), which would
    // otherwise let an oversized file sail past this check for free. The
    // real byte length read below is the actual backstop; this first check
    // is just an optimization to skip reading a file already known to be
    // too big.
    if (entry.size > maxBytes || entry.size > budgetBytes) {
      results.push({ ...base, truncated: true });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(entry.path);
    } catch {
      // File missing/unreadable (e.g. evicted between buffering the
      // response list and reading it) — report truncated rather than
      // crashing the whole action.
      results.push({ ...base, truncated: true });
      continue;
    }
    if (buf.byteLength > maxBytes || buf.byteLength > budgetBytes) {
      results.push({ ...base, truncated: true });
      continue;
    }
    budgetBytes -= buf.byteLength;
    results.push({ ...base, contents: buf.toString("base64") });
  }
  return results;
}

export const agentActionSchema = {
  body: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: [
          "navigate",
          "snapshot",
          "click",
          "fill",
          "eval",
          "screenshot",
          "press",
          "type",
          "select",
          "check",
          "uncheck",
          "wait",
          "dialog",
          "hover",
          "scroll",
          "get",
          "console",
          "errors",
          "download",
        ],
      },
      url: { type: "string" },
      wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
      selector: { type: "string" },
      ref: { type: "string" },
      // string for every action except "select", which also accepts an
      // array (AgentAction's `value: string | string[]`, executeBrowserAction's
      // `select` case passes it straight through to Playwright's own
      // selectOption(string | string[]) for multi-select <select multiple>
      // elements) — added for the `mullion browser select` subcommand
      // (Phase 4, #134 PR6), which is the first caller that ever sends 2+
      // values. anyOf, not oneOf: Fastify's ajv instance has `coerceTypes:
      // "array"` on by default, which coerces a bare string into a
      // single-element array to try the second branch too — under oneOf's
      // "exactly one must match" rule that makes an ordinary string value
      // match BOTH branches and fail validation entirely (reproduced
      // directly against ajv's fastify-configured instance). anyOf has no
      // such exclusivity requirement, so the coercion is harmless.
      value: {
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
      },
      script: { type: "string", minLength: 1 },
      x: { type: "number" },
      y: { type: "number" },
      text: { type: "string" },
      // Issue #382 (3.11) — CSS selector for an iframe host element; see
      // resolveSearchRoot. MANDATORY to declare here (not optional
      // decoration): @fastify/ajv-compiler's default `removeAdditional: true`
      // silently strips any body field not listed in `properties`, so
      // omitting this would make the whole feature a silent no-op.
      frame: { type: "string" },
      // Issue #381 (3.10) — the `download` action's own fields. Deliberately
      // NO `maximum` on timeout_ms/max_bytes: the spec calls for CLAMPING an
      // over-limit value in the handler (see clampDownloadTimeoutMs/
      // clampDownloadMaxBytes below), not rejecting the whole request with a
      // 400 the way an ajv `maximum` would.
      timeout_ms: { type: "number" },
      contents: { type: "boolean" },
      max_bytes: { type: "number" },
      clear: { type: "boolean" },
    },
  },
};

export const findElementsSchema = {
  body: {
    type: "object",
    required: ["by", "value"],
    properties: {
      by: { type: "string", enum: ["text", "role", "label", "placeholder", "testid"] },
      value: { type: "string", minLength: 1 },
      name: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      // Same removeAdditional gotcha as agentActionSchema above — `find`
      // goes through this separate schema, not agentActionSchema.
      frame: { type: "string" },
    },
  },
};

export interface FindElementsBody {
  by: "text" | "role" | "label" | "placeholder" | "testid";
  value: string;
  name?: string;
  limit?: number;
  /** Issue #382 — CSS selector for an iframe host element; see resolveSearchRoot. */
  frame?: string;
}

export async function executeBrowserAction(
  app: FastifyInstance,
  page: Page,
  body: AgentAction,
  projectId: number,
): Promise<Record<string, unknown>> {
  // Issue #382 (3.11) — extracted once, ahead of the switch, so every guard
  // below (and the trailing response fold) sees the same value regardless
  // of which AgentAction variant's TS type does or doesn't declare `frame`
  // (ajv's schema declares it globally across every action — see
  // agentActionSchema's own comment — so it can be present on the runtime
  // body even for a variant whose narrower TS type omits it).
  const frame = (body as { frame?: string }).frame;

  if (frame !== undefined) {
    if (FRAME_DISALLOWED_ACTIONS.has(body.action)) {
      throw new Error(`'${body.action}' does not take a 'frame' field`);
    }
    // press/type's no-target fallback is page.keyboard.press/type — a
    // global key action with no frame-scoped analogue (there's no such
    // thing as "the currently focused element within this specific
    // iframe" at the OS/input level Playwright exposes here). Reject
    // rather than silently ignoring `frame` and dispatching page-wide.
    if (
      (body.action === "press" || body.action === "type") &&
      body.ref === undefined &&
      body.selector === undefined
    ) {
      throw new Error(`'${body.action}' with 'frame' requires a target (ref or selector)`);
    }
  }

  // Resolved once, ahead of the switch: every locator-based case below
  // reuses this same root rather than re-resolving (a second
  // elementHandle()/contentFrame() round trip could fail after the first
  // action already mutated the DOM). Falls back to `page` itself when no
  // `frame` was given, so every case below works unchanged for the
  // no-frame path.
  const root = await resolveSearchRoot(page, frame);

  let result: Record<string, unknown> = {};
  switch (body.action) {
    case "navigate":
      if (!isSafeNavigationUrl(body.url)) {
        throw new Error(`Refusing to navigate to non-http(s) URL: ${body.url}`);
      }
      await page.goto(body.url, { waitUntil: body.wait_until ?? "load" });
      break;
    case "snapshot":
      break; // snapshot is folded into every response below
    case "click": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("click requires a selector or ref");
      await locator.click();
      break;
    }
    case "fill": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("fill requires a selector or ref");
      await locator.fill(body.value);
      break;
    }
    case "eval":
      result = { result: await root.evaluate<unknown>(body.script) };
      break;
    case "screenshot": {
      const png = await page.screenshot({ type: "png" });
      result = { screenshot: png.toString("base64") };
      break;
    }
    case "press": {
      const locator = resolveLocator(root, body);
      if (locator) {
        await locator.press(body.value);
      } else {
        await page.keyboard.press(body.value);
      }
      break;
    }
    case "type": {
      const locator = resolveLocator(root, body);
      if (locator) {
        await locator.type(body.value);
      } else {
        await page.keyboard.type(body.value);
      }
      break;
    }
    case "select": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("select requires a selector or ref");
      await locator.selectOption(body.value);
      break;
    }
    case "check": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("check requires a selector or ref");
      await locator.check();
      break;
    }
    case "uncheck": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("uncheck requires a selector or ref");
      await locator.uncheck();
      break;
    }
    case "wait": {
      if (body.value !== undefined) {
        if (typeof body.value === "number") {
          // Always the top-level page — a frame has no independently
          // meaningful timer (issue #382 design note).
          await page.waitForTimeout(body.value);
        } else if (typeof body.value === "string") {
          const num = Number(body.value);
          if (!Number.isNaN(num)) {
            await page.waitForTimeout(num);
          } else {
            await root.waitForSelector(body.value);
          }
        }
      } else {
        const locator = resolveLocator(root, body);
        if (locator) {
          await locator.waitFor();
        } else {
          throw new Error(
            "wait requires a value (timeout or selector) or target element (ref/selector)",
          );
        }
      }
      break;
    }
    case "dialog": {
      const managed = await app.browser.getOrLaunch(projectId);
      if (body.value) {
        managed.dialogAction = body.value;
      } else {
        delete managed.dialogAction;
      }
      if (body.text) {
        managed.dialogText = body.text;
      } else {
        delete managed.dialogText;
      }
      break;
    }
    case "hover": {
      const locator = resolveLocator(root, body);
      if (!locator) throw new Error("hover requires a selector or ref");
      await locator.hover();
      break;
    }
    case "scroll": {
      const locator = resolveLocator(root, body);
      if (locator) {
        await locator.scrollIntoViewIfNeeded();
      } else if (
        body.value === "top" ||
        body.value === "bottom" ||
        body.x !== undefined ||
        body.y !== undefined
      ) {
        if (body.value === "bottom") {
          const docHeight = await root.evaluate(`document.body.scrollHeight`);
          await scrollPage(root, 0, docHeight as number);
        } else {
          await scrollPage(root, body.x ?? 0, body.y ?? 0);
        }
      } else {
        throw new Error(
          "scroll requires a target element (ref/selector), value ('top'/'bottom'), or coordinates (x/y)",
        );
      }
      break;
    }
    case "get": {
      const locator = resolveLocator(root, body);
      if (locator) {
        result = {
          text: await locator.innerText().catch(() => ""),
          value: await locator.inputValue().catch(() => ""),
          checked: await locator.isChecked().catch(() => false),
        };
      } else {
        result = {
          html: await root.content(),
        };
      }
      break;
    }
    case "console": {
      const managed = await app.browser.getOrLaunch(projectId);
      result = { logs: managed.consoleLogs };
      break;
    }
    case "errors": {
      const managed = await app.browser.getOrLaunch(projectId);
      result = { errors: managed.pageErrors };
      break;
    }
    case "download": {
      // Issue #381 (3.10) — the download itself already happened (or is
      // still happening) as a side effect of a PRECEDING action; the
      // page.on("download") listener installed once in
      // BrowserManager.getOrLaunch is what actually buffers it. This case
      // only reads that buffer (immediately, if it's non-empty) or waits up
      // to timeout_ms for the listener to push a first entry — it never
      // itself waits on `page.waitForEvent("download")`, which would miss a
      // download that already started/finished before this call.
      const managed = await app.browser.getOrLaunch(projectId);
      const timeoutMs = clampDownloadTimeoutMs(body.timeout_ms);
      const maxBytes = clampDownloadMaxBytes(body.max_bytes);
      const wantContents = body.contents === true;

      if (managed.downloads.length === 0) {
        const deadline = Date.now() + timeoutMs;
        while (managed.downloads.length === 0 && Date.now() < deadline) {
          await sleep(Math.min(DOWNLOAD_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
        }
      }

      // Snapshot the entries about to be returned (newest-first) BEFORE any
      // concurrent page.on("download") push mutates managed.downloads
      // further — `clear` below must remove exactly these, by identity, not
      // however many entries happen to exist at that later moment.
      const toReturn = [...managed.downloads].reverse();
      const entries = await buildDownloadResponseEntries(toReturn, wantContents, maxBytes);

      if (body.clear) {
        // Remove exactly the entries we're returning, by object identity
        // (never `managed.downloads.length = 0` or a reassignment) — a
        // download that completes concurrently, between snapshotting
        // `toReturn` above and this splice, must survive this clear rather
        // than being silently discarded alongside the ones actually
        // returned. This does NOT delete the underlying files: the caller
        // may still hold `path` from this very response — only
        // BrowserManager's own 50-entry eviction deletes files.
        for (const entry of toReturn) {
          const idx = managed.downloads.indexOf(entry);
          if (idx !== -1) managed.downloads.splice(idx, 1);
        }
      }

      result = { downloads: entries };
      break;
    }
  }

  // The trailing snapshot targets whichever root the request named — a
  // frame-scoped action needs fresh refs for THAT frame's document to keep
  // working, not the main page's. `url`/`title` stay page-level regardless
  // (issue #382 design note) since they describe the top-level document,
  // not whichever context a `frame` field happened to scope this one
  // action to.
  const [snapshot, title] = await Promise.all([snapshotPage(root), page.title()]);
  const managed = await app.browser.getOrLaunch(projectId);
  return {
    ok: true,
    url: page.url(),
    title,
    ...result,
    ...(frame !== undefined ? { frame } : {}),
    snapshot,
    console: managed.consoleLogs,
    errors: managed.pageErrors,
  };
}

export async function executeBrowserFind(
  app: FastifyInstance,
  root: SearchRoot,
  body: FindElementsBody,
): Promise<Record<string, unknown>> {
  const { by, value, name, limit = 10 } = body;
  const locator =
    by === "text"
      ? root.getByText(value)
      : by === "role"
        ? root.getByRole(value as Parameters<Page["getByRole"]>[0], name ? { name } : undefined)
        : by === "label"
          ? root.getByLabel(value)
          : by === "placeholder"
            ? root.getByPlaceholder(value)
            : root.getByTestId(value);

  const matches = await locator.all();
  const capped = matches.slice(0, limit);
  const elements: SnapshotElement[] = [];
  for (let i = 0; i < capped.length; i++) {
    const ref = `e${i + 1}`;
    const tagged = await capped[i].evaluate(tagSingleElement, { ref, refAttribute: REF_ATTRIBUTE });
    elements.push(tagged);
  }

  return { ok: true, matchCount: matches.length, elements };
}

export async function browserAutomationRoute(app: FastifyInstance): Promise<void> {
  async function resolveSessionPage(
    sessionId: number,
  ): Promise<
    | { ok: true; page: Page; projectId: number }
    | { ok: false; status: 400 | 404 | 502; message: string }
  > {
    if (!app.config.BROWSER_ENABLED) {
      return {
        ok: false,
        status: 400,
        message: "Browser feature is disabled (set BROWSER_ENABLED=true)",
      };
    }
    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return { ok: false, status: 404, message: `No session ${sessionId}` };

    try {
      const managed = await app.browser.getOrLaunch(row.projectId);
      return { ok: true, page: managed.page, projectId: row.projectId };
    } catch (err) {
      app.log.error(
        { err, sessionId, projectId: row.projectId },
        "failed to launch project browser",
      );
      return { ok: false, status: 502, message: (err as Error).message };
    }
  }

  app.post<{ Params: { id: string }; Body: AgentAction }>(
    "/api/sessions/:id/browser",
    { schema: agentActionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!sessionRow) return reply.notFound(`No session ${sessionId}`);

      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, sessionRow.projectId))
        .all();
      if (!project) return reply.notFound(`No project for session ${sessionId}`);

      if (project.hostId !== LOCAL_HOST_ID) {
        try {
          const client = getRemoteHostClient(app, project.hostId);
          const response = await client.browserAutomationAction(
            sessionId,
            project.id,
            request.body,
          );
          return response;
        } catch (err) {
          app.log.error(
            { err, sessionId, hostId: project.hostId },
            "failed to forward browser action to agent",
          );
          return reply.badGateway((err as Error).message);
        }
      }

      const resolved = await resolveSessionPage(sessionId);
      if (!resolved.ok) {
        if (resolved.status === 404) return reply.notFound(resolved.message);
        if (resolved.status === 502) return reply.badGateway(resolved.message);
        return reply.badRequest(resolved.message);
      }
      const { page, projectId } = resolved;

      try {
        const response = await executeBrowserAction(app, page, request.body, projectId);
        return response;
      } catch (err) {
        app.log.warn(
          { err, sessionId, action: request.body.action },
          "browser automation action failed",
        );
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: FindElementsBody }>(
    "/api/sessions/:id/browser/find",
    { schema: findElementsSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const [sessionRow] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      if (!sessionRow) return reply.notFound(`No session ${sessionId}`);

      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, sessionRow.projectId))
        .all();
      if (!project) return reply.notFound(`No project for session ${sessionId}`);

      if (project.hostId !== LOCAL_HOST_ID) {
        try {
          const client = getRemoteHostClient(app, project.hostId);
          const response = await client.browserAutomationFind(sessionId, project.id, request.body);
          return response;
        } catch (err) {
          app.log.error(
            { err, sessionId, hostId: project.hostId },
            "failed to forward browser find to agent",
          );
          return reply.badGateway((err as Error).message);
        }
      }

      const resolved = await resolveSessionPage(sessionId);
      if (!resolved.ok) {
        if (resolved.status === 404) return reply.notFound(resolved.message);
        if (resolved.status === 502) return reply.badGateway(resolved.message);
        return reply.badRequest(resolved.message);
      }
      const { page } = resolved;

      try {
        const root = await resolveSearchRoot(page, request.body.frame);
        const response = await executeBrowserFind(app, root, request.body);
        return response;
      } catch (err) {
        app.log.warn({ err, sessionId }, "browser automation find failed");
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
