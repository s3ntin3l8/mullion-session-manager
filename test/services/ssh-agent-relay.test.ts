import { describe, it, expect } from "vitest";
import { pipeFilteredChannelToChannel } from "../../src/services/ssh-agent-relay.js";
import {
  createMuxConnection,
  CHANNEL_WINDOW_BYTES,
  type MuxChannel,
} from "../../src/services/ssh-agent-mux.js";
import {
  SSH_AGENT_FAILURE_FRAME,
  SSH_AGENTC_SIGN_REQUEST,
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_ADD_IDENTITY,
  SSH_AGENTC_LOCK,
} from "../../src/services/ssh-agent-filter.js";

// Minimal `ws`-shaped fake — same shape as ssh-agent-mux.test.ts's own
// FakeSocket (not shared/exported from there; each mux-adjacent test file
// keeps its own copy, matching this repo's existing convention).
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

/** Builds a real length-prefixed agent-protocol frame: 4-byte BE length +
 * type byte + arbitrary body. */
function frame(type: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + 1 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  body.copy(out, 5);
  return out;
}

// chanX <-> chanY are one mux connection (X plays the SSH client dialing
// the materialized local socket; Y is the relay's request-side channel).
// chanP <-> chanQ are a second, independent mux connection (Q plays the
// real agent/helper). pipeFilteredChannelToChannel(chanY, chanP) is the
// module under test.
async function setupFilteredRelay() {
  const wsX = new FakeSocket();
  const wsY = new FakeSocket();
  link(wsX, wsY);
  const connX = createMuxConnection(wsX as never, { channelIdParity: "odd" });
  const connY = createMuxConnection(wsY as never, { channelIdParity: "even" });
  let chanY: MuxChannel | null = null;
  connY.onChannel((ch) => (chanY = ch));
  const chanX = await connX.openChannel();

  const wsP = new FakeSocket();
  const wsQ = new FakeSocket();
  link(wsP, wsQ);
  const connP = createMuxConnection(wsP as never, { channelIdParity: "odd" });
  const connQ = createMuxConnection(wsQ as never, { channelIdParity: "even" });
  let chanQ: MuxChannel | null = null;
  connQ.onChannel((ch) => (chanQ = ch));
  const chanP = await connP.openChannel();

  pipeFilteredChannelToChannel(chanY!, chanP);
  return { chanX, chanY: chanY!, chanP, chanQ: chanQ! };
}

describe("ssh-agent-relay", () => {
  it("forwards an allowed request through to the agent side and relays its reply back unfiltered", async () => {
    const { chanX, chanQ } = await setupFilteredRelay();

    const atQ: Buffer[] = [];
    chanQ.onData((chunk) => atQ.push(chunk));
    const signRequest = frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("digest"));
    chanX.send(signRequest);
    expect(atQ).toEqual([signRequest]);

    const atX: Buffer[] = [];
    chanX.onData((chunk) => atX.push(chunk));
    const reply = Buffer.from("signature-bytes");
    chanQ.send(reply);
    expect(atX).toEqual([reply]);
  });

  it("blocks a mutating request before it ever reaches the agent side, answering the requester directly instead", async () => {
    const { chanX, chanQ } = await setupFilteredRelay();

    const atQ: Buffer[] = [];
    chanQ.onData((chunk) => atQ.push(chunk));
    const atX: Buffer[] = [];
    chanX.onData((chunk) => atX.push(chunk));

    chanX.send(frame(SSH_AGENTC_ADD_IDENTITY, Buffer.from("private-key-material")));
    expect(atQ).toHaveLength(0);
    expect(atX).toEqual([SSH_AGENT_FAILURE_FRAME]);
  });

  it("keeps a separate filter per channel — a partial frame queued on one channel never leaks into another's classification", async () => {
    const relayA = await setupFilteredRelay();
    const relayB = await setupFilteredRelay();
    const atQA: Buffer[] = [];
    relayA.chanQ.onData((chunk) => atQA.push(chunk));
    const atQB: Buffer[] = [];
    relayB.chanQ.onData((chunk) => atQB.push(chunk));

    const full = frame(SSH_AGENTC_REQUEST_IDENTITIES);
    relayA.chanX.send(full.subarray(0, 3)); // A: an incomplete length prefix, parked mid-frame
    relayB.chanX.send(full); // B: one complete, unrelated frame on an independent channel

    expect(atQA).toHaveLength(0); // A's partial frame must not have been misparsed
    expect(atQB).toEqual([full]); // B is unaffected by A's in-flight partial state

    relayA.chanX.send(full.subarray(3));
    expect(atQA).toEqual([full]); // A's frame completes correctly once the rest arrives
  });

  it("closes both channels on an oversized/hostile length prefix rather than forwarding anything further", async () => {
    const { chanX, chanQ } = await setupFilteredRelay();
    const atQ: Buffer[] = [];
    chanQ.onData((chunk) => atQ.push(chunk));

    const hostile = Buffer.alloc(4);
    hostile.writeUInt32BE(10 * 1024 * 1024, 0); // far past MAX_FRAME_BYTES
    chanX.send(hostile);

    expect(chanX.closed).toBe(true);
    expect(chanQ.closed).toBe(true);
    expect(atQ).toHaveLength(0);
  });

  it("acknowledges every classified frame's ORIGINAL byte length — forwarded or rejected — not a fixed reply size, so cumulative small-frame traffic never leaks window credit", async () => {
    const { chanX, chanQ } = await setupFilteredRelay();
    chanQ.onData((chunk) => chanQ.acknowledgeConsumed(chunk.length)); // a well-behaved, always-draining downstream

    const rejectedBody = Buffer.alloc(5000, 9);
    const allowedBody = Buffer.from("ok");
    let totalSentBytes = 0;

    // Mostly large blocked frames (the case where acking the fixed
    // 5-byte SSH_AGENT_FAILURE_FRAME instead of the real request size
    // would leak thousands of bytes of window credit per frame) with a
    // few allowed ones interspersed (confirms forwarding keeps working
    // throughout, not just accounting). Comfortably exceeds one channel
    // window's worth of cumulative traffic.
    for (let i = 0; i < 70; i++) {
      if (i % 5 === 0) {
        const f = frame(SSH_AGENTC_SIGN_REQUEST, allowedBody);
        chanX.send(f);
        totalSentBytes += f.length;
      } else {
        const f = frame(SSH_AGENTC_LOCK, rejectedBody);
        chanX.send(f); // must not throw — see the leak this guards against, above
        totalSentBytes += f.length;
      }
    }

    expect(totalSentBytes).toBeGreaterThan(CHANNEL_WINDOW_BYTES);
    expect(chanX.sendWindow).toBeGreaterThan(0);

    // Forwarding still works after all that — not just window bookkeeping.
    const atQ: Buffer[] = [];
    chanQ.onData((chunk) => atQ.push(chunk));
    chanX.send(frame(SSH_AGENTC_SIGN_REQUEST, Buffer.from("final")));
    expect(atQ).toHaveLength(1);
  });
});
