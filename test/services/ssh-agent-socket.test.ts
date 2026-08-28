import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  materializeSshAgentSocket,
  materializesBridgeSocket,
  resolveSshAuthSock,
  sshAgentSocketPath,
} from "../../src/services/ssh-agent-socket.js";
import type { MuxChannel } from "../../src/services/ssh-agent-mux.js";

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `ssh-agent-socket-test-${process.pid}-${name}.sock`);
}

/** Minimal MuxChannel double — just enough of the surface
 * pipeNetSocketToChannel actually calls, plus an `emitData` test hook to
 * simulate the "remote" side delivering bytes back. */
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

describe("ssh-agent-socket", () => {
  const handles: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (handles.length > 0) await handles.pop()!.close();
  });

  it("wires an accepted connection to the channel returned by openChannel, both directions", async () => {
    const socketPath = tmpSocketPath("basic");
    const channel = new FakeChannel();
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => Promise.resolve(channel),
    });
    handles.push(handle);

    const client = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("error", reject);
    });

    client.write(Buffer.from("request-bytes"));
    await waitUntil(() => channel.sent.length > 0);
    expect(Buffer.concat(channel.sent).toString()).toBe("request-bytes");

    const received: Buffer[] = [];
    client.on("data", (chunk: Buffer) => received.push(chunk));
    channel.emitData(Buffer.from("reply-bytes"));
    await waitUntil(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe("reply-bytes");

    client.destroy();
  });

  it("closes the accepted connection immediately when no bridge is reachable (openChannel resolves null) — must not hang", async () => {
    const socketPath = tmpSocketPath("no-bridge");
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => Promise.resolve(null),
    });
    handles.push(handle);

    const client = net.createConnection(socketPath);
    const closed = await new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
      client.once("connect", () => {
        // no-op: waiting for close, not connect
      });
    });
    expect(closed).toBe(true);
  });

  it("closes the accepted connection when openChannel rejects", async () => {
    const socketPath = tmpSocketPath("reject");
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => Promise.reject(new Error("no bridge connected")),
    });
    handles.push(handle);

    const client = net.createConnection(socketPath);
    const closed = await new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
    });
    expect(closed).toBe(true);
  });

  it("closes the freshly-opened channel too when the SSH client already disconnected while openChannel was pending", async () => {
    const socketPath = tmpSocketPath("client-gone");
    const channel = new FakeChannel();
    let resolveOpen: (ch: MuxChannel) => void;
    const openPromise = new Promise<MuxChannel>((resolve) => {
      resolveOpen = resolve;
    });
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => openPromise,
    });
    handles.push(handle);

    const client = net.createConnection(socketPath);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.destroy();
    await waitUntil(() => client.destroyed);

    resolveOpen!(channel);
    await waitUntil(() => channel.closed);
    expect(channel.closed).toBe(true);
  });

  it("close() tears down the listener — a further connection attempt fails", async () => {
    const socketPath = tmpSocketPath("teardown");
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => Promise.resolve(new FakeChannel()),
    });
    await handle.close();

    const client = net.createConnection(socketPath);
    const errored = await new Promise<boolean>((resolve) => {
      client.once("error", () => resolve(true));
      client.once("connect", () => resolve(false));
    });
    expect(errored).toBe(true);
  });
});

describe("sshAgentSocketPath", () => {
  it("is deterministic given the same sessionsDir — the one name every caller must agree on", () => {
    expect(sshAgentSocketPath("/var/lib/mullion/sessions")).toBe(
      "/var/lib/mullion/sessions/ssh-agent.sock",
    );
  });
});

describe("materializesBridgeSocket", () => {
  it("is true for the agent role — the only role sshAgentPlugin registers for", () => {
    expect(materializesBridgeSocket("agent")).toBe(true);
  });

  it("is false for the primary role", () => {
    expect(materializesBridgeSocket("primary")).toBe(false);
  });
});

describe("resolveSshAuthSock", () => {
  const sessionsDir = "/var/lib/mullion/sessions";
  const bridgePath = sshAgentSocketPath(sessionsDir);

  it("prefers the configured static path over everything else", () => {
    expect(
      resolveSshAuthSock({
        configured: "/run/ssh-r-tunnel.sock",
        ambient: "/run/some-ambient.sock",
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toBe("/run/ssh-r-tunnel.sock");
  });

  it("prefers configured even when this process would otherwise materialize a bridge socket — an existing ssh -R deployment must not regress on upgrade", () => {
    expect(
      resolveSshAuthSock({
        configured: "/run/ssh-r-tunnel.sock",
        ambient: undefined,
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toBe("/run/ssh-r-tunnel.sock");
  });

  it("returns empty (don't touch SSH_AUTH_SOCK) when unconfigured but an ambient value already exists, even with a bridge socket available — a systemd/PAM/keyring-supplied agent must not be silently shadowed", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: "/run/user/1000/keyring/ssh",
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toBe("");
  });

  it("falls back to the bridge-materialized socket only when neither configured nor ambient is set", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: undefined,
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toBe(bridgePath);
  });

  it("does not fall back to a bridge path when this process doesn't materialize one (e.g. primary, pre-PR5e)", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: undefined,
        materializesBridgeSocket: false,
        sessionsDir,
      }),
    ).toBe("");
  });
});
