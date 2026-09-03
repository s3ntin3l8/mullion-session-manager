import type { WebSocket } from "@fastify/websocket";
// TaskEvent now physically lives in src/shared/ws-protocol.ts. The frontend
// previously had no typed mirror of this at all — tasksClient.ts's
// isTaskWireMessage was a hand-written guard hardcoding a literal list of
// `kind` values; it now derives that list from this same union (see
// tasksClient.ts's own comment). Re-exported below so every existing
// backend importer of this module keeps working unchanged.
import type { TaskEvent } from "../shared/ws-protocol.js";
import { createBroadcastChannel } from "./ws-broadcast.js";

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
// to the file AGENTS.md's own "non-obvious session model" invariant warns
// against touching casually — for
// a benefit this dedicated channel delivers directly instead.
//
// Built on ws-broadcast.ts's createBroadcastChannel — the same shared
// subscriber-set/cleanup/fan-out/backpressure primitive
// github-ws-broadcast.ts now also uses, keyed here with the unkeyed
// (module-global) shape rather than that file's per-project one: the Tasks
// panel is cross-project, so per-project subscription would be the wrong
// shape. Deliberately NO replay buffer: every consumer (frontend's
// tasksClient.ts) reacts to an event with a debounced refetch, not by
// replaying event history, so a reconnecting client just needs one refresh
// on connect.

const channel = createBroadcastChannel<TaskEvent>();

export function subscribeToTaskEvents(socket: WebSocket): void {
  channel.subscribe(socket);
}

export function broadcastTaskEvent(event: TaskEvent): void {
  channel.broadcast(event);
}

/** Test-only introspection. */
export function getTaskEventSubscriberCountForTests(): number {
  return channel.getSubscriberCountForTests();
}

export function clearTaskEventSubscribersForTests(): void {
  channel.clearSubscribersForTests();
}
