/**
 * #3165 / #3173 — full-scope Task Master control-socket ops (`tasks.list`,
 * `tasks.get`, `tasks.retry`, `tasks.start`, `tasks.close`, `tasks.archive`,
 * `tasks.unarchive`).
 */
import { extractIdField } from "../services/control-session-authority.js";
import {
  CONTROL_SOCKET_VIA_HEADER,
  CONTROL_SOCKET_VIA_TOKEN,
} from "../services/internal-request.js";
import {
  bad,
  buildAuthHeaders,
  buildQueryUrl,
  injectRoute,
  json,
  jsonHeaders,
  type OpContext,
  type OpSpec,
  type ReplyPayload,
  type Route,
} from "./control-socket-core.js";
import { enc } from "./control-socket-support.js";

function fullTaskOp(resolve: (ctx: OpContext) => Route | ReplyPayload): OpSpec {
  return {
    scopes: ["full"],
    handler: async (ctx) => {
      const resolved = resolve(ctx);
      if (!("method" in resolved)) {
        ctx.reply(resolved);
        return;
      }
      ctx.reply(
        await injectRoute(ctx.app, ctx.conn, {
          method: resolved.method,
          url: resolved.url,
          headers: {
            ...(resolved.payload !== undefined ? jsonHeaders(ctx.app) : buildAuthHeaders(ctx.app)),
            [CONTROL_SOCKET_VIA_HEADER]: CONTROL_SOCKET_VIA_TOKEN,
          },
          ...(resolved.payload !== undefined ? { payload: resolved.payload } : {}),
        }),
      );
    },
  };
}

function withTaskId(fn: (id: string, ctx: OpContext) => Route): OpSpec {
  return fullTaskOp((ctx) => {
    const id = extractIdField(ctx.body, "taskId");
    return id === null ? bad(400, "'taskId' is required") : fn(id, ctx);
  });
}

function forwardLaunchFields(body: Record<string, unknown> | undefined): string {
  const forward: Record<string, unknown> = {};
  if (body?.agent !== undefined) forward.agent = body.agent;
  if (body?.reviewAgent !== undefined) forward.reviewAgent = body.reviewAgent;
  return json(forward);
}

export const taskOps: Record<string, OpSpec> = {
  "tasks.list": fullTaskOp(({ body }) => ({
    method: "GET",
    url: buildQueryUrl("/api/tasks", body),
  })),
  "tasks.get": withTaskId((id) => ({ method: "GET", url: `/api/tasks/${enc(id)}` })),
  "tasks.retry": withTaskId((id, { body }) => ({
    method: "POST",
    url: `/api/tasks/${enc(id)}/retry`,
    payload: forwardLaunchFields(body),
  })),
  "tasks.start": withTaskId((id, { body }) => ({
    method: "POST",
    url: `/api/tasks/${enc(id)}/claim`,
    payload: forwardLaunchFields(body),
  })),
  "tasks.close": withTaskId((id, { body }) => ({
    method: "POST",
    url: `/api/tasks/${enc(id)}/give-up`,
    payload: json(body?.reason !== undefined ? { reason: body.reason } : {}),
  })),
  "tasks.archive": withTaskId((id) => ({
    method: "POST",
    url: `/api/tasks/${enc(id)}/archive`,
  })),
  "tasks.unarchive": withTaskId((id) => ({
    method: "DELETE",
    url: `/api/tasks/${enc(id)}/archive`,
  })),
};
