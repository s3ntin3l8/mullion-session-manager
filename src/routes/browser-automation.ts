import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { isSafeNavigationUrl } from "./browser.js";

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

const REF_ATTRIBUTE = "data-mullion-ref";

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
}

// Runs inside the page. Written as a plain string (not a typed TS function)
// deliberately — this project's tsconfig has no "dom" lib (it's a Node
// backend), so document/window/Element aren't typecheckable here anyway;
// Playwright's PageFunction type accepts a string just as well as a
// function and evaluates it in-page regardless.
const TAG_INTERACTIVE_ELEMENTS_SCRIPT = `
(() => {
  const results = [];
  let counter = 0;
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const nodes = document.querySelectorAll(
    'a, button, input, textarea, select, [role], [contenteditable="true"], [tabindex]'
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
const TAG_SINGLE_ELEMENT_SCRIPT = `
(el, ref) => {
  el.setAttribute("${REF_ATTRIBUTE}", ref);
  const role = el.getAttribute("role") || el.tagName.toLowerCase();
  const name =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    (el.innerText ? el.innerText.trim().slice(0, 200) : "") ||
    el.getAttribute("value") ||
    "";
  return { ref, role, name, tag: el.tagName.toLowerCase() };
}
`;

async function snapshotPage(page: Page): Promise<{ tree: string; elements: SnapshotElement[] }> {
  const [tree, elements] = await Promise.all([
    // Playwright's public, documented aria-snapshot API (page.accessibility
    // was removed in favor of this) — a human/agent-readable YAML-ish tree,
    // independent of the ref-tagging above.
    page.locator("body").ariaSnapshot(),
    page.evaluate<SnapshotElement[]>(TAG_INTERACTIVE_ELEMENTS_SCRIPT),
  ]);
  return { tree, elements };
}

interface RefOrSelector {
  selector?: string;
  ref?: string;
}

function resolveLocator(page: Page, target: RefOrSelector) {
  if (target.ref) return page.locator(`[${REF_ATTRIBUTE}="${target.ref}"]`);
  if (target.selector) return page.locator(target.selector);
  return null;
}

type AgentAction =
  | {
      action: "navigate";
      url: string;
      wait_until?: "load" | "domcontentloaded" | "networkidle" | "commit";
    }
  | { action: "snapshot" }
  | ({ action: "click" } & RefOrSelector)
  | ({ action: "fill"; value: string } & RefOrSelector)
  | { action: "eval"; script: string }
  | { action: "screenshot" };

const agentActionSchema = {
  body: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "snapshot", "click", "fill", "eval", "screenshot"],
      },
      url: { type: "string" },
      wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
      selector: { type: "string" },
      ref: { type: "string" },
      value: { type: "string" },
      script: { type: "string" },
    },
  },
};

const findElementsSchema = {
  body: {
    type: "object",
    required: ["by", "value"],
    properties: {
      by: { type: "string", enum: ["text", "role", "label", "placeholder", "testid"] },
      value: { type: "string", minLength: 1 },
      name: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
};

interface FindElementsBody {
  by: "text" | "role" | "label" | "placeholder" | "testid";
  value: string;
  name?: string;
  limit?: number;
}

export async function browserAutomationRoute(app: FastifyInstance): Promise<void> {
  // Shared preamble for both routes below: BROWSER_ENABLED, a valid
  // sessionId, and the session's project browser, launching it if not
  // already running (mirrors attachSocketToBrowser's own launch step).
  async function resolveSessionPage(
    sessionId: number,
  ): Promise<{ ok: true; page: Page } | { ok: false; status: 400 | 404 | 502; message: string }> {
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
      return { ok: true, page: managed.page };
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

      const resolved = await resolveSessionPage(sessionId);
      if (!resolved.ok) {
        if (resolved.status === 404) return reply.notFound(resolved.message);
        if (resolved.status === 502) return reply.badGateway(resolved.message);
        return reply.badRequest(resolved.message);
      }
      const { page } = resolved;
      const body = request.body;

      try {
        let result: Record<string, unknown> = {};
        switch (body.action) {
          case "navigate":
            if (!isSafeNavigationUrl(body.url)) {
              return reply.badRequest(`Refusing to navigate to non-http(s) URL: ${body.url}`);
            }
            await page.goto(body.url, { waitUntil: body.wait_until ?? "load" });
            break;
          case "snapshot":
            break; // snapshot is folded into every response below
          case "click": {
            const locator = resolveLocator(page, body);
            if (!locator) return reply.badRequest("click requires a selector or ref");
            await locator.click();
            break;
          }
          case "fill": {
            const locator = resolveLocator(page, body);
            if (!locator) return reply.badRequest("fill requires a selector or ref");
            await locator.fill(body.value);
            break;
          }
          case "eval":
            result = { result: await page.evaluate<unknown>(body.script) };
            break;
          case "screenshot": {
            const png = await page.screenshot({ type: "png" });
            result = { screenshot: png.toString("base64") };
            break;
          }
        }

        // "Responses include DOM snapshots for agent context" (#183) — every
        // action, not just the `snapshot` action itself, returns the page's
        // current state so the agent doesn't need a follow-up call after
        // every click/fill/navigate.
        const snapshot = await snapshotPage(page);
        return {
          ok: true,
          url: page.url(),
          title: await page.title(),
          ...result,
          snapshot,
        };
      } catch (err) {
        app.log.warn({ err, sessionId, action: body.action }, "browser automation action failed");
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

      const resolved = await resolveSessionPage(sessionId);
      if (!resolved.ok) {
        if (resolved.status === 404) return reply.notFound(resolved.message);
        if (resolved.status === 502) return reply.badGateway(resolved.message);
        return reply.badRequest(resolved.message);
      }
      const { page } = resolved;
      const { by, value, name, limit = 10 } = request.body;

      try {
        const locator =
          by === "text"
            ? page.getByText(value)
            : by === "role"
              ? page.getByRole(
                  value as Parameters<Page["getByRole"]>[0],
                  name ? { name } : undefined,
                )
              : by === "label"
                ? page.getByLabel(value)
                : by === "placeholder"
                  ? page.getByPlaceholder(value)
                  : page.getByTestId(value);

        const matches = await locator.all();
        const capped = matches.slice(0, limit);
        const elements: SnapshotElement[] = [];
        for (let i = 0; i < capped.length; i++) {
          const ref = `e${i + 1}`;
          const tagged = await capped[i].evaluate<SnapshotElement, string>(
            TAG_SINGLE_ELEMENT_SCRIPT,
            ref,
          );
          elements.push(tagged);
        }

        return { ok: true, matchCount: matches.length, elements };
      } catch (err) {
        app.log.warn({ err, sessionId, by, value }, "browser element find failed");
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
