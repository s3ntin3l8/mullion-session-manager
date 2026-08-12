import type { WebSocket } from "@fastify/websocket";
// GitHubWSEvent now physically lives in src/shared/ws-protocol.ts. The
// frontend previously had no typed version of this at all — store.ts's
// connectGitHubWS parsed incoming /ws/github messages to `unknown` and
// hand-inspected fields; it now imports this same type to narrow that
// parse (see store.ts's own comment). Re-exported below so every existing
// backend importer of this module keeps working unchanged.
import type { GitHubWSEvent } from "../shared/ws-protocol.js";

export type { GitHubWSEvent };

const subscribers = new Map<string, Set<WebSocket>>();

export function subscribeToProject(projectId: string, socket: WebSocket): void {
  if (!subscribers.has(projectId)) {
    subscribers.set(projectId, new Set());
  }
  subscribers.get(projectId)!.add(socket);

  socket.on("close", () => {
    const subs = subscribers.get(projectId);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) subscribers.delete(projectId);
    }
  });

  socket.on("error", () => {
    const subs = subscribers.get(projectId);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) subscribers.delete(projectId);
    }
  });
}

export function broadcastToProject(projectId: string, event: GitHubWSEvent): void {
  const subs = subscribers.get(projectId);
  if (!subs || subs.size === 0) return;

  const payload = JSON.stringify(event);
  for (const socket of subs) {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(payload);
      } catch {
        subs.delete(socket);
      }
    } else {
      subs.delete(socket);
    }
  }
  if (subs.size === 0) subscribers.delete(projectId);
}

/** Test-only introspection. */
export function getSubscriberCountForTests(projectId: string): number {
  return subscribers.get(projectId)?.size ?? 0;
}

export function clearSubscribersForTests(): void {
  subscribers.clear();
}
