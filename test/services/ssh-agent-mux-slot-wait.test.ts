import { describe, it, expect } from "vitest";
import {
  createMuxConnection,
  MuxBusyError,
  MuxPeerRefusedError,
} from "../../src/services/ssh-agent-mux.js";
import {
  HostBusyError,
  HostUnreachableError,
  isHostBusyError,
  isHostTransientError,
} from "../../src/services/remote-host-errors.js";
import {
  AGENT_CHANNEL_MAX_CHANNELS,
  AGENT_CHANNEL_MAX_STREAM_CHANNELS,
  AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS,
} from "../../src/shared/agent-channel.js";

class FakeSocket {
  readyState = 1;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  peer: FakeSocket | null = null;
  sent: Buffer[] = [];
  terminated = false;
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
    this.sent.push(data);
    this.peer?.receive(data);
  }

  receive(data: Buffer | Buffer[], isBinary = true): void {
    this.emit("message", data, isBinary);
  }

  close(code = 1000, reason: Buffer = Buffer.alloc(0)): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close", code, reason);
    this.peer?.peerClosed(code, reason);
  }

  peerClosed(code = 1000, reason: Buffer = Buffer.alloc(0)): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit("close", code, reason);
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = this.CLOSED;
  }
}

function link(a: FakeSocket, b: FakeSocket): void {
  a.peer = b;
  b.peer = a;
}

describe("ssh-agent-mux slot waiting", () => {
  it("rejects with MuxBusyError when slot wait times out", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    await connA.openChannel();
    await expect(connA.openChannel({ waitTimeoutMs: 20 })).rejects.toThrow(MuxBusyError);
  });

  it("resolves when a channel is closed before waitTimeoutMs expires", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    const ch1 = await connA.openChannel();
    const pending = connA.openChannel({ waitTimeoutMs: 200 });

    setTimeout(() => ch1.close(), 20);
    const ch2 = await pending;
    expect(ch2).toBeDefined();
    expect(ch2.closed).toBe(false);
  });

  it("aborts when signal is triggered while waiting for a slot", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    await connA.openChannel();
    const ac = new AbortController();
    const pending = connA.openChannel({ waitTimeoutMs: 500, signal: ac.signal });

    setTimeout(() => ac.abort(new Error("cancelled")), 20);
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("rejects immediately if signal is already aborted", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    await connA.openChannel();
    const ac = new AbortController();
    ac.abort(new Error("already aborted"));
    await expect(connA.openChannel({ waitTimeoutMs: 500, signal: ac.signal })).rejects.toThrow(
      "already aborted",
    );
  });

  it("rejects pending slot waiters when connection closes", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    await connA.openChannel();
    const pending = connA.openChannel({ waitTimeoutMs: 500 });
    setTimeout(() => connA.close(), 20);
    await expect(pending).rejects.toThrow("connection closed");
  });

  it("proceed() cleans up the abort listener on signal", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 1, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 1, channelIdParity: "even" });

    const ch1 = await connA.openChannel();
    const ac = new AbortController();
    const pending = connA.openChannel({ waitTimeoutMs: 500, signal: ac.signal });

    ch1.close();
    const ch2 = await pending;
    expect(ch2).toBeDefined();

    // Aborting after proceed should not trigger any stale handler or error
    expect(() => ac.abort(new Error("late abort"))).not.toThrow();
  });

  it("constructs HostBusyError with expected fields", () => {
    const errWithCause = new HostBusyError("host-1", new Error("slot cap"));
    expect(errWithCause.cause).toBeInstanceOf(Error);
    expect(errWithCause.message).toContain("Host host-1 is busy: slot cap");
    expect(errWithCause.name).toBe("HostBusyError");

    const errNoCause = new HostBusyError("host-2");
    expect(isHostBusyError(errNoCause)).toBe(true);
    expect(isHostBusyError({ retryable: true })).toBe(false);
    expect(isHostBusyError({ name: "HostBusyError" })).toBe(false);
    expect(isHostTransientError(new HostUnreachableError("h", new Error("x")))).toBe(true);
    expect(isHostTransientError(errNoCause)).toBe(true);
    expect(isHostTransientError(new Error("x"))).toBe(false);
    expect(errNoCause.message).toContain("outbound channel concurrency cap reached");
  });

  it("caps stream opens below maxChannels so requests keep slots", async () => {
    expect(AGENT_CHANNEL_MAX_STREAM_CHANNELS + AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS).toBe(
      AGENT_CHANNEL_MAX_CHANNELS,
    );
    expect(AGENT_CHANNEL_MAX_STREAM_CHANNELS).toBeLessThanOrEqual(AGENT_CHANNEL_MAX_CHANNELS / 2);
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, {
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
      maxStreamChannels: AGENT_CHANNEL_MAX_STREAM_CHANNELS,
      channelIdParity: "odd",
    });
    createMuxConnection(b as never, {
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
      channelIdParity: "even",
    });
    for (let i = 0; i < AGENT_CHANNEL_MAX_STREAM_CHANNELS; i++) {
      await connA.openChannel({ stream: true });
    }
    // The next stream is refused at once (a stream does not free its slot) ...
    await expect(connA.openChannel({ stream: true, waitTimeoutMs: 5000 })).rejects.toThrow(
      MuxBusyError,
    );
    // ... while every reserved slot is still available to requests.
    for (let i = 0; i < AGENT_CHANNEL_REQUEST_RESERVED_CHANNELS; i++) {
      await connA.openChannel();
    }
    await expect(connA.openChannel()).rejects.toThrow(MuxBusyError);
  });

  it("in-flight requests do not block a stream open, and streams are released on close", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, {
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
      maxStreamChannels: AGENT_CHANNEL_MAX_STREAM_CHANNELS,
      channelIdParity: "odd",
    });
    createMuxConnection(b as never, {
      maxChannels: AGENT_CHANNEL_MAX_CHANNELS,
      channelIdParity: "even",
    });
    // A burst of requests as large as the stream cap...
    for (let i = 0; i < AGENT_CHANNEL_MAX_STREAM_CHANNELS; i++) await connA.openChannel();
    // ... still leaves every stream slot: only streams count against the cap.
    const streams = [];
    for (let i = 0; i < AGENT_CHANNEL_MAX_STREAM_CHANNELS; i++) {
      streams.push(await connA.openChannel({ stream: true }));
    }
    await expect(connA.openChannel({ stream: true })).rejects.toThrow(MuxBusyError);
    // Closing a stream frees a stream slot.
    streams[0]!.close();
    await expect(connA.openChannel({ stream: true })).resolves.toBeDefined();
  });

  it("reports a peer OpenFail as busy", async () => {
    const a = new FakeSocket();
    const b = new FakeSocket();
    link(a, b);
    const connA = createMuxConnection(a as never, { maxChannels: 8, channelIdParity: "odd" });
    createMuxConnection(b as never, { maxChannels: 0, channelIdParity: "even" });
    const err = await connA.openChannel().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuxPeerRefusedError);
    expect(err).toBeInstanceOf(MuxBusyError);
  });
});
