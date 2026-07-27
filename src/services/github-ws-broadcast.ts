import type { WebSocket } from "@fastify/websocket";

const subscribers = new Map<string, Set<WebSocket>>();

export type GitHubWSEvent =
  | {
      type: "pr";
      action: "opened" | "closed" | "sync";
      projectId: string;
      pr: Record<string, unknown>;
      ci?: Record<string, unknown>[];
    }
  | {
      type: "issue";
      action: "opened" | "closed";
      projectId: string;
      counts: { open: number; closed: number };
    }
  | {
      type: "ci";
      action: "completed" | "started";
      projectId: string;
      run: Record<string, unknown>;
      jobs?: Record<string, unknown>[];
    }
  | { type: "release"; action: "published"; projectId: string; release: Record<string, unknown> }
  | { type: "push"; projectId: string; branch: string; sha: string };

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
