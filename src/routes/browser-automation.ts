import type { FastifyInstance, FastifyReply } from "fastify";
import type { Page } from "playwright";
import { eq } from "drizzle-orm";
import { sessions } from "../db/schema.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import type { BrowserTarget } from "../services/browser-manager.js";
import { resolveSessionBrowserTarget } from "../services/browser-target.js";
import {
  beginBrowserAttach,
  recordBindingOrRelease,
  recordSessionBrowserBinding,
} from "../services/session-browsers.js";

// The action engine lives in a service: the hook plugin runs these actions
// too, and a plugin importing a route inverts the layering (issue #2413).
// Re-exported here so every existing importer keeps its path.
import {
  clampDownloadMaxBytes,
  clampDownloadTimeoutMs,
  executeBrowserAction,
  executeBrowserFind,
  resolveSearchRoot,
  snapshotPage,
  type AgentAction,
  type FindElementsBody,
  type RefOrSelector,
  type SearchRoot,
  type SnapshotElement,
} from "../services/browser-automation-actions.js";
export {
  clampDownloadMaxBytes,
  clampDownloadTimeoutMs,
  executeBrowserAction,
  executeBrowserFind,
  resolveSearchRoot,
  snapshotPage,
};
export type { AgentAction, FindElementsBody, RefOrSelector, SearchRoot, SnapshotElement };

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

export async function browserAutomationRoute(app: FastifyInstance): Promise<void> {
  type Resolved =
    | { ok: true; target: BrowserTarget; page: Page | null }
    | {
        ok: false;
        status: 400 | 404 | 501 | 502 | 503;
        message: string;
        code?: "binding_unavailable";
      };

  // The session's own execution target (host + checkout), resolved through the
  // same resolver as the browser panel, so the agent drives the browser the
  // human sees. Refusals are reported as such: there is no fallback to the
  // project's host or checkout. `page` is null for a remote target (the
  // owning agent runs the browser).
  async function resolveSessionTarget(sessionId: number): Promise<Resolved> {
    const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row) return { ok: false, status: 404, message: `No session ${sessionId}` };

    const resolved = await resolveSessionBrowserTarget(app, row.projectId, sessionId);
    if (!resolved.ok) return resolved;
    const { target } = resolved;
    // A remote target is driven by its own agent, whose browser setting
    // decides; this primary's switch only governs the browsers it hosts.
    if (target.hostId !== LOCAL_HOST_ID) {
      return { ok: true, target, page: null };
    }
    if (!app.browserEnabled) {
      return {
        ok: false,
        status: 400,
        message:
          "Browser feature is disabled — turn it on in Settings → Browser (or set BROWSER_ENABLED=true), then restart the Mullion server.",
      };
    }
    // Driving a session's browser binds it, so closing the session closes a
    // target nobody else uses (also when only the agent ever opened it).
    recordSessionBrowserBinding(app, sessionId, target);

    try {
      const managed = await app.browser.getOrLaunch(target);
      return { ok: true, target, page: managed.page };
    } catch (err) {
      app.log.error({ err, sessionId, target }, "failed to launch target browser");
      return { ok: false, status: 502, message: (err as Error).message };
    }
  }

  // Drives a remote target through its agent. The binding is recorded only once
  // the agent has taken the call, so a refused or failed call leaves none (and
  // an unreachable host is not "bound" to a browser that never opened). Until
  // then the call counts as an attach in flight, which keeps a session ending
  // meanwhile from closing the target. A binding that cannot be recorded
  // releases the target (closed if nothing else uses it) but does not fail the
  // call that already ran.
  async function callRemote<T>(
    sessionId: number,
    target: BrowserTarget,
    call: () => Promise<T>,
  ): Promise<T> {
    const attachDone = beginBrowserAttach(target);
    try {
      const result = await call();
      recordBindingOrRelease(app, sessionId, target, attachDone);
      return result;
    } finally {
      attachDone();
    }
  }

  function refuse(reply: FastifyReply, resolved: Extract<Resolved, { ok: false }>) {
    const error = app.httpErrors.createError(resolved.status, resolved.message);
    // The machine-readable reason (`binding_unavailable`) rides along in the
    // body so a client can offer the way out instead of parsing the message.
    if (resolved.code) Object.assign(error, { code: resolved.code });
    return reply.send(error);
  }

  app.post<{ Params: { id: string }; Body: AgentAction }>(
    "/api/sessions/:id/browser",
    { schema: agentActionSchema },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      if (!Number.isInteger(sessionId)) return reply.badRequest("Invalid session id");

      const resolved = await resolveSessionTarget(sessionId);
      if (!resolved.ok) return refuse(reply, resolved);
      const { target, page } = resolved;

      if (!page) {
        try {
          return await callRemote(sessionId, target, () =>
            getRemoteHostClient(app, target.hostId).browserAutomationAction(
              sessionId,
              target,
              request.body,
            ),
          );
        } catch (err) {
          app.log.error(
            { err, sessionId, hostId: target.hostId },
            "failed to forward browser action to agent",
          );
          return reply.badGateway((err as Error).message);
        }
      }

      try {
        return await executeBrowserAction(app, page, request.body, target);
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

      const resolved = await resolveSessionTarget(sessionId);
      if (!resolved.ok) return refuse(reply, resolved);
      const { target, page } = resolved;

      if (!page) {
        try {
          return await callRemote(sessionId, target, () =>
            getRemoteHostClient(app, target.hostId).browserAutomationFind(
              sessionId,
              target,
              request.body,
            ),
          );
        } catch (err) {
          app.log.error(
            { err, sessionId, hostId: target.hostId },
            "failed to forward browser find to agent",
          );
          return reply.badGateway((err as Error).message);
        }
      }

      try {
        const root = await resolveSearchRoot(page, request.body.frame);
        return await executeBrowserFind(app, root, request.body);
      } catch (err) {
        app.log.warn({ err, sessionId }, "browser automation find failed");
        return reply.badRequest((err as Error).message);
      }
    },
  );
}
