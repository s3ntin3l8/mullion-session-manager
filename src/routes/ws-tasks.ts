import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { subscribeToTaskEvents } from "../services/task-events.js";

// #488 — no handshake message, unlike /ws/github's per-project subscribe:
// task events are global (see task-events.ts's own doc comment), so a
// connection is subscribed to everything the moment it opens.
export async function tasksWSRoute(app: FastifyInstance) {
  app.get("/ws/tasks", { websocket: true }, (socket: WebSocket) => {
    subscribeToTaskEvents(socket);
  });
}
