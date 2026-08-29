import { describe, it, expect } from "vitest";
import net from "node:net";
import path from "node:path";
import { buildTestApp } from "../helpers/app.js";
import type { MuxChannel } from "../../src/services/ssh-agent-mux.js";

// Post-ship audit follow-up (#873, PR-B) — the primary role now materializes
// its own local ssh-agent bridge socket too (src/plugins/ssh-agent.ts),
// routed through pickBridge(app)/app.connectedBridges directly rather than
// the agent role's /internal/ws/ssh-agent hop. This file exercises that
// wiring end to end against a real buildApp() boot, mirroring
// test/routes/internal.test.ts's existing pattern for the agent-role case
// (see its own "returns this agent's own effective config" test).
//
// Same minimal MuxChannel double as test/services/ssh-agent-socket.test.ts's
// own FakeChannel — this repo's convention is a fresh copy per mux-adjacent
// test file (see ssh-agent-relay.test.ts's own header comment) rather than a
// shared export.
class FakeChannel implements MuxChannel {
  readonly id = 1;
  sendWindow = 256 * 1024;
  closed = false;
  sent: Buffer[] = [];
  private dataListeners: Array<(chunk: Buffer) => void> = [];
  private closeListeners: Array<() => void> = [];
  private drainListeners: Array<() => void> = [];

  send(chunk: Buffer): void {
    if (this.closed) throw new Error("send on closed FakeChannel");
    this.sent.push(chunk);
  }
  eof(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) l();
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }
  onEof(): void {}
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  onDrain(listener: () => void): void {
    this.drainListeners.push(listener);
  }
  acknowledgeConsumed(): void {}

  emitData(chunk: Buffer): void {
    for (const l of this.dataListeners) l(chunk);
  }
}

function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil: timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function bridgeSocketPath(app: { pty: { hookSocketPath: string } }): string {
  return path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock");
}

describe("sshAgentPlugin — primary role (#873 PR-B)", () => {
  it("materializes a local ssh-agent bridge socket on the primary role, not just agent", async () => {
    const app = await buildTestApp();
    expect(app.config.MULLION_ROLE).toBe("primary");

    const socketPath = bridgeSocketPath(app);
    // Actually connectable, not just "file exists" — a stale/wrong-mode
    // socket file would pass an existsSync check but fail this.
    const client = net.createConnection(socketPath);
    const connected = await new Promise<boolean>((resolve) => {
      client.once("connect", () => resolve(true));
      client.once("error", () => resolve(false));
    });
    client.destroy();
    expect(connected).toBe(true);
  });

  it("closes an accepted connection immediately when no bridge is connected — must not hang", async () => {
    const app = await buildTestApp();
    expect(app.connectedBridges.size).toBe(0);

    const client = net.createConnection(bridgeSocketPath(app));
    const closed = await new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  it("routes a local connection's bytes to the most recently connected bridge via pickBridge, unfiltered", async () => {
    const app = await buildTestApp();
    const channel = new FakeChannel();
    app.connectedBridges.set("bridge-0", {
      socket: {} as never,
      mux: { openChannel: () => Promise.resolve(channel) } as never,
      connectedAt: Date.now(),
    });

    const client = net.createConnection(bridgeSocketPath(app));
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });

    // Includes a mutating message code (ADD_IDENTITY-shaped payload is
    // irrelevant here — this is deliberately just raw bytes) to demonstrate
    // this path does NOT filter, per the design decision documented in
    // plugins/ssh-agent.ts: a primary-local session is already the primary's
    // own trust domain, and filtering happens one hop earlier for traffic
    // arriving FROM an agent host (ssh-agent-fanout.ts), not here.
    client.write(Buffer.from("raw-unfiltered-request-bytes"));
    await waitUntil(() => channel.sent.length > 0);
    expect(Buffer.concat(channel.sent).toString()).toBe("raw-unfiltered-request-bytes");

    const received: Buffer[] = [];
    client.on("data", (chunk: Buffer) => received.push(chunk));
    channel.emitData(Buffer.from("reply-bytes"));
    await waitUntil(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe("reply-bytes");

    client.destroy();
  });

  it("degrades instead of crashing boot when the bridge socket path is already a live listener", async () => {
    // Precompute the path the same way ptyPlugin/sshAgentPlugin do — this
    // file's SESSIONS_DIR is fixed per test file (test/setup.ts), so it's
    // known before any app in this test exists.
    const sessionsDir = process.env.SESSIONS_DIR!;
    const socketPath = path.join(sessionsDir, "ssh-agent.sock");

    const foreignListener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      foreignListener.once("error", reject);
      foreignListener.listen(socketPath, () => resolve());
    });

    try {
      // Must not throw — the whole point of the #873 PR-B fix. Before it,
      // this reached reclaimSocketPath's SocketAlreadyListeningError
      // unguarded and crashed the entire app boot.
      const app = await buildTestApp();
      // The preflight in ptyPlugin should have suppressed the bridge tier
      // before PtyManager was ever constructed, given a live foreign
      // listener already occupies this exact path.
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await new Promise<void>((resolve) => foreignListener.close(() => resolve()));
    }
  });
});
