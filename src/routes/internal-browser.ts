import type { FastifyInstance } from "fastify";
import type { Page } from "playwright";
import {
  executeBrowserAction,
  executeBrowserFind,
  resolveSearchRoot,
  agentActionSchema,
  findElementsSchema,
} from "./browser-automation.js";
import type { AgentAction, FindElementsBody } from "./browser-automation.js";
import { attachSocketToBrowser } from "./browser.js";
import type { BrowserTarget } from "../services/browser-manager.js";
import { agentServesHost } from "../services/agent-identity.js";
import { BROWSER_TARGET_SCHEMA, SESSION_ID_PARAMS_SCHEMA } from "./internal-schemas.js";
import { browserTargetKey } from "../services/browser-manager.js";
import {
  rememberSessionBrowserTarget,
  sessionBrowserTarget,
  touchSessionBrowserTarget,
} from "../services/session-browser-targets.js";

/** What a caller that names no (or a foreign) target is told. An older primary
 * only sends `?projectId=`, which an agent cannot map to one checkout's
 * browser, so the answer says what to do rather than a bare 400. */
const MISSING_TARGET_MESSAGE =
  "This request names no browser target for this host (projectId, hostId and checkoutRoot are required). The primary is older than this agent: update the primary.";

/** The browser target an agent browser route was asked for (issue #2448). The
 * primary names it in the query; an agent never derives one from the project
 * id alone, so a caller that omits it is refused instead of silently getting
 * a project-wide browser shared across checkouts. */
function parseBrowserTarget(
  app: FastifyInstance,
  query: Record<string, string | undefined>,
): BrowserTarget | null {
  const projectId = Number(query.projectId);
  const { hostId, checkoutRoot } = query;
  if (!Number.isInteger(projectId) || !hostId || !checkoutRoot) return null;
  // A target names the machine that runs it; this pool only holds this
  // machine's browsers, so another host's target is a misrouted request.
  if (!agentServesHost(app.config.SESSIONS_DIR, hostId)) return null;
  return {
    projectId,
    hostId,
    checkoutRoot,
    endpoint: query.endpoint,
    legacy: query.legacy === "1",
  };
}

/**
 * The agent's per-target browser routes (issue #2448). Registered from
 * `internalRoutes` so they sit behind its auth hook and share its rate limit.
 */
export function registerBrowserRoutes(app: FastifyInstance, rateLimit: { config: object }): void {
  // The primary sends a session's browser target once it has decided the
  // session's preview endpoint (issue #2688), which is after spawn: the agent
  // has no database to resolve it with. The agent answers with the target it
  // will serve. A context that already runs for the session is kept (the
  // session's `use_browser` opened it with the spawn-time target), so the
  // primary adopts that one and the panel and the agent share one context.
  app.post<{ Params: { id: string }; Body: BrowserTarget }>(
    "/internal/sessions/:id/browser-target",
    {
      ...rateLimit,
      schema: { params: SESSION_ID_PARAMS_SCHEMA, body: BROWSER_TARGET_SCHEMA },
    },
    async (request, reply) => {
      const { id } = request.params;
      const next = request.body;
      if (!agentServesHost(app.config.SESSIONS_DIR, next.hostId)) {
        return reply.badRequest("This browser target belongs to another host");
      }
      const dir = app.config.SESSIONS_DIR;
      const current = sessionBrowserTarget(id, dir);
      if (current) {
        if (
          current.projectId !== next.projectId ||
          current.hostId !== next.hostId ||
          current.checkoutRoot !== next.checkoutRoot
        ) {
          return reply.conflict("This session already has a browser target for another checkout");
        }
        if (
          browserTargetKey(current) !== browserTargetKey(next) &&
          app.browserEnabled &&
          app.browser.get(current)
        ) {
          touchSessionBrowserTarget(id, dir);
          return { target: current };
        }
      }
      rememberSessionBrowserTarget(app.pty, id, next, dir);
      return { target: next };
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: Record<string, string | undefined>;
    Body: AgentAction;
  }>(
    "/internal/sessions/:id/browser",
    {
      ...rateLimit,
      schema: {
        params: SESSION_ID_PARAMS_SCHEMA,
        body: agentActionSchema.body,
      },
    },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      const target = parseBrowserTarget(app, request.query);
      if (!Number.isInteger(sessionId) || !target) {
        return reply.badRequest(
          Number.isInteger(sessionId) ? MISSING_TARGET_MESSAGE : "Invalid session id",
        );
      }

      if (!app.browserEnabled) {
        return reply.badRequest("Browser feature is disabled");
      }
      touchSessionBrowserTarget(String(sessionId), app.config.SESSIONS_DIR);

      let page: Page;
      try {
        const managed = await app.browser.getOrLaunch(target);
        page = managed.page;
      } catch (err) {
        return reply.badGateway((err as Error).message);
      }

      try {
        return await executeBrowserAction(app, page, request.body, target);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: Record<string, string | undefined>;
    Body: FindElementsBody;
  }>(
    "/internal/sessions/:id/browser/find",
    {
      ...rateLimit,
      schema: {
        params: SESSION_ID_PARAMS_SCHEMA,
        body: findElementsSchema.body,
      },
    },
    async (request, reply) => {
      const sessionId = Number(request.params.id);
      const target = parseBrowserTarget(app, request.query);
      if (!Number.isInteger(sessionId) || !target) {
        return reply.badRequest(
          Number.isInteger(sessionId) ? MISSING_TARGET_MESSAGE : "Invalid session id",
        );
      }

      if (!app.browserEnabled) {
        return reply.badRequest("Browser feature is disabled");
      }
      touchSessionBrowserTarget(String(sessionId), app.config.SESSIONS_DIR);

      let page: Page;
      try {
        const managed = await app.browser.getOrLaunch(target);
        page = managed.page;
      } catch (err) {
        return reply.badGateway((err as Error).message);
      }

      try {
        // Mirrors the REST route's own resolve-then-call pattern (see
        // browser-automation.ts's own POST /browser/find handler) —
        // executeBrowserFind expects an already-resolved SearchRoot, unlike
        // executeBrowserAction above, which still resolves `frame`
        // internally. Missing this call would silently search the
        // top-level document instead of a named iframe for every
        // multi-host `find` (RemoteHostClient.browserAutomationFind posts
        // here), with no error — caught by code review, PR #429.
        const root = await resolveSearchRoot(page, request.body.frame);
        return await executeBrowserFind(app, root, request.body);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/internal/ws/browser/:sessionId",
    {
      websocket: true,
      config: rateLimit.config,
      preValidation: async (request, reply) => {
        if (!app.browserEnabled) {
          return reply.badRequest("Browser feature is disabled");
        }
        const sessionId = Number(request.params.sessionId);
        if (!Number.isInteger(sessionId)) {
          return reply.badRequest("Invalid sessionId");
        }
        if (!parseBrowserTarget(app, request.query as Record<string, string | undefined>)) {
          return reply.badRequest(MISSING_TARGET_MESSAGE);
        }
      },
    },
    (socket, req) => {
      const sessionId = Number(req.params.sessionId);
      const target = parseBrowserTarget(app, req.query as Record<string, string | undefined>);
      if (!target) {
        socket.close();
        return;
      }
      void attachSocketToBrowser(app, socket, { sessionId, target });
    },
  );

  // Closes one target's browser once the last session using it ended on the
  // primary (services/session-browsers.ts). Idempotent: nothing running is ok.
  app.post<{ Querystring: Record<string, string | undefined> }>(
    "/internal/browser/close",
    { ...rateLimit },
    async (request, reply) => {
      const target = parseBrowserTarget(app, request.query);
      if (!target) return reply.badRequest(MISSING_TARGET_MESSAGE);
      if (!app.browserEnabled) return { ok: true };
      await app.browser.closeTarget(target);
      return { ok: true };
    },
  );

  // Closes a target's browser and deletes its stored state, for a checkout the
  // primary removed (issue #2641). The project-default target keeps its files.
  app.post<{ Querystring: Record<string, string | undefined> }>(
    "/internal/browser/forget",
    { ...rateLimit },
    async (request, reply) => {
      const target = parseBrowserTarget(app, request.query);
      if (!target) return reply.badRequest(MISSING_TARGET_MESSAGE);
      if (!app.browserEnabled) return { ok: true };
      if (target.legacy) await app.browser.closeTarget(target);
      else await app.browser.forgetCheckout(target.projectId, target.hostId, target.checkoutRoot);
      return { ok: true };
    },
  );
}
