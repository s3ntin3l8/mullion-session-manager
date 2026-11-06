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
import { SESSION_ID_PARAMS_SCHEMA } from "./internal-schemas.js";

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
        return reply.badRequest("Invalid session id or browser target");
      }

      if (!app.browserEnabled) {
        return reply.badRequest("Browser feature is disabled");
      }

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
        return reply.badRequest("Invalid session id or browser target");
      }

      if (!app.browserEnabled) {
        return reply.badRequest("Browser feature is disabled");
      }

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
          return reply.badRequest("Invalid browser target");
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
      if (!target) return reply.badRequest("Invalid browser target");
      if (!app.browserEnabled) return { ok: true };
      await app.browser.closeTarget(target);
      return { ok: true };
    },
  );
}
