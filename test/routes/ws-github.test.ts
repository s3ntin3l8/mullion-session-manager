import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Real integration test against a genuine listening server, same harness
// shape as test/routes/ws-tasks.test.ts — app.inject() can't drive a full
// WebSocket upgrade.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { broadcastToProject, clearSubscribersForTests, getSubscriberCountForTests } =
  await import("../../src/services/github-ws-broadcast.js");

const tmpDb = path.join(os.tmpdir(), `ws-github-test-${process.pid}.db`);

function collectJsonMessages(ws: WebSocket): unknown[] {
  const messages: unknown[] = [];
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string));
  });
  return messages;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
}

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

// Sending over a real loopback socket is genuine async network IO, not a
// same-tick operation — waiting on the broadcast side's own subscriber
// count (rather than a fixed number of setImmediate ticks) is what proves
// the subscribe frame actually landed and was processed before the test
// broadcasts, instead of guessing how many ticks a real round trip takes.
async function waitUntilSubscribed(projectId: string) {
  await waitUntil(() => getSubscriberCountForTests(projectId) > 0);
}

describe("GitHub WS route (/ws/github)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function buildAndListen() {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    clearSubscribersForTests();
    return { app, port: address.port };
  }

  // Regression test: the frontend's own subscribe message sends projectId
  // as a JSON *number* (store.ts's subscribeToGitHubProject is typed
  // `(projectId: number)`), not a string. A subscribe that only accepted
  // `typeof projectId === "string"` silently dropped every real-world
  // subscribe frame and never delivered a broadcast.
  it("subscribes and receives a broadcast when projectId is sent as a number", async () => {
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/github`);
      const messages = collectJsonMessages(ws);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "subscribe", projectId: 42 }));
      await waitUntilSubscribed("42");

      broadcastToProject("42", {
        type: "issue",
        action: "opened",
        projectId: "42",
        counts: { open: 1, closed: 0 },
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({ type: "issue", projectId: "42" });

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("subscribes and receives a broadcast when projectId is sent as a string", async () => {
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/github`);
      const messages = collectJsonMessages(ws);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "subscribe", projectId: "7" }));
      await waitUntilSubscribed("7");

      broadcastToProject("7", {
        type: "push",
        projectId: "7",
        branch: "main",
        sha: "abc123",
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({ type: "push", projectId: "7" });

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("does not deliver a broadcast for a project this socket never subscribed to", async () => {
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/github`);
      const messages = collectJsonMessages(ws);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "subscribe", projectId: 1 }));
      await waitUntilSubscribed("1");

      broadcastToProject("2", {
        type: "issue",
        action: "opened",
        projectId: "2",
        counts: { open: 1, closed: 0 },
      });

      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(messages).toHaveLength(0);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("ignores a malformed message instead of throwing", async () => {
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/github`);
      // Attached before the malformed sends below, so the assertion after
      // them actually proves they were dropped silently rather than only
      // proving the socket survived to accept a later, valid subscribe
      // (Hermes review, PR #515).
      const messages = collectJsonMessages(ws);
      await waitForOpen(ws);

      ws.send("not json");
      ws.send(JSON.stringify({ type: "subscribe" })); // missing projectId
      ws.send(JSON.stringify({ type: "subscribe", projectId: true })); // wrong type
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(messages).toHaveLength(0);

      // The socket is still alive and usable afterward — a real subscribe
      // still works.
      ws.send(JSON.stringify({ type: "subscribe", projectId: 99 }));
      await waitUntilSubscribed("99");
      broadcastToProject("99", { type: "push", projectId: "99", branch: "main", sha: "x" });
      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({ type: "push", projectId: "99" });

      ws.close();
    } finally {
      await app.close();
    }
  });
  // Issue #1672 — `unsubscribe` stops one project's events on a socket that
  // stays open, and leaves its other projects live.
  it("unsubscribes one project and keeps the socket's other projects live", async () => {
    const { app, port } = await buildAndListen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/github`);
      const messages = collectJsonMessages(ws);
      await waitForOpen(ws);

      ws.send(JSON.stringify({ type: "subscribe", projectId: 11 }));
      ws.send(JSON.stringify({ type: "subscribe", projectId: 12 }));
      await waitUntilSubscribed("11");
      await waitUntilSubscribed("12");

      ws.send(JSON.stringify({ type: "unsubscribe", projectId: 11 }));
      await waitUntil(() => getSubscriberCountForTests("11") === 0);
      expect(getSubscriberCountForTests("12")).toBe(1);

      broadcastToProject("11", { type: "push", projectId: "11", branch: "main", sha: "a" });
      broadcastToProject("12", { type: "push", projectId: "12", branch: "main", sha: "b" });
      await waitUntil(() => messages.length > 0);
      // Let a stray project-11 frame arrive if one were coming.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(messages).toEqual([expect.objectContaining({ projectId: "12" })]);

      // Re-subscribing after an unsubscribe works on the same socket.
      ws.send(JSON.stringify({ type: "subscribe", projectId: "11" }));
      await waitUntilSubscribed("11");

      ws.close();
    } finally {
      await app.close();
    }
  });
});
