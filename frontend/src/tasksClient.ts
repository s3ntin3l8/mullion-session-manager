// #488 — a single WS connection to the backend's /ws/tasks
// (src/routes/ws-tasks.ts), pushing a live event on every task status
// transition. Connected once at app mount (store.ts's startTasksStream),
// same lifecycle shape as eventsClient.ts's connectEventsStream — capped
// exponential backoff (500ms -> 8s), reconnects indefinitely rather than
// giving up, since store.ts's own 60s task poll (startLiveRefresh) already
// keeps the Tasks panel eventually-correct regardless of whether this
// channel is currently connected.
//
// Deliberately no "seen"/replay handshake, unlike eventsClient.ts: task
// events are a doorbell, not a data channel (see store.ts's onTaskEvent,
// which just triggers a debounced refetch) — a missed event while
// reconnecting is caught by the next poll tick or the next transition's own
// event, so there's nothing to replay.
//
// TaskEvent physically lives in src/shared/ws-protocol.ts (repo root, NOT
// this frontend workspace — see src/services/task-events.ts's own
// re-export), the backend's /ws/tasks push-event shape.
import type { TaskEvent } from "../../src/shared/ws-protocol.js";

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

export interface TasksClientHandle {
  /** Stops reconnecting and closes the current connection, if any. */
  close: () => void;
}

// #490a — this used to hardcode `kind === "transition" || kind ===
// "ingested"` as its own literal list, with a comment warning it "must never
// lag the backend that produces the wider set" — an easy invariant to
// violate silently, since nothing forced this list to stay in sync with the
// backend's own TaskEvent union. TASK_EVENT_KINDS below is instead typed as
// `Record<TaskEvent["kind"], true>`: if the backend's union ever grows a
// third `kind` arm without a matching entry added here, that's a missing-
// property `tsc` error in this file, not a silent runtime gap.
const TASK_EVENT_KINDS: Record<TaskEvent["kind"], true> = {
  transition: true,
  ingested: true,
  blockers: true,
};

function isTaskWireMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (typeof (value as { taskId?: unknown }).taskId !== "number") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && Object.hasOwn(TASK_EVENT_KINDS, kind);
}

/** Opens (and keeps reopening, on any drop) a connection to /ws/tasks,
 * calling `onTaskEvent` for every live transition **or ingestion** frame.
 * The payload
 * itself is deliberately not passed through — see store.ts's own comment
 * on why a debounced refetch, not payload-driven patching, is the
 * consumer shape here. */
export function connectTasksStream(onTaskEvent: () => void): TasksClientHandle {
  let ws: WebSocket | null = null;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  function connect(): void {
    if (destroyed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/tasks`);
    ws = socket;

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isTaskWireMessage(parsed)) onTaskEvent();
    });

    socket.addEventListener("close", () => {
      if (destroyed) return;
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  connect();

  return {
    close: () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    },
  };
}
