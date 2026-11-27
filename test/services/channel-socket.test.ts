import { describe, it, expect, vi } from "vitest";
import {
  ChannelSocket,
  ChannelStreamFailure,
  CHANNEL_FAILURE_NOTICE_TIMEOUT_MS,
  CHANNEL_FAILURE_TOO_LARGE,
} from "../../src/services/channel-socket.js";
import { CHANNEL_WINDOW_BYTES, type MuxChannel } from "../../src/services/ssh-agent-mux.js";
import {
  AGENT_CHANNEL_MAX_BUFFERED_BYTES,
  AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES,
} from "../../src/shared/agent-channel.js";

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

  it("writes the head line in pieces when the window is small (#3402)", () => {
    // The head line is what the peer parses before any frame, so it may not
    // be reordered by what follows it — not even when the window only
    // carries a few bytes of it at a time.
    const f = fakeChannel(2);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    s.sendRaw(Buffer.from('{"status":200}\n'));
    expect(Buffer.concat(f.sent).toString()).toBe('{"');
    f.grant(64);
    expect(Buffer.concat(f.sent).toString()).toBe('{"status":200}\n');
  });

  it("tells the peer WHY the stream died when a message is over the cap (#3402)", () => {
    // The failure rides the channel as a notice, so the far end can name
    // the cap instead of reporting a bare disconnect.
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: false });
    s.notices = true;
    s.bind(f.ch);
    const local: Error[] = [];
    s.on("error", (e: Error) => local.push(e));
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1, 1));
    expect(local[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((local[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);

    // The peer reads the notice and raises the same failure.
    const g = fakeChannel(1 << 20);
    const peer = new ChannelSocket({ expectHead: false });
    peer.bind(g.ch);
    const remote: Error[] = [];
    peer.on("error", (e: Error) => remote.push(e));
    const messages: unknown[] = [];
    peer.on("message", (d: Buffer) => messages.push(d));
    peer.ingest(Buffer.concat(f.sent));
    expect(remote[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((remote[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);
    // The notice is consumed by the transport, never handed to the stream.
    expect(messages).toEqual([]);
    expect(peer.readyState).toBe(peer.CLOSED);
  });

  it("reaches the peer with the notice when a frame is half on the wire (#3402)", () => {
    // The ordinary video state, with the real constants: a 300 KiB frame
    // does not fit the 256 KiB window, so a tail of it stays queued and the
    // window is shut. A notice queued BEHIND that backlog would never reach
    // the wire, and the panel would see the bare disconnect this fix is
    // about. But the notice may not be spliced into the frame that is
    // already half on the wire either: the peer would read it as that
    // frame's payload and never see a frame at all. So the tail goes out
    // first, and the notice follows on a frame boundary.
    const f = fakeChannel(CHANNEL_WINDOW_BYTES);
    const s = new ChannelSocket({ expectHead: false });
    s.notices = true;
    s.bind(f.ch);
    s.send(Buffer.alloc(300 * 1024, 1));
    expect(f.ch.sendWindow).toBe(0);
    // The tail of the frame is still queued.
    expect(s.bufferedAmount).toBe(300 * 1024 + 5 - CHANNEL_WINDOW_BYTES);

    const local: Error[] = [];
    s.on("error", (e: Error) => local.push(e));
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1, 2));
    expect(local[0]).toBeInstanceOf(ChannelStreamFailure);
    // The stream is closing, but the notice still waits for the window.
    expect(s.readyState).toBe(s.CLOSING);
    const noticeBytes =
      Buffer.byteLength(
        JSON.stringify({ code: CHANNEL_FAILURE_TOO_LARGE, reason: "message too large" }),
      ) + 5;
    expect(s.bufferedAmount).toBe(300 * 1024 + 5 - CHANNEL_WINDOW_BYTES + noticeBytes);

    // The window opens: the tail of the half-written frame goes out first,
    // then the notice — on a frame boundary, so the peer reads it as a frame.
    f.grant(64 * 1024);
    const out = Buffer.concat(f.sent);
    const noticeAt = 300 * 1024 + 5;
    expect(out[noticeAt]).toBe(2); // the failure-notice flag
    const length = out.readUInt32BE(noticeAt + 1);
    expect(JSON.parse(out.subarray(noticeAt + 5, noticeAt + 5 + length).toString("utf8"))).toEqual({
      code: CHANNEL_FAILURE_TOO_LARGE,
      reason: "message too large",
    });
    // The frames the peer has not started are dropped with the stream.
    expect(out.length).toBe(noticeAt + 5 + length);
    expect(s.readyState).toBe(s.CLOSED);

    // And the peer reads it: the frame that was already on the wire
    // completes, and the notice after it is the failure it raises.
    const peer = new ChannelSocket({ expectHead: false });
    peer.bind(fakeChannel(1 << 20).ch);
    const remote: Error[] = [];
    peer.on("error", (e: Error) => remote.push(e));
    const messages: Buffer[] = [];
    peer.on("message", (d: Buffer) => messages.push(d));
    peer.ingest(out.subarray(0, CHANNEL_WINDOW_BYTES));
    peer.ingest(out.subarray(CHANNEL_WINDOW_BYTES));
    expect(remote[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((remote[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);
    // The notice is consumed by the transport, never handed to the stream:
    // the peer saw the frame that was on the wire, and nothing else.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.length).toBe(300 * 1024);
    expect(peer.readyState).toBe(peer.CLOSED);
  });

  it("keeps the notice off a half-written frame header (#3402)", () => {
    // A frame's HEADER can be half on the wire too, when the peer's window
    // is smaller than the five header bytes. The notice may not be spliced
    // into it: the peer would read the notice's bytes as the rest of the
    // header, and then wait for a frame that never comes. So the notice
    // waits for the header — and for the frame it belongs to — to finish,
    // and goes out on the frame boundary after it.
    const f = fakeChannel(2);
    const s = new ChannelSocket({ expectHead: false });
    s.notices = true;
    s.bind(f.ch);
    s.send(Buffer.alloc(10, 1));
    s.send(Buffer.alloc(10, 2));
    const local: Error[] = [];
    s.on("error", (e: Error) => local.push(e));
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1, 3));
    expect(local[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((local[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);
    // The header of the first frame is half on the wire: the notice waits.
    expect(Buffer.concat(f.sent)).toHaveLength(2);
    expect(s.readyState).toBe(s.CLOSING);

    f.grant(3);
    f.grant(10);
    f.grant(100);
    const out = Buffer.concat(f.sent);
    // The header that was on the wire is completed, not cut into by the
    // notice: its length still reads as the payload's.
    expect(out.readUInt32BE(1)).toBe(10);
    // The frame that was on the wire goes out first; the notice follows it,
    // on the frame boundary.
    const noticeAt = 5 + 10;
    expect(out[noticeAt]).toBe(2); // the failure-notice flag
    const length = out.readUInt32BE(noticeAt + 1);
    expect(JSON.parse(out.subarray(noticeAt + 5, noticeAt + 5 + length).toString("utf8"))).toEqual({
      code: CHANNEL_FAILURE_TOO_LARGE,
      reason: "message too large",
    });
    // The frame the peer had not started is dropped with the stream.
    expect(out.length).toBe(noticeAt + 5 + length);

    // And the peer reads it: the one frame that was on the wire arrives,
    // and the notice after it is the failure it raises.
    const peer = new ChannelSocket({ expectHead: false });
    peer.bind(fakeChannel(1 << 20).ch);
    const remote: Error[] = [];
    peer.on("error", (e: Error) => remote.push(e));
    const messages: Buffer[] = [];
    peer.on("message", (d: Buffer) => messages.push(d));
    peer.ingest(out);
    expect(remote[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((remote[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.length).toBe(10);
    expect(peer.readyState).toBe(peer.CLOSED);
  });

  it("puts the notice ahead of the frames the peer has not started (#3402)", () => {
    // The window is shut before anything of the queued frame is on the wire,
    // so the notice goes ahead of it: the frame has not started, and the
    // peer reads the notice as the first frame on the wire.
    const f = fakeChannel(0);
    const s = new ChannelSocket({ expectHead: false });
    s.notices = true;
    s.bind(f.ch);
    s.send(Buffer.alloc(300 * 1024, 1));
    expect(f.sent).toHaveLength(0);
    const local: Error[] = [];
    s.on("error", (e: Error) => local.push(e));
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1, 2));
    expect(local[0]).toBeInstanceOf(ChannelStreamFailure);
    expect(s.readyState).toBe(s.CLOSING);

    f.grant(64 * 1024);
    const out = Buffer.concat(f.sent);
    expect(out[0]).toBe(2); // the failure-notice flag
    const length = out.readUInt32BE(1);
    expect(JSON.parse(out.subarray(5, 5 + length).toString("utf8"))).toEqual({
      code: CHANNEL_FAILURE_TOO_LARGE,
      reason: "message too large",
    });
    // The frame the peer had not started is dropped with the stream.
    expect(out.length).toBe(5 + length);

    // The peer reads the notice as the failure it is — and as nothing else.
    const peer = new ChannelSocket({ expectHead: false });
    peer.bind(fakeChannel(1 << 20).ch);
    const remote: Error[] = [];
    peer.on("error", (e: Error) => remote.push(e));
    const messages: unknown[] = [];
    peer.on("message", (d: Buffer) => messages.push(d));
    peer.ingest(out);
    expect(remote[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((remote[0] as ChannelStreamFailure).code).toBe(CHANNEL_FAILURE_TOO_LARGE);
    expect(messages).toEqual([]);
    expect(peer.readyState).toBe(peer.CLOSED);
  });

  it("does not drop a pending notice when the stream is closed (#3402)", () => {
    // The caller's own teardown (the panel closing the relay) must not take
    // the notice with it: the peer still hears why the stream died.
    const f = fakeChannel(0);
    const s = new ChannelSocket({ expectHead: false });
    s.notices = true;
    s.bind(f.ch);
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1));
    expect(s.readyState).toBe(s.CLOSING);
    s.close();
    // The close waits for the notice, so the channel is still open.
    expect(s.readyState).toBe(s.CLOSING);
    expect(f.raw.close).not.toHaveBeenCalled();
    // The window opens: the notice goes out and the stream ends.
    f.grant(64 * 1024);
    expect(Buffer.concat(f.sent)[0]).toBe(2);
    expect(s.readyState).toBe(s.CLOSED);
  });

  it("closes the stream when the peer never drains the notice (#3402)", () => {
    // A peer that never drains must not hold the stream open for good: the
    // notice has a bound, and the stream ends without it.
    vi.useFakeTimers();
    try {
      const f = fakeChannel(0);
      const s = new ChannelSocket({ expectHead: false });
      s.notices = true;
      s.bind(f.ch);
      s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1));
      expect(s.readyState).toBe(s.CLOSING);
      expect(f.sent).toHaveLength(0);
      vi.advanceTimersByTime(CHANNEL_FAILURE_NOTICE_TIMEOUT_MS);
      expect(s.readyState).toBe(s.CLOSED);
      expect(f.raw.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends no notice to a peer that did not ask for one (#3402)", () => {
    // A peer that predates the notice reads the frame as ordinary stream
    // data, so it is only ever sent to a peer that advertised it.
    const f = fakeChannel(1 << 20);
    const s = new ChannelSocket({ expectHead: false });
    s.bind(f.ch);
    const local: Error[] = [];
    s.on("error", (e: Error) => local.push(e));
    s.send(Buffer.alloc(AGENT_CHANNEL_MAX_STREAM_MESSAGE_BYTES + 1));
    expect(local[0]).toBeInstanceOf(ChannelStreamFailure);
    expect(f.sent).toHaveLength(0);
    expect(s.readyState).toBe(s.CLOSED);
  });

  it("fails the stream on a notice it cannot read (#3402)", () => {
    // A notice the transport cannot parse is still a failure: the stream is
    // over either way, and the bytes never reach the stream's consumers.
    const g = fakeChannel(1 << 20);
    const peer = new ChannelSocket({ expectHead: false });
    peer.bind(g.ch);
    const remote: Error[] = [];
    peer.on("error", (e: Error) => remote.push(e));
    const messages: unknown[] = [];
    peer.on("message", (d: Buffer) => messages.push(d));
    const header = Buffer.alloc(5);
    header[0] = 2; // the failure-notice flag
    header.writeUInt32BE(7, 1);
    peer.ingest(Buffer.concat([header, Buffer.from("not json")]));
    expect(remote[0]).toBeInstanceOf(ChannelStreamFailure);
    expect((remote[0] as ChannelStreamFailure).code).toBe("channel-failed");
    expect(messages).toEqual([]);
    expect(peer.readyState).toBe(peer.CLOSED);
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
