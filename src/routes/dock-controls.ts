/**
 * #2494 — list/start/stop a project's dock controls server-side. The
 * `docks.*` control-socket ops forward here (full scope with an explicit
 * `projectId`, session scope pinned to the caller's own project).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildAuthHeaders } from "../plugins/control-socket-core.js";
import {
  listDockControls,
  startDockControl,
  switchDockControl,
  stopDockControl,
  type DockControlResult,
  type LaunchSession,
} from "../services/dock-control.js";

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer" } },
} as const;
const controlParams = {
  type: "object",
  required: ["id", "controlId"],
  properties: { id: { type: "integer" }, controlId: { type: "string", minLength: 1 } },
} as const;

export async function dockControlsRoute(app: FastifyInstance) {
  // Re-enter POST /api/sessions so a launch behaves exactly like the dashboard's
  // (port-conflict probe, host placement, worktree intent).
  const launch: LaunchSession = async (payload) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { ...buildAuthHeaders(app), "content-type": "application/json" },
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() };
  };

  const send = <T>(reply: FastifyReply, result: DockControlResult<T>) =>
    result.ok
      ? result.value
      : reply
          .code(result.status)
          .send({ statusCode: result.status, message: result.message, ...result.body });

  app.get<{ Params: { id: number } }>(
    "/api/projects/:id/dock/controls",
    { schema: { params: idParams } },
    async (request, reply) => send(reply, await listDockControls(app, request.params.id)),
  );

  app.post<{ Params: { id: number; controlId: string }; Body: { branch?: string } }>(
    "/api/projects/:id/dock/controls/:controlId/start",
    {
      schema: {
        params: controlParams,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            branch: { type: "string", minLength: 1 },
            worktreePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, controlId } = request.params;
      const result = await startDockControl(app, id, controlId, request.body ?? {}, launch);
      if (result.ok) reply.code(201);
      return send(reply, result);
    },
  );

  app.post<{ Params: { id: number; controlId: string } }>(
    "/api/projects/:id/dock/controls/:controlId/stop",
    { schema: { params: controlParams } },
    async (request, reply) =>
      send(reply, await stopDockControl(app, request.params.id, request.params.controlId)),
  );

  app.post<{
    Params: { id: number; controlId: string };
    Body: { branch?: string; worktreePath?: string };
  }>(
    "/api/projects/:id/dock/controls/:controlId/switch",
    {
      schema: {
        params: controlParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            branch: { type: "string", minLength: 1 },
            worktreePath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, controlId } = request.params;
      const result = await switchDockControl(app, id, controlId, request.body, launch);
      if (result.ok) reply.code(201);
      return send(reply, result);
    },
  );
}
