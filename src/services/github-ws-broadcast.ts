import type { WebSocket } from "@fastify/websocket";
// GitHubWSEvent now physically lives in src/shared/ws-protocol.ts. The
// frontend previously had no typed version of this at all — store.ts's
// connectGitHubWS parsed incoming /ws/github messages to `unknown` and
// hand-inspected fields; it now imports this same type to narrow that
// parse (see store.ts's own comment). Re-exported below so every existing
// backend importer of this module keeps working unchanged.
import type { GitHubWSEvent } from "../shared/ws-protocol.js";
import { createKeyedBroadcastChannel } from "./ws-broadcast.js";

export type { GitHubWSEvent };

// Built on ws-broadcast.ts's createKeyedBroadcastChannel — the same shared
// subscriber-set/cleanup/fan-out/backpressure primitive task-events.ts uses,
// keyed here per-project (a subscriber only ever receives events for the
// one project it subscribed to) rather than that file's global/unkeyed
// shape. This also means every subscriber now gets the 4 MiB
// `bufferedAmount` backpressure guard task-events.ts always had and this
// file previously lacked — a slow/stuck subscriber has its delivery
// dropped instead of buffering unboundedly, without losing its
// subscription.
const channel = createKeyedBroadcastChannel<GitHubWSEvent, string>();

export function subscribeToProject(projectId: string, socket: WebSocket): void {
  channel.subscribe(projectId, socket);
}

export function broadcastToProject(projectId: string, event: GitHubWSEvent): void {
  channel.broadcast(projectId, event);
}

/** Test-only introspection. */
export function getSubscriberCountForTests(projectId: string): number {
  return channel.getSubscriberCountForTests(projectId);
}

export function clearSubscribersForTests(): void {
  channel.clearSubscribersForTests();
}
