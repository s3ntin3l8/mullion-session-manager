import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "@fastify/websocket";
import {
  createBroadcastChannel,
  createKeyedBroadcastChannel,
} from "../../src/services/ws-broadcast.js";

// A real EventEmitter (unlike a Map-of-handlers fake, which overwrites on
// repeated `on` and so hides listener accumulation — #1640).
function emitterSocket(): WebSocket & EventEmitter & { send: ReturnType<typeof vi.fn> } {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.readyState = 1;
  s.OPEN = 1;
  s.bufferedAmount = 0;
  s.send = vi.fn();
  return s as unknown as WebSocket & EventEmitter & { send: ReturnType<typeof vi.fn> };
}

describe("createBroadcastChannel", () => {
  it("attaches one close/error listener no matter how often a socket subscribes", () => {
    const channel = createBroadcastChannel<string>();
    const socket = emitterSocket();
    for (let i = 0; i < 20; i++) channel.subscribe(socket);
    expect(channel.getSubscriberCountForTests()).toBe(1);
    expect(socket.listenerCount("close")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);
  });

  it("removes the socket on close", () => {
    const channel = createBroadcastChannel<string>();
    const socket = emitterSocket();
    channel.subscribe(socket);
    socket.emit("close");
    expect(channel.getSubscriberCountForTests()).toBe(0);
  });
});

describe("createKeyedBroadcastChannel", () => {
  it("attaches one close/error listener per socket across many keys and repeats", () => {
    const channel = createKeyedBroadcastChannel<string, string>();
    const socket = emitterSocket();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 12; i++) channel.subscribe(`k${i}`, socket);
    }
    expect(socket.listenerCount("close")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);
    for (let i = 0; i < 12; i++) expect(channel.getSubscriberCountForTests(`k${i}`)).toBe(1);
  });

  it("removes the socket from every key on close, leaving other sockets alone", () => {
    const channel = createKeyedBroadcastChannel<string, string>();
    const a = emitterSocket();
    const b = emitterSocket();
    for (let i = 0; i < 12; i++) channel.subscribe(`k${i}`, a);
    channel.subscribe("k0", b);
    a.emit("close");
    for (let i = 0; i < 12; i++) {
      expect(channel.getSubscriberCountForTests(`k${i}`)).toBe(i === 0 ? 1 : 0);
    }
  });

  it("removes the socket from every key on error", () => {
    const channel = createKeyedBroadcastChannel<string, string>();
    const socket = emitterSocket();
    channel.subscribe("a", socket);
    channel.subscribe("b", socket);
    socket.emit("error", new Error("boom"));
    expect(channel.getSubscriberCountForTests("a")).toBe(0);
    expect(channel.getSubscriberCountForTests("b")).toBe(0);
  });

  it("still delivers broadcasts per key", () => {
    const channel = createKeyedBroadcastChannel<{ n: number }, string>();
    const socket = emitterSocket();
    const other = emitterSocket();
    channel.subscribe("a", socket);
    channel.subscribe("b", socket);
    channel.subscribe("b", other);
    channel.broadcast("a", { n: 1 });
    channel.broadcast("b", { n: 2 });
    expect(socket.send.mock.calls.map((c) => c[0])).toEqual(['{"n":1}', '{"n":2}']);
    expect(other.send.mock.calls.map((c) => c[0])).toEqual(['{"n":2}']);
  });

  it("works for a socket that re-subscribes after clearSubscribersForTests", () => {
    const channel = createKeyedBroadcastChannel<string, string>();
    const socket = emitterSocket();
    channel.subscribe("a", socket);
    channel.clearSubscribersForTests();
    channel.subscribe("a", socket);
    expect(channel.getSubscriberCountForTests("a")).toBe(1);
    socket.emit("close");
    expect(channel.getSubscriberCountForTests("a")).toBe(0);
  });
});
