import { describe, it, expect } from "vitest";
import {
  AGENT_CHANNEL_BACKOFF,
  backoffDelayMs,
  parseAuthFrame,
  protocolMismatch,
} from "../../src/shared/agent-channel.js";
import { localProtocolInfo } from "../../src/shared/agent-protocol.js";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";

describe("agent channel contract helpers (#2450)", () => {
  it("backs off exponentially, capped, with bounded jitter", () => {
    const mid = () => 0.5;
    expect(backoffDelayMs(0, mid)).toBe(AGENT_CHANNEL_BACKOFF.minMs);
    expect(backoffDelayMs(2, mid)).toBe(AGENT_CHANNEL_BACKOFF.minMs * 4);
    expect(backoffDelayMs(50, mid)).toBe(AGENT_CHANNEL_BACKOFF.maxMs);
    expect(backoffDelayMs(50, () => 1)).toBeLessThanOrEqual(AGENT_CHANNEL_BACKOFF.maxMs * 1.2);
    expect(backoffDelayMs(0, () => 0)).toBeGreaterThanOrEqual(AGENT_CHANNEL_BACKOFF.minMs * 0.8);
  });

  it("parses only well-formed auth frames", () => {
    const ok = { type: "auth", hostId: "h", credential: "c", protocol: localProtocolInfo() };
    expect(parseAuthFrame(ok)?.hostId).toBe("h");
    expect(parseAuthFrame({ ...ok, hostId: "" })).toBeNull();
    expect(parseAuthFrame({ ...ok, credential: 5 })).toBeNull();
    expect(parseAuthFrame({ ...ok, protocol: { protocolVersion: "1" } })).toBeNull();
    expect(parseAuthFrame({ ...ok, protocol: { protocolVersion: 1, operations: [1] } })).toBeNull();
    expect(parseAuthFrame(null)).toBeNull();
  });

  it("flags protocols outside the supported range", () => {
    expect(protocolMismatch(localProtocolInfo())).toBeNull();
    expect(protocolMismatch({ ...localProtocolInfo(), protocolVersion: 0 })).toMatch(/outside/);
  });
});

describe("mux maxBufferedBytes (#2450)", () => {
  class Sock {
    readyState = 1;
    OPEN = 1;
    CONNECTING = 0;
    bufferedAmount = 0;
    sent = 0;
    terminated = false;
    private l = new Map<string, Array<(...a: unknown[]) => void>>();
    on(e: string, f: (...a: unknown[]) => void) {
      this.l.set(e, [...(this.l.get(e) ?? []), f]);
    }
    send() {
      this.sent++;
    }
    close() {
      this.readyState = 3;
    }
    terminate() {
      this.terminated = true;
      this.readyState = 3;
    }
  }

  it("terminates the connection instead of queueing past the bound", async () => {
    const s = new Sock();
    const mux = createMuxConnection(s as never, { channelIdParity: "odd", maxBufferedBytes: 100 });
    let reason = "";
    mux.onClose((r) => (reason = r));
    s.bufferedAmount = 101;
    await expect(mux.openChannel()).rejects.toThrow(/closed/);
    expect(s.sent).toBe(0);
    expect(s.terminated).toBe(true);
    expect(reason).toMatch(/send buffer exceeded 100/);
  });

  it("sends normally under the bound", () => {
    const s = new Sock();
    const mux = createMuxConnection(s as never, { channelIdParity: "odd", maxBufferedBytes: 100 });
    s.bufferedAmount = 100;
    void mux.openChannel().catch(() => {});
    expect(s.sent).toBe(1);
    expect(s.terminated).toBe(false);
    mux.close();
  });
});
