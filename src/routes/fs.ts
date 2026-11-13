import type { FastifyInstance, FastifyReply } from "fastify";
import { FsDirsError, listLocalDirectories } from "../services/fs-dirs.js";
import { LOCAL_HOST_ID, getHostRow } from "../services/host-registry.js";
import { HostRequestError, getRemoteHostClient } from "../services/remote-host-client.js";
import { forwardHostRequestError } from "../services/host-error-reply.js";

function replyFsDirsError(reply: FastifyReply, error: FsDirsError) {
  if (error.statusCode === 404) return reply.notFound(error.message);
  if (error.statusCode === 403) return reply.forbidden(error.message);
  return reply.badRequest(error.message);
}

export async function fsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path: string; hidden?: string; hostId?: string } }>(
    "/api/fs/dirs",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            hidden: { type: "string", enum: ["0", "1"] },
            hostId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { path, hidden, hostId } = request.query;
      const showHidden = hidden === "1";

      if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
        if (!getHostRow(app, hostId)) return reply.notFound(`Unknown host: ${hostId}`);
        // The listing is the agent host's own: its filesystem, its home dir.
        try {
          return await getRemoteHostClient(app, hostId).listDirectories(path, showHidden);
        } catch (err) {
          if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
          app.log.warn({ hostId, err }, "host unreachable, folder listing unavailable");
          return reply.serviceUnavailable(`Host ${hostId} is unreachable`);
        }
      }

      try {
        return await listLocalDirectories(path, showHidden);
      } catch (error) {
        if (error instanceof FsDirsError) return replyFsDirsError(reply, error);
        throw error;
      }
    },
  );
}
