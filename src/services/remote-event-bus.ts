import type { NotificationEvent } from "./pty-manager.js";

// Issue #2125 — a primary-wide, in-process feed of the events that REMOTE hosts
// report. The primary's own sessions emit through `app.pty.onEvent`; a session on
// an agent host emits in that agent's PtyManager and reaches the primary only
// through the remote event subscriber (remote-event-subscriber.ts), which until
// now handed each event to the event writer and nothing else. A session-scope
// `events.subscribe` (including one relayed from an agent host) needs the same
// events live, filtered to the connection's own session and children, so the
// subscriber also publishes them here.

type Listener = (event: NotificationEvent) => void;

export class RemoteEventBus {
  private readonly listeners = new Set<Listener>();

  /** `onDemandChange` runs when the bus goes from no listener to one or back, so the
   * subscriber can open its upstreams on demand and close them when nobody listens. */
  constructor(private readonly onDemandChange: () => void = () => {}) {}

  /** Registers `listener`; the returned function removes it. */
  subscribe(listener: Listener): () => void {
    const wasEmpty = this.listeners.size === 0;
    this.listeners.add(listener);
    if (wasEmpty) this.demandChanged();
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) this.demandChanged();
    };
  }

  /** Opening or closing upstreams must never break the stream that triggered it. */
  private demandChanged(): void {
    try {
      this.onDemandChange();
    } catch {
      // The next retention-sweep tick reconciles the upstream set anyway.
    }
  }

  /** Delivers `event` to every listener. A throwing listener never stops the rest. */
  publish(event: NotificationEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken stream must not take the event path (or the writer) down.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
