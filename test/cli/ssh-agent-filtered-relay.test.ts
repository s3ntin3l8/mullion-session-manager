import { describe, it, expect } from "vitest";
import {
  pipeFilteredNetSocketToChannel,
  pipeFilteredChannelRequestsToSocket,
} from "../../src/cli/ssh-agent-filtered-relay.mjs";
import {
  SSH_AGENT_FAILURE_FRAME,
  SSH_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_ADD_IDENTITY,
  SSH_AGENTC_LOCK,
  MAX_FRAME_BYTES,
} from "../../src/cli/ssh-agent-filter.mjs";

// Issue #820 (round 4 PR2) — the .mjs twin of test/services/ssh-agent-
// relay.test.ts, adapted for this module's socket<->channel topology
// (ssh-agent-relay.ts's own equivalent is channel<->channel, since it
// relays between two mux connections primary-side; this one relays
// between the laptop's real net.Socket and one mux channel). FakeChannel
// mirrors the minimal MuxChannel-double precedent already established in
// test/services/ssh-agent-socket.test.ts (its own "just enough of the
// surface pipeNetSocketToChannel actually calls" comment applies here
// identically) — unlike that file's own no-op acknowledgeConsumed, this
// one records calls, since the accounting behavior itself is under test.

class FakeChannel {
  sendWindow = 256 * 1024;
  closed = false;
  sent: Buffer[] = [];
  acknowledged: number[] = [];
  #dataListeners: Array<(chunk: Buffer) => void> = [];
  #closeListeners: Array<() => void> = [];

  send(chunk: Buffer): void {
    if (this.closed) throw new Error("send on closed FakeChannel");
    if (chunk.length > this.sendWindow) throw new Error("send exceeds sendWindow");
    this.sent.push(chunk);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.#closeListeners) l();
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.#dataListeners.push(listener);
  }
  onEof(): void {}
  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }
  onDrain(): void {}
  acknowledgeConsumed(byteCount: number): void {
    this.acknowledged.push(byteCount);
  }

  emitData(chunk: Buffer): void {
    for (const l of this.#dataListeners) l(chunk);
  }
}

/** Minimal net.Socket double — just enough surface
 * pipeFilteredChannelRequestsToSocket/pipeSocketRepliesToChannel actually
 * call. `write` records synchronously and invokes its callback
 * synchronously (real net.Socket.write's callback fires once the OS has
 * flushed the data; treating it as immediate is a deliberate, standard
 * simplification for a fake used to test accounting logic, not real I/O
 * timing — nothing under test here depends on the callback being async). */
class FakeSocket {
  destroyed = false;
  written: Buffer[] = [];
  #listeners = new Map<string, Array<(...args: never[]) => void>>();

  write(chunk: Buffer, cb?: () => void): boolean {
    this.written.push(chunk);
    cb?.();
    return true;
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  on(event: string, listener: (...args: never[]) => void): void {
    const arr = this.#listeners.get(event) ?? [];
    arr.push(listener);
    this.#listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
}

/** Same length-prefixed frame builder used throughout the ssh-agent-filter
 * test suites. */
function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  body.copy(out, 5);
  return out;
}

describe("ssh-agent-filtered-relay.mjs", () => {
  describe("pipeFilteredChannelRequestsToSocket (request direction only)", () => {
    it("forwards an allowed request to the real agent socket, byte for byte", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socket as never, channel as never);

      const signRequest = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("digest"));
      channel.emitData(signRequest);

      expect(socket.written).toEqual([signRequest]);
      expect(channel.acknowledged).toEqual([signRequest.length]);
    });

    it("blocks a mutating request before it ever reaches the real agent socket, replying on the channel directly instead", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socket as never, channel as never);

      const addIdentity = frame(SSH_AGENTC_ADD_IDENTITY, Buffer.from("private-key-material"));
      channel.emitData(addIdentity);

      expect(socket.written).toHaveLength(0);
      expect(channel.sent).toEqual([SSH_AGENT_FAILURE_FRAME]);
      // Acknowledges the ORIGINAL request's length, not the 5-byte reply's
      // — the channel's flow-control credit is about bytes it received,
      // not what got forwarded.
      expect(channel.acknowledged).toEqual([addIdentity.length]);
    });

    it("forwards only the allowed frames from a mixed chunk, in order, and still acks the whole chunk's original length", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socket as never, channel as never);

      const allowed1 = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      const blocked = frame(SSH_AGENTC_LOCK);
      const allowed2 = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("x"));
      const combined = Buffer.concat([allowed1, blocked, allowed2]);
      channel.emitData(combined);

      expect(socket.written).toEqual([Buffer.concat([allowed1, allowed2])]);
      expect(channel.sent).toEqual([SSH_AGENT_FAILURE_FRAME]);
      expect(channel.acknowledged).toEqual([combined.length]);
    });

    it("closes both the channel and the socket on an oversized/hostile length prefix, forwarding nothing further", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socket as never, channel as never);

      const hostile = Buffer.alloc(4);
      hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      channel.emitData(hostile);

      expect(channel.closed).toBe(true);
      expect(socket.destroyed).toBe(true);
      expect(socket.written).toHaveLength(0);
    });

    it("keeps a separate filter per call — a partial frame queued on one relay never leaks into another's classification", () => {
      const channelA = new FakeChannel();
      const socketA = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socketA as never, channelA as never);

      const channelB = new FakeChannel();
      const socketB = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socketB as never, channelB as never);

      const full = frame(SSH_AGENTC_REQUEST_IDENTITIES);
      channelA.emitData(full.subarray(0, 3)); // A: incomplete length prefix, parked mid-frame
      channelB.emitData(full); // B: one complete, unrelated frame

      expect(socketA.written).toHaveLength(0);
      expect(socketB.written).toEqual([full]);

      channelA.emitData(full.subarray(3));
      expect(socketA.written).toEqual([full]);
    });

    it("does not throw when a rejection reply would exceed the channel's own send window — drops it rather than crashing the relay", () => {
      const channel = new FakeChannel();
      channel.sendWindow = 2; // smaller than SSH_AGENT_FAILURE_FRAME's 5 bytes
      const socket = new FakeSocket();
      pipeFilteredChannelRequestsToSocket(socket as never, channel as never);

      expect(() => channel.emitData(frame(SSH_AGENTC_ADD_IDENTITY))).not.toThrow();
      expect(channel.sent).toHaveLength(0);
    });
  });

  describe("pipeFilteredNetSocketToChannel (both directions composed)", () => {
    it("relays an allowed request through and the real agent's reply back, unfiltered in that direction", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredNetSocketToChannel(socket as never, channel as never);

      const signRequest = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("digest"));
      channel.emitData(signRequest);
      expect(socket.written).toEqual([signRequest]);

      const reply = Buffer.from("signature-bytes");
      socket.emit("data", reply);
      expect(channel.sent).toEqual([reply]);
    });

    it("a reply from the real agent is never run through the filter, even if it happens to look like a blocked request type", () => {
      const channel = new FakeChannel();
      const socket = new FakeSocket();
      pipeFilteredNetSocketToChannel(socket as never, channel as never);

      // A reply payload that would classify as SSH_AGENTC_ADD_IDENTITY (17)
      // if the reply direction were mistakenly run through the same
      // request-only classifier — must pass through completely unexamined.
      const replyLookingLikeAMutatingRequest = frame(17, Buffer.from("not actually a request"));
      socket.emit("data", replyLookingLikeAMutatingRequest);

      expect(channel.sent).toEqual([replyLookingLikeAMutatingRequest]);
    });
  });
});
