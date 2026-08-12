import type { WebSocket } from "@fastify/websocket";

// Shared shape behind every WS "broadcast channel" service in this repo:
// subscriber-set management, cleanup on `close`/`error`, JSON-stringify-once
// fan-out to every subscriber, and pruning dead sockets by `readyState`.
// Extracted from task-events.ts and github-ws-broadcast.ts, which both
// hand-rolled this independently — see each file's own (now much shorter)
// header comment for its specific semantics.
//
// Two call shapes exist because the two real callers need different
// keying:
//   - createBroadcastChannel: one flat, unkeyed subscriber set (task-events.ts
//     — the Tasks panel is cross-project, so every subscriber gets every
//     event).
//   - createKeyedBroadcastChannel: a Map of independent channels keyed by
//     an arbitrary key (github-ws-broadcast.ts — a subscriber only ever
//     gets events for the one project it subscribed to). It's built on top
//     of createBroadcastChannel per key, not a separate implementation, so
//     the fan-out/cleanup/backpressure logic below has exactly one copy.
//
// The 4 MiB `bufferedAmount` backpressure guard (drop delivery to a slow
// subscriber rather than let it buffer unboundedly, without dropping the
// subscription itself) was previously task-events.ts-only; it's now a
// fixed, always-on property of the shared channel — not opt-in/configurable,
// since neither real caller needs a different threshold — so
// github-ws-broadcast.ts gains it for free as part of this migration. A
// deliberate fix for a gap task-events.ts's own old header comment already
// flagged, not incidental scope creep.

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface BroadcastChannelOptions {
  /**
   * Invoked whenever the subscriber set transitions from non-empty to
   * empty. Internal — used by createKeyedBroadcastChannel below to prune a
   * key's entry from its map; neither real caller (task-events.ts,
   * github-ws-broadcast.ts) passes this directly.
   */
  onEmpty?: () => void;
}

export interface BroadcastChannel<TEvent> {
  /** Adds `socket` to the subscriber set; removes it automatically on `close`/`error`. */
  subscribe(socket: WebSocket): void;
  /** JSON-stringifies `event` once and fans it out to every open, non-backed-up subscriber. */
  broadcast(event: TEvent): void;
  /** Test-only introspection. */
  getSubscriberCountForTests(): number;
  /** Test-only reset. */
  clearSubscribersForTests(): void;
}

export function createBroadcastChannel<TEvent>(
  options: BroadcastChannelOptions = {},
): BroadcastChannel<TEvent> {
  const subscribers = new Set<WebSocket>();

  function remove(socket: WebSocket): void {
    if (!subscribers.delete(socket)) return;
    if (subscribers.size === 0) options.onEmpty?.();
  }

  function subscribe(socket: WebSocket): void {
    subscribers.add(socket);
    socket.on("close", () => remove(socket));
    socket.on("error", () => remove(socket));
  }

  function broadcast(event: TEvent): void {
    if (subscribers.size === 0) return;

    const payload = JSON.stringify(event);
    for (const socket of subscribers) {
      if (socket.readyState !== socket.OPEN) {
        remove(socket);
        continue;
      }
      // A full send buffer is transient, not a reason to drop the
      // connection — skip this delivery but keep the subscription.
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      try {
        socket.send(payload);
      } catch {
        remove(socket);
      }
    }
  }

  return {
    subscribe,
    broadcast,
    getSubscriberCountForTests: () => subscribers.size,
    clearSubscribersForTests: () => subscribers.clear(),
  };
}

export interface KeyedBroadcastChannel<TEvent, TKey> {
  /** Adds `socket` to `key`'s subscriber set; removes it automatically on `close`/`error`. */
  subscribe(key: TKey, socket: WebSocket): void;
  /** Fans `event` out to `key`'s subscribers only — never any other key's. */
  broadcast(key: TKey, event: TEvent): void;
  /** Test-only introspection. */
  getSubscriberCountForTests(key: TKey): number;
  /** Test-only reset. */
  clearSubscribersForTests(): void;
}

export function createKeyedBroadcastChannel<TEvent, TKey>(): KeyedBroadcastChannel<TEvent, TKey> {
  const channels = new Map<TKey, BroadcastChannel<TEvent>>();

  function getOrCreate(key: TKey): BroadcastChannel<TEvent> {
    let channel = channels.get(key);
    if (!channel) {
      // Each key gets its own independent subscriber set, so a broadcast
      // scoped to one key can never reach another key's subscribers. The
      // per-key channel prunes itself from this map once its last
      // subscriber leaves (matching the prior hand-rolled
      // `if (subs.size === 0) subscribers.delete(projectId)` behavior).
      //
      // The `channels.get(key) === thisChannel` check is belt-and-braces,
      // not currently load-bearing via any real call path: today,
      // clearSubscribersForTests() below already empties each channel's
      // own subscriber set before clearing this map, so a stale socket's
      // close/error handler hits createBroadcastChannel's own `remove()`
      // early-return (`if (!subscribers.delete(socket)) return`) before
      // onEmpty would even fire — see this file's regression test in
      // github-ws-broadcast.test.ts, which passes via that path today.
      // Kept as cheap insurance against a future change (e.g. a caller
      // clearing this map directly, or replacing a key's entry some other
      // way) reintroducing the race: without it, an orphaned instance's
      // onEmpty firing after a NEW channel has been installed at this key
      // would delete that new one's live entry out from under it.
      const thisChannel: BroadcastChannel<TEvent> = createBroadcastChannel<TEvent>({
        onEmpty: () => {
          if (channels.get(key) === thisChannel) channels.delete(key);
        },
      });
      channel = thisChannel;
      channels.set(key, channel);
    }
    return channel;
  }

  function subscribe(key: TKey, socket: WebSocket): void {
    getOrCreate(key).subscribe(socket);
  }

  function broadcast(key: TKey, event: TEvent): void {
    channels.get(key)?.broadcast(event);
  }

  function getSubscriberCountForTests(key: TKey): number {
    return channels.get(key)?.getSubscriberCountForTests() ?? 0;
  }

  function clearSubscribersForTests(): void {
    // Clear each channel's own subscriber set too, not just this map —
    // otherwise a socket subscribed before this call still has a live
    // close/error handler pointing at its (now-orphaned) channel instance,
    // which would later delete a *different* channel that gets installed
    // at the same key after this call returns (see the identity check in
    // getOrCreate above).
    for (const channel of channels.values()) channel.clearSubscribersForTests();
    channels.clear();
  }

  return { subscribe, broadcast, getSubscriberCountForTests, clearSubscribersForTests };
}
