import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { subscribeToProject } from "../services/github-ws-broadcast.js";

interface SubscribeMessage {
  type: "subscribe";
  // The frontend's own projectId is a number (see store.ts's
  // subscribeToGitHubProject), so `JSON.stringify` sends it as a JSON
  // number, not a string. subscribeToProject's own keying (and the
  // broadcast side's own `String(projectId)` normalization in
  // routes/webhooks.ts) is string-based, so this accepts either wire shape
  // and normalizes below — accepting only `string` here made every
  // subscribe frame silently fail the type check and never subscribe.
  projectId: string | number;
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
      if (
        msg?.type === "subscribe" &&
        (typeof msg.projectId === "string" || typeof msg.projectId === "number")
      ) {
        subscribeToProject(String(msg.projectId), socket);
      }
    });

    socket.on("close", () => {
      // Cleanup happens inside subscribeToProject's close handler.
    });
  });
}
