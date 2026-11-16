import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

// Issue #3174 — the delivery half of the hook forwarder: a `Stop` the hook
// socket refuses is retried with a bounded backoff instead of being dropped
// (a lost `Stop` leaves a finished headless Task Master worker looking
// unfinished until its budget expires).
//
// These tests drive the module IN-PROCESS against a real Unix socket — the
// same posture as test/hooks/forwarder.test.ts, which drives the forwarder
// itself as a spawned child process. The split is the same one
// forwarder-core.mjs has: this module is importable, so it can be
// exercised directly, while forwarder.mjs can only be exercised through a
// real spawn.

const { deliverStop, stopRetryDelays, STOP_RETRY_DELAYS_MS } =
  await import("../../src/hooks/forwarder-delivery.mjs");

const RETRY_DELAYS_ENV = "MULLION_FORWARDER_STOP_RETRY_DELAYS_MS";

/**
 * A stand-in for the hook socket.
 *
 * `mode` decides how it behaves, mirroring the real listener (see
 * src/plugins/hooks.ts's handleConnection):
 *
 *   - "refuse": answers `{"ack":"refused"}` and closes, without dispatching
 *     anything — what the real listener does when the handshake's token
 *     does not resolve to a live session;
 *   - "silent": dispatches the message and says nothing at all — an older
 *     Mullion, which does not speak the delivery protocol;
 *   - "error": answers with the socket's own `{"error": ...}` reply;
 *   - "accept": answers `{"ack":"accepted"}` plus one `{"ack":"delivered"}`
 *     per message.
 *
 * `refusals` is how many of the first connections are refused before the
 * socket starts accepting.
 */
function fakeSocket(
  socketPath: string,
  options: { refuseFirst?: number; after?: "accept" | "silent" | "error" } = {},
): { server: net.Server; connections: () => number; dispatched: () => unknown[] } {
  const refuseFirst = options.refuseFirst ?? 0;
  const after = options.after ?? "accept";
  let connections = 0;
  const dispatched: unknown[] = [];
  const server = net.createServer((socket) => {
    const index = connections++;
    const mode = index < refuseFirst ? "refuse" : after;
    let buffer = "";
    let handshakeSeen = false;
    let refused = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        if (!handshakeSeen) {
          handshakeSeen = true;
          if (mode === "refuse") {
            refused = true;
            socket.write(`${JSON.stringify({ ack: "refused" })}\n`);
            socket.end();
            return;
          }
          if (mode === "error") {
            socket.write(`${JSON.stringify({ error: "malformed hook message" })}\n`);
            return;
          }
          if (mode === "accept") {
            socket.write(`${JSON.stringify({ ack: "accepted" })}\n`);
          }
          continue;
        }
        if (refused) continue;
        dispatched.push(JSON.parse(line));
        if (mode === "accept") {
          socket.write(`${JSON.stringify({ ack: "delivered" })}\n`);
        }
      }
    });
  });
  server.listen(socketPath);
  return { server, connections: () => connections, dispatched: () => dispatched };
}

describe("forwarder-delivery.mjs (issue #3174)", () => {
  let dir: string;
  let servers: net.Server[] = [];
  const originalDelays = process.env[RETRY_DELAYS_ENV];

  afterEach(() => {
    for (const server of servers) server.close();
    servers = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (originalDelays === undefined) delete process.env[RETRY_DELAYS_ENV];
    else process.env[RETRY_DELAYS_ENV] = originalDelays;
  });

  function socketPath(): string {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-delivery-"));
    return path.join(dir, "hooks.sock");
  }

  it("retries a refused Stop until the socket accepts it, and delivers it exactly once", async () => {
    const target = socketPath();
    const socket = fakeSocket(target, { refuseFirst: 2 });
    servers.push(socket.server);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.env[RETRY_DELAYS_ENV] = "10,20,30";

    const delivered = await deliverStop(target, "tok-123", [{ kind: "progress", phase: "done" }]);

    expect(delivered).toBe(true);
    // Three connections: two refused, one accepted — the Stop is delivered
    // ONCE, even though the delivery was attempted three times.
    expect(socket.connections()).toBe(3);
    expect(socket.dispatched()).toEqual([{ kind: "progress", phase: "done" }]);
  });

  it("gives up after the retry bound when the socket keeps refusing", async () => {
    const target = socketPath();
    const socket = fakeSocket(target, { refuseFirst: Number.MAX_SAFE_INTEGER });
    servers.push(socket.server);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.env[RETRY_DELAYS_ENV] = "10,20,30";

    const delivered = await deliverStop(target, "tok-123", [{ kind: "progress", phase: "done" }]);

    expect(delivered).toBe(false);
    // Three delays = four attempts in total, then the forwarder gives up
    // silently.
    expect(socket.connections()).toBe(4);
    expect(socket.dispatched()).toEqual([]);
  });

  it("retries while the socket is not there at all — nothing was written, so nothing can have landed", async () => {
    const target = socketPath();
    // No server is listening on this path.
    process.env[RETRY_DELAYS_ENV] = "10,20";

    const delivered = await deliverStop(target, "tok-123", [{ kind: "progress", phase: "done" }]);

    expect(delivered).toBe(false);
  });

  it("does NOT retry a delivery the socket never acknowledged", async () => {
    const target = socketPath();
    // An older Mullion: it dispatches the message and says nothing at all.
    // A retry would deliver the same event a second time, so the delivery
    // must not be retried — the socket cannot be told whether the first
    // attempt landed.
    const socket = fakeSocket(target, { after: "silent" });
    servers.push(socket.server);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.env[RETRY_DELAYS_ENV] = "10,20,30";

    const delivered = await deliverStop(target, "tok-123", [{ kind: "progress", phase: "done" }]);

    expect(delivered).toBe(false);
    expect(socket.connections()).toBe(1);
    expect(socket.dispatched()).toHaveLength(1);
  });

  it("gives up on the socket's own error reply — the same message fails the same way every time", async () => {
    const target = socketPath();
    const socket = fakeSocket(target, { after: "error" });
    servers.push(socket.server);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.env[RETRY_DELAYS_ENV] = "10,20,30";

    const delivered = await deliverStop(target, "tok-123", [{ kind: "progress", phase: "done" }]);

    expect(delivered).toBe(false);
    expect(socket.connections()).toBe(1);
  });

  it("waits for every message of a multi-message delivery", async () => {
    const target = socketPath();
    const socket = fakeSocket(target);
    servers.push(socket.server);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.env[RETRY_DELAYS_ENV] = "10,20,30";

    const delivered = await deliverStop(target, "tok-123", [
      { kind: "progress", phase: "done" },
      { kind: "stop_failure", error: "rate_limit" },
    ]);

    expect(delivered).toBe(true);
    expect(socket.dispatched()).toHaveLength(2);
  });

  describe("the retry delays", () => {
    it("defaults to the built-in delays", () => {
      delete process.env[RETRY_DELAYS_ENV];
      expect(stopRetryDelays()).toEqual(STOP_RETRY_DELAYS_MS);
    });

    it("honours the test override", () => {
      process.env[RETRY_DELAYS_ENV] = "10,20,30";
      expect(stopRetryDelays()).toEqual([10, 20, 30]);
    });

    it("falls back to the built-in delays for a malformed override", () => {
      process.env[RETRY_DELAYS_ENV] = "not-a-number";
      expect(stopRetryDelays()).toEqual(STOP_RETRY_DELAYS_MS);
      process.env[RETRY_DELAYS_ENV] = "";
      expect(stopRetryDelays()).toEqual(STOP_RETRY_DELAYS_MS);
    });
  });
});
