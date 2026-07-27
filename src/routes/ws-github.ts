import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { subscribeToProject } from "../services/github-ws-broadcast.js";

interface SubscribeMessage {
  type: "subscribe";
  projectId: string;
}

export async function githubWSRoute(app: FastifyInstance) {
  app.get("/ws/github", { websocket: true }, (socket: WebSocket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      const msg = parsed as SubscribeMessage;
      if (msg?.type === "subscribe" && typeof msg.projectId === "string") {
        subscribeToProject(msg.projectId, socket);
      }
    });

    socket.on("close", () => {
      // Cleanup happens inside subscribeToProject's close handler.
    });
  });
}
