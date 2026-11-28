/**
 * #2494 — list/start/stop a project's dock controls server-side. The
 * `docks.*` control-socket ops forward here (full scope with an explicit
 * `projectId`, session scope pinned to the caller's own project).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildAuthHeaders } from "../plugins/control-socket-core.js";
import { listDockSetups } from "../services/dock-setup.js";
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
    // Keep only numbers and a known code: nothing upstream is echoed back.
    const raw = res.json() as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const code = raw.code === "port_in_use" || raw.code === "setup_failed" ? raw.code : undefined;
    return {
      statusCode: res.statusCode,
      body: {
        id: num(raw.id),
        code,
        port: num(raw.port),
        holderSessionId: num(raw.holderSessionId),
        // #3588 — the one upstream text passed on: the setup recipe's outcome
        // and log tail, which is the reason the start failed.
        ...(code === "setup_failed" && typeof raw.message === "string"
          ? { setupDetail: raw.message }
          : {}),
      },
    };
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

  // #3588 — the project's dock starts that are waiting for its setup recipe
  // right now ("Installing dependencies…" on the Dock row and preview button).
  app.get<{ Params: { id: number } }>(
    "/api/projects/:id/dock/setups",
    { schema: { params: idParams } },
    async (request) => listDockSetups(request.params.id),
  );

  app.post<{
    Params: { id: number; controlId: string };
    Body: { branch?: string; worktreePath?: string; hostId?: string };
  }>(
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
            hostId: { type: "string", minLength: 1, maxLength: 128 },
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
    Body: { branch?: string; worktreePath?: string; hostId?: string };
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
            hostId: { type: "string", minLength: 1, maxLength: 128 },
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
