import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  subscribeToProject,
  broadcastToProject,
  getSubscriberCountForTests,
  clearSubscribersForTests,
} from "../../src/services/github-ws-broadcast.js";

function fakeSocket(): WebSocket & { _trigger(event: string): void } {
  const handlers = new Map<string, () => void>();
  return {
    readyState: 1,
    OPEN: 1,
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
  });
});
