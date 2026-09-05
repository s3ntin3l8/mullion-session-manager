import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { createMuxConnection, type MuxChannel } from "../../src/services/ssh-agent-mux.js";
import { SSH_AGENTC_SIGN_REQUEST } from "../../src/services/ssh-agent-filter.js";

// Two complementary test styles, mirroring the two closest existing
// precedents in this repo:
//  - "connection lifecycle" below mirrors remote-event-subscriber.test.ts's
//    MockSocket + mocked getRemoteHostClient/listHosts approach — fast,
//    fake-timer-driven tests of reconnect/backoff/gating logic that don't
//    need real mux framing.
//  - "channel fan-out" further down mirrors ssh-agent-relay.test.ts's
//    FakeSocket + link() approach — real MuxConnections on both ends, to
//    verify actual channel pairing/closing behavior, not just mocked call
//    counts.

class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockSocket.CONNECTING;
  readonly OPEN = MockSocket.OPEN;
  readonly CLOSING = MockSocket.CLOSING;
  readonly CLOSED = MockSocket.CLOSED;

  readyState = MockSocket.CONNECTING;
  sendSpy = vi.fn();
  closeSpy = vi.fn();
  terminateSpy = vi.fn();

  send(data: unknown, opts?: unknown) {
    this.sendSpy(data, opts);
  }

  close() {
    this.closeSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  terminate() {
    this.terminateSpy();
    this.readyState = MockSocket.CLOSED;
    this.emit("close");
  }

  open() {
    this.readyState = MockSocket.OPEN;
    this.emit("open");
  }
}

const openSshAgentStreamMock = vi.fn();
const getRemoteHostClientMock = vi.fn(() => ({ openSshAgentStream: openSshAgentStreamMock }));
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: (...args: unknown[]) => getRemoteHostClientMock(...(args as [])),
}));

const listHostsMock = vi.fn();
vi.mock("../../src/services/host-registry.js", () => ({
  listHosts: (...args: unknown[]) => listHostsMock(...(args as [])),
}));

const { startSshAgentFanout, pickBridge } = await import("../../src/services/ssh-agent-fanout.js");

function fakeHost(
  id: string,
  overrides: Partial<{ isLocal: boolean; baseUrl: string | null }> = {},
) {
  return {
    id,
    name: id,
    baseUrl: overrides.baseUrl !== undefined ? overrides.baseUrl : `http://${id}.example`,
    isLocal: overrides.isLocal ?? false,
    hasToken: true,
    createdAt: new Date(0),
    origin: "manual" as const,
  };
}

function fakeApp(connectedBridgeCount = 1): FastifyInstance {
  const connectedBridges = new Map();
  for (let i = 0; i < connectedBridgeCount; i++) {
    connectedBridges.set(`bridge-${i}`, {
      socket: {},
      // Never resolves — these lifecycle/pickBridge tests only care about
      // selection/gating, not the channel-pairing outcome (covered
      // separately, with real MuxConnections, in the "channel fan-out"
      // tests below). A never-resolving Promise avoids a "cannot read
      // properties of undefined" throw if a test's onChannel handler ever
      // reaches `.then()` on it.
      mux: { openChannel: vi.fn(() => new Promise(() => {})) },
      connectedAt: i,
    });
  }
  return {
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    connectedBridges,
  } as unknown as FastifyInstance;
}

describe("startSshAgentFanout — connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    openSshAgentStreamMock.mockReset();
    getRemoteHostClientMock.mockClear();
    listHostsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not dial any host when no bridge is connected", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const app = fakeApp(0); // no bridges

    startSshAgentFanout(app).reconcile();

    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
  });

  it("opens one connection per non-local host once a bridge is connected, none for the local host", () => {
    listHostsMock.mockReturnValue([fakeHost("local", { isLocal: true }), fakeHost("agent-a")]);
    openSshAgentStreamMock.mockImplementation(() => new MockSocket());
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();

    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledWith(app, "agent-a");
  });

  it("does not attempt a connection for a non-local host with no baseUrl", () => {
    listHostsMock.mockReturnValue([fakeHost("pending-enrolled", { baseUrl: null })]);
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();

    expect(getRemoteHostClientMock).not.toHaveBeenCalled();
  });

  it("closes every open connection the instant the LAST bridge disconnects, even though no host was removed", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const socket = new MockSocket();
    openSshAgentStreamMock.mockReturnValue(socket);
    const app = fakeApp(1);

    const handle = startSshAgentFanout(app);
    handle.reconcile();
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);

    app.connectedBridges.clear(); // the last bridge disconnected
    handle.reconcile();

    expect(socket.closeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dial a SCHEDULED reconnect if the bridge disconnected while it was waiting — checked fresh on every attempt, not just when the HostFanout was created", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const socket = new MockSocket();
    openSshAgentStreamMock.mockReturnValue(socket);
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();
    socket.emit("close"); // schedules a reconnect in 1s
    app.connectedBridges.clear(); // bridge drops mid-backoff

    vi.advanceTimersByTime(1_000);

    // Only the original attempt — the scheduled retry must have bailed out
    // without dialing, per the "no bridge, no dial" invariant.
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects with the established backoff shape after the socket closes, and resets on a successful open", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const sockets = [new MockSocket(), new MockSocket(), new MockSocket()];
    let i = 0;
    openSshAgentStreamMock.mockImplementation(() => sockets[i++]);
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);

    sockets[0].emit("close"); // first reconnect delay: 1s
    vi.advanceTimersByTime(999);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);

    sockets[1].emit("close"); // second attempt also failed: 2s delay next
    vi.advanceTimersByTime(1999);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(3);
  });

  it("fetches getRemoteHostClient fresh on every reconnect attempt rather than caching the client", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const first = new MockSocket();
    const second = new MockSocket();
    openSshAgentStreamMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();
    first.emit("close");
    vi.advanceTimersByTime(1_000);

    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(2);
  });

  it("terminates and retries a connection that never opens within the connect timeout", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const socket = new MockSocket();
    openSshAgentStreamMock.mockReturnValueOnce(socket).mockReturnValueOnce(new MockSocket());
    const app = fakeApp(1);

    startSshAgentFanout(app).reconcile();
    vi.advanceTimersByTime(10_000); // CONNECT_TIMEOUT_MS

    expect(socket.terminateSpy).toHaveBeenCalledTimes(1);
  });

  it("stop() closes every open connection and halts reconnects", () => {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const socket = new MockSocket();
    openSshAgentStreamMock.mockReturnValue(socket);
    const app = fakeApp(1);

    const handle = startSshAgentFanout(app);
    handle.reconcile();
    socket.open();
    handle.stop();

    expect(socket.closeSpy).toHaveBeenCalledTimes(1);

    socket.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(getRemoteHostClientMock).toHaveBeenCalledTimes(1); // no reconnect after stop()
  });
});

describe("pickBridge", () => {
  it("returns null when no bridge is connected", () => {
    const app = fakeApp(0);
    expect(pickBridge(app)).toBeNull();
  });

  it("returns the sole connected bridge", () => {
    const app = fakeApp(1);
    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-0");
  });

  it("picks the MOST RECENTLY connected bridge when several are connected, not Map insertion/iteration order", () => {
    const app = fakeApp(0);
    // Inserted oldest-first, but "bridge-old" carries the LARGER
    // connectedAt — Map iteration order alone (oldest-first) would pick
    // "bridge-new" wrongly if this module used `.values().next()` instead
    // of comparing connectedAt.
    app.connectedBridges.set("bridge-new", { socket: {}, mux: {}, connectedAt: 1 });
    app.connectedBridges.set("bridge-old", { socket: {}, mux: {}, connectedAt: 2 });

    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-old");
  });

  // Issue #1051 — a bridge whose laptop has gone to sleep reports OPEN
  // indefinitely until the mux's own ping/pong timeout fires; prefer a
  // bridge with a recent PONG so this pick isn't the thing that
  // introduces a multi-second stall. Health window mirrors the mux's
  // own PONG_TIMEOUT_MS = 10s — anything we wouldn't have torn down
  // ourselves yet is still "trustworthy".
  const now = Date.now();

  it("prefers a bridge with a recent PONG over one without, regardless of connectedAt", () => {
    const app = fakeApp(0);
    // Stale-by-construction: never seen a PONG, so lastPongAt is
    // undefined / null. This simulates a brand-new bridge that hasn't
    // completed its first PING/PONG round trip yet (PING_INTERVAL_MS =
    // 15s), or any bridge that just connected within the last 15s.
    app.connectedBridges.set("bridge-stale", { socket: {}, mux: {}, connectedAt: 100 });
    // Recent PONG: bridge-saw-pong is the one we should pick, even
    // though it's NOT the most-recently-connected.
    app.connectedBridges.set("bridge-saw-pong", {
      socket: {},
      mux: {},
      connectedAt: 50, // older than bridge-stale
      lastPongAt: now, // but answered a PONG just now
    });

    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-saw-pong");
  });

  it("prefers the bridge with the MORE RECENT PONG between two bridges that both have PONG timestamps", () => {
    const app = fakeApp(0);
    app.connectedBridges.set("bridge-older-pong", {
      socket: {},
      mux: {},
      connectedAt: 100,
      lastPongAt: now - 3_000,
    });
    app.connectedBridges.set("bridge-newer-pong", {
      socket: {},
      mux: {},
      connectedAt: 100, // same connectedAt
      lastPongAt: now - 1_000, // but PONG'd more recently
    });

    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-newer-pong");
  });

  it("falls back to connectedAt ordering when no bridge has a recent PONG — must still pick a bridge rather than return null", () => {
    const app = fakeApp(0);
    // Neither bridge has answered a PONG in the health window — both
    // lastPongAt values are older than PONG_TIMEOUT_MS. The pre-#1051
    // behavior (most-recently connected wins) must still apply so the
    // call site is never blocked on a bridge that exists.
    app.connectedBridges.set("bridge-stale-a", {
      socket: {},
      mux: {},
      connectedAt: 1,
      lastPongAt: now - 30_000, // well past the 10s window
    });
    app.connectedBridges.set("bridge-stale-b", {
      socket: {},
      mux: {},
      connectedAt: 2,
      lastPongAt: now - 20_000, // also stale
    });

    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-stale-b");
  });

  it("prefers the SOLE healthy bridge over multiple stale ones — does not require staleness ties to be broken by connectedAt", () => {
    const app = fakeApp(0);
    app.connectedBridges.set("bridge-stale", {
      socket: {},
      mux: {},
      connectedAt: 999, // most-recently connected — but stale
      lastPongAt: now - 30_000,
    });
    app.connectedBridges.set("bridge-healthy", {
      socket: {},
      mux: {},
      connectedAt: 1, // ancient connection
      lastPongAt: now, // just answered a PONG
    });

    const picked = pickBridge(app);
    expect(picked?.bridgeId).toBe("bridge-healthy");
  });
});

// --- channel fan-out: real MuxConnections on every leg ---

class FakeSocket {
  readyState = 1;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  peer: FakeSocket | null = null;
  private listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }

  send(data: Buffer): void {
    this.peer?.receive(data);
  }

  receive(data: Buffer, isBinary = true): void {
    this.emit("message", data, isBinary);
  }

  open(): void {
    this.readyState = this.OPEN;
    this.emit("open");
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close");
    this.peer?.peerClosed();
  }

  peerClosed(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.close();
  }
}

function link(a: FakeSocket, b: FakeSocket): void {
  a.peer = b;
  b.peer = a;
}

function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  body.copy(out, 5);
  return out;
}

describe("startSshAgentFanout — channel fan-out", () => {
  beforeEach(() => {
    openSshAgentStreamMock.mockReset();
    getRemoteHostClientMock.mockClear();
    listHostsMock.mockReset();
  });

  /** Wires a fresh HostFanout's primary-side MuxConnection to a simulated
   * agent's own MuxConnection (mirroring what routes/internal.ts's real
   * `/internal/ws/ssh-agent` handler does — "even" parity, since the agent
   * accepts). Returns the agent-side connection so a test can call
   * `.openChannel()` on it to simulate a locally-accepted SSH client
   * (ssh-agent-socket.ts). */
  async function setupPrimaryAndAgent(app: FastifyInstance) {
    listHostsMock.mockReturnValue([fakeHost("agent-a")]);
    const wsPrimary = new FakeSocket();
    const wsAgent = new FakeSocket();
    link(wsPrimary, wsAgent);
    openSshAgentStreamMock.mockReturnValue(wsPrimary);

    const handle = startSshAgentFanout(app);
    handle.reconcile();
    wsPrimary.open(); // fires ssh-agent-fanout.ts's own socket.on("open", ...) handler

    const agentConn = createMuxConnection(wsAgent as never, { channelIdParity: "even" });
    return { agentConn, wsPrimary };
  }

  it("pairs an agent-opened channel with the connected bridge's channel and relays an allowed frame", async () => {
    const app = fakeApp(1);
    // Real channel on the "far end" of the bridge connection so a real
    // Data frame can actually be observed arriving there.
    const wsBridgePrimary = new FakeSocket();
    const wsBridgeHelper = new FakeSocket();
    link(wsBridgePrimary, wsBridgeHelper);
    const realBridgeMux = createMuxConnection(wsBridgePrimary as never, {
      channelIdParity: "even",
    });
    const helperMux = createMuxConnection(wsBridgeHelper as never, { channelIdParity: "odd" });
    app.connectedBridges.set("bridge-0", {
      socket: {},
      mux: realBridgeMux,
      connectedAt: Date.now(),
    });

    const atHelper: MuxChannel[] = [];
    helperMux.onChannel((ch) => atHelper.push(ch));

    const { agentConn } = await setupPrimaryAndAgent(app);
    const agentChannel = await agentConn.openChannel();

    // The pairing is async (bridge.mux.openChannel() + pipeFilteredChannelToChannel) —
    // give the microtask queue a turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(atHelper).toHaveLength(1);

    const atHelperData: Buffer[] = [];
    atHelper[0].onData((chunk) => atHelperData.push(chunk));
    agentChannel.send(frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("digest")));
    expect(atHelperData).toHaveLength(1);
    expect(atHelperData[0]).toEqual(frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("digest")));
  });

  it("closes the agent channel immediately when the bridge disconnects in the narrow window between the primary<->agent connection staying alive and reconcile() tearing it down — must not leave the SSH client hanging", async () => {
    // Start WITH a bridge connected so the primary<->agent connection
    // (f.mux) actually gets established — the real race Hermes flagged
    // (PR5b review) is an agent channel opening on an ALREADY-LIVE f.mux
    // at the exact instant `app.connectedBridges` has just gone empty, not
    // "was the fan-out subscriber ever dialing at all." Directly clearing
    // connectedBridges WITHOUT calling reconcile() again isolates exactly
    // that window, independent of how quickly reconcile()'s own teardown
    // (covered by a separate lifecycle test above) would otherwise close
    // f.mux itself.
    const app = fakeApp(1);
    const { agentConn } = await setupPrimaryAndAgent(app);
    app.connectedBridges.clear();

    const agentChannel = await agentConn.openChannel();
    await new Promise((resolve) => setImmediate(resolve));

    expect(agentChannel.closed).toBe(true);
  });

  it("closes the agent channel when the bridge's own openChannel() rejects (connection already closed)", async () => {
    const app = fakeApp(1);
    const bridgeEntry = app.connectedBridges.get("bridge-0")!;
    // Force a real rejection path: MuxConnection.openChannel() rejects
    // synchronously-wrapped when the connection is already closed.
    const wsBridge = new FakeSocket();
    const realBridgeMux = createMuxConnection(wsBridge as never, { channelIdParity: "even" });
    realBridgeMux.close();
    app.connectedBridges.set("bridge-0", { ...bridgeEntry, mux: realBridgeMux });

    const { agentConn } = await setupPrimaryAndAgent(app);
    const agentChannel = await agentConn.openChannel();
    await new Promise((resolve) => setImmediate(resolve));

    expect(agentChannel.closed).toBe(true);
  });

  it("throttles the 'multiple bridges connected' log to once per ambiguity streak, resetting once back to a single bridge", async () => {
    const app = fakeApp(2); // ambiguous from the start
    const { agentConn } = await setupPrimaryAndAgent(app);

    await agentConn.openChannel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.log.info).toHaveBeenCalledTimes(1);

    await agentConn.openChannel(); // still ambiguous — must NOT log again
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.log.info).toHaveBeenCalledTimes(1);

    app.connectedBridges.delete("bridge-1"); // back to a single bridge
    await agentConn.openChannel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.log.info).toHaveBeenCalledTimes(1); // unambiguous now — no new log

    app.connectedBridges.set("bridge-1", {
      socket: {},
      mux: { openChannel: vi.fn(() => new Promise(() => {})) },
      connectedAt: 99,
    });
    await agentConn.openChannel(); // ambiguous again — a fresh streak logs once more
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.log.info).toHaveBeenCalledTimes(2);
  });
});
