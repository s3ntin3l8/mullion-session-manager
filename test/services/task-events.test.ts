import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  subscribeToTaskEvents,
  broadcastTaskEvent,
  getTaskEventSubscriberCountForTests,
  clearTaskEventSubscribersForTests,
} from "../../src/services/task-events.js";

function fakeSocket(
  opts: { bufferedAmount?: number; readyState?: number } = {},
): WebSocket & { _trigger(event: string): void } {
  const handlers = new Map<string, () => void>();
  return {
    readyState: opts.readyState ?? 1,
    OPEN: 1,
    bufferedAmount: opts.bufferedAmount ?? 0,
    send: vi.fn(),
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    close: vi.fn(),
    _trigger(event: string) {
      handlers.get(event)?.();
    },
  } as unknown as WebSocket & { _trigger(event: string): void };
}

describe("task-events (#488)", () => {
  beforeEach(() => {
    clearTaskEventSubscribersForTests();
  });

  describe("subscribeToTaskEvents", () => {
    it("adds a socket to the global subscriber set", () => {
      subscribeToTaskEvents(fakeSocket());
      expect(getTaskEventSubscriberCountForTests()).toBe(1);
    });

    it("adds multiple sockets", () => {
      subscribeToTaskEvents(fakeSocket());
      subscribeToTaskEvents(fakeSocket());
      expect(getTaskEventSubscriberCountForTests()).toBe(2);
    });

    it("removes the socket on close", () => {
      const socket = fakeSocket();
      subscribeToTaskEvents(socket);
      socket._trigger("close");
      expect(getTaskEventSubscriberCountForTests()).toBe(0);
    });

    it("removes the socket on error", () => {
      const socket = fakeSocket();
      subscribeToTaskEvents(socket);
      socket._trigger("error");
      expect(getTaskEventSubscriberCountForTests()).toBe(0);
    });
  });

  describe("broadcastTaskEvent", () => {
    it("sends the event to every subscriber", () => {
      const s1 = fakeSocket();
      const s2 = fakeSocket();
      subscribeToTaskEvents(s1);
      subscribeToTaskEvents(s2);

      broadcastTaskEvent({
        taskId: 1,
        projectId: 2,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 123,
      });

      expect(s1.send).toHaveBeenCalledOnce();
      expect(s2.send).toHaveBeenCalledOnce();
      expect(JSON.parse((s1.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual({
        taskId: 1,
        projectId: 2,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 123,
      });
    });

    it("sends an 'ingested' event (#490a) — no from/to, unlike a transition", () => {
      const s1 = fakeSocket();
      subscribeToTaskEvents(s1);

      broadcastTaskEvent({ taskId: 1, projectId: 2, kind: "ingested", ts: 123 });

      expect(JSON.parse((s1.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toEqual({
        taskId: 1,
        projectId: 2,
        kind: "ingested",
        ts: 123,
      });
    });

    it("is a no-op when there are no subscribers", () => {
      expect(() =>
        broadcastTaskEvent({
          taskId: 1,
          projectId: 1,
          kind: "transition",
          from: "ready",
          to: "claimed",
          ts: 1,
        }),
      ).not.toThrow();
    });

    it("skips and prunes a socket that isn't OPEN", () => {
      const closedSocket = fakeSocket({ readyState: 3 });
      subscribeToTaskEvents(closedSocket);

      broadcastTaskEvent({
        taskId: 1,
        projectId: 1,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 1,
      });

      expect(closedSocket.send).not.toHaveBeenCalled();
      expect(getTaskEventSubscriberCountForTests()).toBe(0);
    });

    it("drops delivery to a socket over the backpressure threshold, without pruning it", () => {
      const backedUp = fakeSocket({ bufferedAmount: 5 * 1024 * 1024 });
      subscribeToTaskEvents(backedUp);

      broadcastTaskEvent({
        taskId: 1,
        projectId: 1,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 1,
      });

      expect(backedUp.send).not.toHaveBeenCalled();
      // Still subscribed — a full send buffer is transient, not a reason to
      // drop the connection (matches routes/events.ts's own posture).
      expect(getTaskEventSubscriberCountForTests()).toBe(1);
    });

    it("prunes a socket whose send() throws, without affecting the others", () => {
      const throwing = fakeSocket();
      (throwing.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("boom");
      });
      const healthy = fakeSocket();
      subscribeToTaskEvents(throwing);
      subscribeToTaskEvents(healthy);

      broadcastTaskEvent({
        taskId: 1,
        projectId: 1,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 1,
      });

      expect(healthy.send).toHaveBeenCalledOnce();
      expect(getTaskEventSubscriberCountForTests()).toBe(1);
    });
  });
});
