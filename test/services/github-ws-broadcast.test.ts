import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  subscribeToProject,
  broadcastToProject,
  getSubscriberCountForTests,
  clearSubscribersForTests,
} from "../../src/services/github-ws-broadcast.js";

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

describe("github-ws-broadcast", () => {
  beforeEach(() => {
    clearSubscribersForTests();
  });

  describe("subscribeToProject", () => {
    it("adds a socket to the project's subscriber set", () => {
      const socket = fakeSocket();
      subscribeToProject("project-1", socket);
      expect(getSubscriberCountForTests("project-1")).toBe(1);
    });

    it("adds multiple sockets to the same project", () => {
      subscribeToProject("project-1", fakeSocket());
      subscribeToProject("project-1", fakeSocket());
      expect(getSubscriberCountForTests("project-1")).toBe(2);
    });

    it("handles separate projects independently", () => {
      subscribeToProject("project-1", fakeSocket());
      subscribeToProject("project-2", fakeSocket());
      expect(getSubscriberCountForTests("project-1")).toBe(1);
      expect(getSubscriberCountForTests("project-2")).toBe(1);
    });

    it("removes socket on close event", () => {
      const socket = fakeSocket();
      subscribeToProject("project-1", socket);
      expect(getSubscriberCountForTests("project-1")).toBe(1);

      socket._trigger("close");
      expect(getSubscriberCountForTests("project-1")).toBe(0);
    });

    it("removes socket on error event", () => {
      const socket = fakeSocket();
      subscribeToProject("project-1", socket);
      expect(getSubscriberCountForTests("project-1")).toBe(1);

      socket._trigger("error");
      expect(getSubscriberCountForTests("project-1")).toBe(0);
    });

    // Regression coverage for the shared ws-broadcast.ts migration's
    // per-project channel map: a socket subscribed *before*
    // clearSubscribersForTests() still carries a close/error handler
    // closed over its (now-orphaned) channel instance. If that instance's
    // "the set just went empty" cleanup isn't itself neutralized by
    // clearSubscribersForTests(), the handler firing later can delete the
    // *new* channel a fresh subscribe installs at the same key out from
    // under a still-live subscriber.
    it("a stale socket closing after clearSubscribersForTests() does not evict a freshly resubscribed project", () => {
      const stale = fakeSocket();
      subscribeToProject("project-1", stale);
      clearSubscribersForTests();

      const fresh = fakeSocket();
      subscribeToProject("project-1", fresh);
      stale._trigger("close");

      expect(getSubscriberCountForTests("project-1")).toBe(1);
      broadcastToProject("project-1", {
        type: "push",
        projectId: "project-1",
        branch: "main",
        sha: "x",
      });
      expect(fresh.send).toHaveBeenCalledOnce();
    });
  });

  describe("broadcastToProject", () => {
    it("sends event to all subscribers", () => {
      const s1 = fakeSocket();
      const s2 = fakeSocket();
      subscribeToProject("project-1", s1);
      subscribeToProject("project-1", s2);

      broadcastToProject("project-1", {
        type: "pr",
        action: "opened",
        projectId: "1",
        pr: { number: 42 },
      });

      expect(s1.send).toHaveBeenCalledOnce();
      expect(s2.send).toHaveBeenCalledOnce();
    });

    it("does not send to other projects", () => {
      const s1 = fakeSocket();
      subscribeToProject("project-1", s1);
      subscribeToProject("project-2", fakeSocket());

      broadcastToProject("project-1", {
        type: "pr",
        action: "opened",
        projectId: "1",
        pr: { number: 42 },
      });

      expect(s1.send).toHaveBeenCalledOnce();
    });

    it("is a no-op when no subscribers exist", () => {
      expect(() =>
        broadcastToProject("nonexistent", {
          type: "pr",
          action: "opened",
          projectId: "99",
          pr: { number: 1 },
        }),
      ).not.toThrow();
    });

    // Regression coverage for the shared ws-broadcast.ts migration: this
    // file previously had no backpressure guard at all (unlike
    // task-events.ts's own long-standing 4 MiB test of the same shape) —
    // a slow/stuck subscriber's unbounded bufferedAmount could grow
    // forever. Migrating onto createKeyedBroadcastChannel makes the guard
    // a standard, always-on property of the shared channel, so this
    // project-scoped channel now gets it for free too.
    it("drops delivery to a subscriber over the backpressure threshold, without pruning it", () => {
      const backedUp = fakeSocket({ bufferedAmount: 5 * 1024 * 1024 });
      subscribeToProject("project-1", backedUp);

      broadcastToProject("project-1", {
        type: "pr",
        action: "opened",
        projectId: "project-1",
        pr: { number: 42 },
      });

      expect(backedUp.send).not.toHaveBeenCalled();
      // Still subscribed — a full send buffer is transient, not a reason
      // to drop the connection.
      expect(getSubscriberCountForTests("project-1")).toBe(1);
    });
  });
});
