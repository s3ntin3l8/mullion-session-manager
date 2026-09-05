import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  describeBridgeShadowing,
  materializeSshAgentSocket,
  materializesBridgeSocket,
  resolveSshAuthSock,
  sshAgentSocketPath,
} from "../../src/services/ssh-agent-socket.js";
import { DEFAULT_MAX_CHANNELS, type MuxChannel } from "../../src/services/ssh-agent-mux.js";

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

  // Issue #1051 — bound the openSockets set so a sustained burst of SSH
  // client connections (each awaiting openChannel() resolving against a
  // bridge that may not be reachable) can't grow without bound. Cap
  // mirrors DEFAULT_MAX_CHANNELS: the same well-above-any-real-fan-out
  // ceiling the per-connection MuxConnection itself enforces.
  it("rejects a new accepted connection when openSockets is at DEFAULT_MAX_CHANNELS — closes the new socket immediately rather than hanging it", async () => {
    const socketPath = tmpSocketPath("cap");
    // openChannel never resolves — every accepted connection stays in
    // openSockets (added on accept, removed only on socket close), so the
    // cap will be reached after DEFAULT_MAX_CHANNELS concurrent accepts.
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => new Promise<MuxChannel>(() => {}),
    });
    handles.push(handle);

    const clients: net.Socket[] = [];
    let overflow: net.Socket | null = null;
    try {
      // Fill to capacity: each accepted connection enters openSockets and
      // sits there (openChannel never resolves).
      for (let i = 0; i < DEFAULT_MAX_CHANNELS; i++) {
        const c = net.createConnection(socketPath);
        await new Promise<void>((resolve, reject) => {
          c.once("connect", () => resolve());
          c.once("error", reject);
        });
        clients.push(c);
      }
      // The cap-rejection (next) accepted connection must close
      // immediately, NOT hang — same fail-fast posture as the
      // "no bridge reachable" case above (ssh hangs on SSH_AUTH_SOCK
      // until the agent answers or the connection drops).
      overflow = net.createConnection(socketPath);
      const closed = await new Promise<boolean>((resolve, reject) => {
        overflow!.once("close", () => resolve(true));
        overflow!.once("error", reject);
        setTimeout(
          () => reject(new Error("overflow connection neither closed nor errored within 5s")),
          5_000,
        );
      });
      expect(closed).toBe(true);
    } finally {
      for (const c of clients) c.destroy();
      if (overflow && !overflow.destroyed) overflow.destroy();
    }
  });

  it("accepts new connections again after a previously-capped one closes — the set drains as sockets close", async () => {
    const socketPath = tmpSocketPath("cap-drain");
    const handle = await materializeSshAgentSocket({
      socketPath,
      openChannel: () => new Promise<MuxChannel>(() => {}),
    });
    handles.push(handle);

    const first = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      first.once("connect", () => resolve());
      first.once("error", reject);
    });
    first.destroy();
    await waitUntil(() => first.destroyed);

    // After `first` closes, openSockets has drained back to zero — the
    // next connection must be accepted, not rejected as overflow. We
    // can't easily observe "accepted" directly without openChannel
    // resolving; instead we rely on the immediate-close contract from the
    // overflow case above and assert the OPPOSITE: this one stays open
    // for a moment (because openChannel is pending forever).
    const second = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      second.once("connect", () => resolve());
      second.once("error", reject);
    });
    const stillOpenAfterDelay = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(!second.destroyed), 50);
    });
    expect(stillOpenAfterDelay).toBe(true);
    second.destroy();
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
  it("is true for the agent role", () => {
    expect(materializesBridgeSocket("agent")).toBe(true);
  });

  it("is true for the primary role too (#873 PR-B — sshAgentPlugin now registers for both roles)", () => {
    expect(materializesBridgeSocket("primary")).toBe(true);
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
    ).toEqual({ path: "/run/ssh-r-tunnel.sock", source: "configured" });
  });

  it("prefers configured even when this process would otherwise materialize a bridge socket — an existing ssh -R deployment must not regress on upgrade", () => {
    expect(
      resolveSshAuthSock({
        configured: "/run/ssh-r-tunnel.sock",
        ambient: undefined,
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toEqual({ path: "/run/ssh-r-tunnel.sock", source: "configured" });
  });

  it("returns empty (don't touch SSH_AUTH_SOCK) when unconfigured but an ambient value already exists, even with a bridge socket available — a systemd/PAM/keyring-supplied agent must not be silently shadowed", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: "/run/user/1000/keyring/ssh",
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toEqual({ path: "", source: "ambient" });
  });

  it("falls back to the bridge-materialized socket only when neither configured nor ambient is set", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: undefined,
        materializesBridgeSocket: true,
        sessionsDir,
      }),
    ).toEqual({ path: bridgePath, source: "bridge" });
  });

  it("does not fall back to a bridge path when materializesBridgeSocket is false (e.g. the preflight probe in pty.ts suppressed it — #873 PR-B)", () => {
    expect(
      resolveSshAuthSock({
        configured: "",
        ambient: undefined,
        materializesBridgeSocket: false,
        sessionsDir,
      }),
    ).toEqual({ path: "", source: "none" });
  });
});

describe("describeBridgeShadowing", () => {
  const sessionsDir = "/var/lib/mullion/sessions";
  const bridgePath = sshAgentSocketPath(sessionsDir);

  it("flags shadowing when ambient wins over a materialized bridge socket — the case a bridge pairing would otherwise silently do nothing", () => {
    const resolved = resolveSshAuthSock({
      configured: "",
      ambient: "/run/user/1000/keyring/ssh",
      materializesBridgeSocket: true,
      sessionsDir,
    });
    expect(
      describeBridgeShadowing(resolved, { materializesBridgeSocket: true, sessionsDir }),
    ).toEqual({ bridgePath, shadowedBy: "ambient" });
  });

  it("flags shadowing when configured wins over a materialized bridge socket", () => {
    const resolved = resolveSshAuthSock({
      configured: "/run/ssh-r-tunnel.sock",
      ambient: undefined,
      materializesBridgeSocket: true,
      sessionsDir,
    });
    expect(
      describeBridgeShadowing(resolved, { materializesBridgeSocket: true, sessionsDir }),
    ).toEqual({ bridgePath, shadowedBy: "configured" });
  });

  it("does not flag shadowing when the bridge tier actually won", () => {
    const resolved = resolveSshAuthSock({
      configured: "",
      ambient: undefined,
      materializesBridgeSocket: true,
      sessionsDir,
    });
    expect(
      describeBridgeShadowing(resolved, { materializesBridgeSocket: true, sessionsDir }),
    ).toBeNull();
  });

  it("does not flag shadowing when this process doesn't materialize a bridge socket at all (e.g. primary, pre-PR-B) — nothing to shadow", () => {
    const resolved = resolveSshAuthSock({
      configured: "",
      ambient: "/run/user/1000/keyring/ssh",
      materializesBridgeSocket: false,
      sessionsDir,
    });
    expect(
      describeBridgeShadowing(resolved, { materializesBridgeSocket: false, sessionsDir }),
    ).toBeNull();
  });
});
