import { describe, it, expect, vi } from "vitest";
import { ChannelSocket } from "../../src/services/channel-socket.js";
import type { MuxChannel } from "../../src/services/ssh-agent-mux.js";
import { AGENT_CHANNEL_MAX_BUFFERED_BYTES } from "../../src/shared/agent-channel.js";

// A MuxChannel double with a controllable send window, to see backpressure.
function fakeChannel(initialWindow: number) {
  let window = initialWindow;
  const sent: Buffer[] = [];
  const drain: Array<() => void> = [];
  const close: Array<() => void> = [];
  const ch = {
    id: 1,
    closed: false,
    get sendWindow() {
      return window;
    },
    send(chunk: Buffer) {
      if (chunk.length > window) throw new Error("window exceeded");
      window -= chunk.length;
      sent.push(Buffer.from(chunk));
    },
    eof: vi.fn(),
    close: vi.fn(() => {
      ch.closed = true;
      close.forEach((l) => l());
    }),
    onData: vi.fn(),
    onEof: vi.fn(),
    onClose: (l: () => void) => close.push(l),
    onDrain: (l: () => void) => drain.push(l),
    acknowledgeConsumed: vi.fn(),
  };
  return {
    ch: ch as unknown as MuxChannel,
    raw: ch,
    sent,
    grant(bytes: number) {
      window += bytes;
      drain.forEach((l) => l());
    },
  };
}

function frame(payload: Buffer, binary: boolean): Buffer {
  const h = Buffer.alloc(5);
  h[0] = binary ? 1 : 0;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

describe("ChannelSocket (#2571)", () => {
  it("frames messages and keeps the text/binary distinction across split chunks", () => {
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    const got: Array<[string, boolean]> = [];
    s.on("message", (d: Buffer, bin: boolean) => got.push([d.toString(), bin]));
    const wire = Buffer.concat([frame(Buffer.from("hi"), false), frame(Buffer.from("PTY"), true)]);
    s.ingest(wire.subarray(0, 3));
    s.ingest(wire.subarray(3, 9));
    s.ingest(wire.subarray(9));
    expect(got).toEqual([
      ["hi", false],
      ["PTY", true],
    ]);
    s.send("text");
    s.send(Buffer.from([1, 2]));
    const out = Buffer.concat(f.sent);
    expect(out[0]).toBe(0);
    expect(out.subarray(5, 9).toString()).toBe("text");
    expect(out[9]).toBe(1);
  });

  it("reports queued bytes as bufferedAmount while the peer's window is shut, then drains in order", () => {
    const f = fakeChannel(0);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    s.send(Buffer.alloc(1000, 1));
    s.send(Buffer.alloc(1000, 2));
    expect(s.bufferedAmount).toBe(2010);
    expect(f.sent).toHaveLength(0);
    f.grant(500);
    expect(s.bufferedAmount).toBe(1510);
    f.grant(10_000);
    expect(s.bufferedAmount).toBe(0);
    const all = Buffer.concat(f.sent);
    expect(all.length).toBe(2010);
    expect(all[5]).toBe(1);
    expect(all[1010]).toBe(2);
  });

  it("closes a stalled link instead of queueing past the ceiling", () => {
    const f = fakeChannel(0);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    const closed = vi.fn();
    s.on("close", closed);
    const chunk = Buffer.alloc(512 * 1024);
    for (let i = 0; i < AGENT_CHANNEL_MAX_BUFFERED_BYTES / chunk.length + 2; i++) s.send(chunk);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.readyState).toBe(s.CLOSED);
    expect(s.bufferedAmount).toBe(0);
    expect(f.raw.close).toHaveBeenCalled();
  });

  it("closes on a message over the cap and on a lost channel", () => {
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    const errors: Error[] = [];
    s.on("error", (e: Error) => errors.push(e));
    const h = Buffer.alloc(5);
    h.writeUInt32BE(2 * 1024 * 1024, 1);
    s.ingest(h);
    expect(errors[0]?.message).toContain("too large");
    expect(s.readyState).toBe(s.CLOSED);

    const g = fakeChannel(1 << 20);
    const t = new ChannelSocket({ expectHead: false });
    t.bind(g.ch);
    const codes: number[] = [];
    t.on("close", (code: number) => codes.push(code));
    g.raw.close();
    expect(codes).toEqual([1006]);
  });

  it("surfaces an agent refusal as unexpected-response, not as an error", () => {
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: true });
    s.bind(f.ch);
    const onError = vi.fn();
    const seen: number[] = [];
    s.on("error", onError);
    s.on("unexpected-response", (_req: unknown, res: { statusCode: number }) =>
      seen.push(res.statusCode),
    );
    s.ingest(Buffer.from('{"status":403,"message":"nope"}\n'));
    expect(seen).toEqual([403]);
    expect(onError).not.toHaveBeenCalled();
    expect(s.readyState).toBe(s.CLOSED);
  });

  it("opens on a 200 head, carries the resumed flag, and fails as unreachable when never opened", () => {
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: true });
    s.bind(f.ch);
    const open = vi.fn();
    s.on("open", open);
    s.ingest(Buffer.from('{"status":200,"resumed":true}\n'));
    expect(open).toHaveBeenCalled();
    expect(s.resumed).toBe(true);

    const u = new ChannelSocket({ expectHead: true });
    const err = vi.fn();
    const close = vi.fn();
    u.on("error", err);
    u.on("close", close);
    u.failToOpen(new Error("no channel"));
    expect(err).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
