import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { subscribeToProject, unsubscribeFromProject } from "../services/github-ws-broadcast.js";

interface SubscribeMessage {
  // `unsubscribe` (issue #1672) mirrors `subscribe`: the frontend sends it
  // when the last view of a project unmounts, while the shared socket stays
  // open for the projects still on screen.
  type: "subscribe" | "unsubscribe";
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
      if (typeof msg?.projectId !== "string" && typeof msg?.projectId !== "number") return;
      if (msg.type === "subscribe") subscribeToProject(String(msg.projectId), socket);
      else if (msg.type === "unsubscribe") unsubscribeFromProject(String(msg.projectId), socket);
    });

    socket.on("close", () => {
      // Cleanup happens inside subscribeToProject's close handler.
    });
  });
}
