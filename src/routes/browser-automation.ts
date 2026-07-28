import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { sessions, projects } from "../db/schema.js";
import { isSafeNavigationUrl } from "./browser.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";

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

// Runs inside the page. Written as a plain string (not a typed TS function)
// deliberately — this project's tsconfig has no "dom" lib (it's a Node
// backend), so document/window/Element aren't typecheckable here anyway;
// Playwright's PageFunction type accepts a string just as well as a
// function and evaluates it in-page regardless.
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
export const TAG_SINGLE_ELEMENT_SCRIPT = `
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

export async function snapshotPage(
  page: Page,
): Promise<{ tree: string; elements: SnapshotElement[] }> {
  const [tree, elements] = await Promise.all([
    // Playwright's public, documented aria-snapshot API (page.accessibility
    // was removed in favor of this) — a human/agent-readable YAML-ish tree,
    // independent of the ref-tagging above.
    page.locator("body").ariaSnapshot(),
    page.evaluate<SnapshotElement[]>(TAG_INTERACTIVE_ELEMENTS_SCRIPT),
  ]);
  return { tree, elements };
}

export interface RefOrSelector {
  selector?: string;
  ref?: string;
}

export function resolveLocator(page: Page, target: RefOrSelector) {
  if (target.ref) return page.locator(`[${REF_ATTRIBUTE}="${target.ref}"]`);
  if (target.selector) return page.locator(target.selector);
  return null;
}

/** Scroll the page to absolute coordinates. Resolve sentinels like "bottom" before calling. */
async function scrollPage(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(`window.scrollTo(${x}, ${y})`);
}

export type AgentAction =
  | {
      action: "navigate";
      url: string;
      wait_until?: "load" | "domcontentloaded" | "networkidle" | "commit";
    }
  | { action: "snapshot" }
  | ({ action: "click" } & RefOrSelector)
  | ({ action: "fill"; value: string } & RefOrSelector)
  | { action: "eval"; script: string }
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
  | { action: "errors" };

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
        ],
      },
      url: { type: "string" },
      wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"] },
      selector: { type: "string" },
      ref: { type: "string" },
      value: { type: "string" },
      script: { type: "string", minLength: 1 },
      x: { type: "number" },
      y: { type: "number" },
      text: { type: "string" },
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
    },
  },
};

export interface FindElementsBody {
  by: "text" | "role" | "label" | "placeholder" | "testid";
  value: string;
  name?: string;
  limit?: number;
}

export async function executeBrowserAction(
  app: FastifyInstance,
  page: Page,
  body: AgentAction,
  projectId: number,
): Promise<Record<string, unknown>> {
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
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("click requires a selector or ref");
      await locator.click();
      break;
    }
    case "fill": {
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("fill requires a selector or ref");
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
    case "press": {
      const locator = resolveLocator(page, body);
      if (locator) {
        await locator.press(body.value);
      } else {
        await page.keyboard.press(body.value);
      }
      break;
    }
    case "type": {
      const locator = resolveLocator(page, body);
      if (locator) {
        await locator.type(body.value);
      } else {
        await page.keyboard.type(body.value);
      }
      break;
    }
    case "select": {
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("select requires a selector or ref");
      await locator.selectOption(body.value);
      break;
    }
    case "check": {
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("check requires a selector or ref");
      await locator.check();
      break;
    }
    case "uncheck": {
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("uncheck requires a selector or ref");
      await locator.uncheck();
      break;
    }
    case "wait": {
      if (body.value !== undefined) {
        if (typeof body.value === "number") {
          await page.waitForTimeout(body.value);
        } else if (typeof body.value === "string") {
          const num = Number(body.value);
          if (!Number.isNaN(num)) {
            await page.waitForTimeout(num);
          } else {
            await page.waitForSelector(body.value);
          }
        }
      } else {
        const locator = resolveLocator(page, body);
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
      const locator = resolveLocator(page, body);
      if (!locator) throw new Error("hover requires a selector or ref");
      await locator.hover();
      break;
    }
    case "scroll": {
      const locator = resolveLocator(page, body);
      if (locator) {
        await locator.scrollIntoViewIfNeeded();
      } else if (
        body.value === "top" ||
        body.value === "bottom" ||
        body.x !== undefined ||
        body.y !== undefined
      ) {
        if (body.value === "bottom") {
          const docHeight = await page.evaluate(`document.body.scrollHeight`);
          await scrollPage(page, 0, docHeight as number);
        } else {
          await scrollPage(page, body.x ?? 0, body.y ?? 0);
        }
      } else {
        throw new Error(
          "scroll requires a target element (ref/selector), value ('top'/'bottom'), or coordinates (x/y)",
        );
      }
      break;
    }
    case "get": {
      const locator = resolveLocator(page, body);
      if (locator) {
        result = {
          text: await locator.innerText().catch(() => ""),
          value: await locator.inputValue().catch(() => ""),
          checked: await locator.isChecked().catch(() => false),
        };
      } else {
        result = {
          html: await page.content(),
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
  }

  const [snapshot, title] = await Promise.all([snapshotPage(page), page.title()]);
  const managed = await app.browser.getOrLaunch(projectId);
  return {
    ok: true,
    url: page.url(),
    title,
    ...result,
    snapshot,
    console: managed.consoleLogs,
    errors: managed.pageErrors,
  };
}

export async function executeBrowserFind(
  app: FastifyInstance,
  page: Page,
  body: FindElementsBody,
): Promise<Record<string, unknown>> {
  const { by, value, name, limit = 10 } = body;
  const locator =
    by === "text"
      ? page.getByText(value)
      : by === "role"
        ? page.getByRole(value as Parameters<Page["getByRole"]>[0], name ? { name } : undefined)
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
        const response = await executeBrowserFind(app, page, request.body);
        return response;
      } catch (err) {
        app.log.warn({ err, sessionId }, "browser automation find failed");
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
