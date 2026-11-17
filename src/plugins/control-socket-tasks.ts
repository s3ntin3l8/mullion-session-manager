/**
 * #3165 / #3173 — full-scope Task Master write ops (`tasks.retry`, `tasks.start`, `tasks.close`, `tasks.archive`,
 * `tasks.unarchive`).
 */
import { extractIdField } from "../services/control-session-authority.js";
import {
  bad,
  json,
  routeOp,
  type OpContext,
  type OpSpec,
  type Route,
} from "./control-socket-core.js";
import { enc } from "./control-socket-support.js";

function withTaskId(fn: (id: string, ctx: OpContext) => Route): OpSpec {
  return routeOp(["full"], (ctx) => {
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
