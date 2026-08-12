import type { WebSocket } from "@fastify/websocket";
// TaskEvent now physically lives in src/shared/ws-protocol.ts. The frontend
// previously had no typed mirror of this at all — tasksClient.ts's
// isTaskWireMessage was a hand-written guard hardcoding a literal list of
// `kind` values; it now derives that list from this same union (see
// tasksClient.ts's own comment). Re-exported below so every existing
// backend importer of this module keeps working unchanged.
import type { TaskEvent } from "../shared/ws-protocol.js";

export type { TaskEvent };

// #488 — a dedicated, session-less broadcast channel for task-transition
// events, deliberately NOT built on pty-manager.ts's NotificationEvent
// model. That model is per-session by construction at four independent
// layers: the type itself (`sessionId: number`), server-side replay/filter
// keying (routes/events.ts), the frontend's wire-frame validator (which
// hard-rejects any frame lacking a numeric sessionId — eventsClient.ts),
// and the store's `Record<number, NotificationEvent[]>` slice, rendered by
// indexing off the sessions list (NotificationBell.tsx). A task in
// "backlog"/"ready" has no session to key an event on, and widening
// NotificationEvent to accommodate one would be a large, high-risk change
// to the file CLAUDE.md's own header warns against touching casually — for
// a benefit this dedicated channel delivers directly instead.
//
// Modeled on github-ws-broadcast.ts's shape (module-global subscriber set,
// JSON.stringify-once fan-out), with two differences: the 4 MiB
// backpressure drop routes/events.ts already established for /ws/events,
// and a global (not per-project) subscriber set — the Tasks panel is
// cross-project, so per-project subscription would be the wrong shape.
// Deliberately NO replay buffer: every consumer (frontend's tasksClient.ts)
// reacts to an event with a debounced refetch, not by replaying event
// history, so a reconnecting client just needs one refresh on connect.

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const subscribers = new Set<WebSocket>();

export function subscribeToTaskEvents(socket: WebSocket): void {
  subscribers.add(socket);

  const remove = () => subscribers.delete(socket);
  socket.on("close", remove);
  socket.on("error", remove);
}

export function broadcastTaskEvent(event: TaskEvent): void {
  if (subscribers.size === 0) return;

  const payload = JSON.stringify(event);
  for (const socket of subscribers) {
    if (socket.readyState !== socket.OPEN) {
      subscribers.delete(socket);
      continue;
    }
    if (socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) continue;
    try {
      socket.send(payload);
    } catch {
      subscribers.delete(socket);
    }
  }
}

/** Test-only introspection. */
export function getTaskEventSubscriberCountForTests(): number {
  return subscribers.size;
}

export function clearTaskEventSubscribersForTests(): void {
  subscribers.clear();
}
