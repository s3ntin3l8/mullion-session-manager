import { describe, it, expect } from "vitest";
import {
  FRAME_DATA,
  FRAME_EXIT,
  FRAME_HELLO,
  FRAME_RESIZE,
  FRAME_VERSION,
  MAX_FRAME_BYTES,
  MIN_CLIENT_VERSION,
  MIN_MASTER_VERSION,
  PROTOCOL_VERSION,
  createDeframer,
  encodeExit,
  encodeFrame,
  encodeHello,
  encodeResize,
  decodeVersion,
  encodeVersion,
  masterCompatibility,
} from "../../src/pty-host/protocol.mjs";
import golden from "../fixtures/pty-host-protocol-v1.json";

function collect() {
  const frames: Array<{ type: number; payload: Buffer }> = [];
  const feed = createDeframer((type, payload) => frames.push({ type, payload }));
  return { frames, feed };
}

describe("pty-host protocol", () => {
  it("round-trips a data frame", () => {
    const { frames, feed } = collect();
    feed(encodeFrame(FRAME_DATA, Buffer.from("héllo", "utf8")));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FRAME_DATA);
    expect(frames[0].payload.toString("utf8")).toBe("héllo");
  });

  it("reassembles a frame split across chunks, one byte at a time", () => {
    const { frames, feed } = collect();
    const bytes = encodeFrame(FRAME_DATA, Buffer.from("split"));
    for (const byte of bytes) feed(Buffer.from([byte]));
    expect(frames.map((f) => f.payload.toString())).toEqual(["split"]);
  });

  it("delivers several frames from one chunk, in order", () => {
    const { frames, feed } = collect();
    feed(
      Buffer.concat([
        encodeFrame(FRAME_DATA, Buffer.from("a")),
        encodeResize(120, 40),
        encodeExit(3),
      ]),
    );
    expect(frames.map((f) => f.type)).toEqual([FRAME_DATA, FRAME_RESIZE, FRAME_EXIT]);
    expect(frames[1].payload.readUInt16BE(0)).toBe(120);
    expect(frames[1].payload.readUInt16BE(2)).toBe(40);
    expect(frames[2].payload.readInt32BE(0)).toBe(3);
  });

  it("carries a session token in a HELLO frame", () => {
    const { frames, feed } = collect();
    feed(encodeHello("s3cret"));
    expect(frames).toEqual([{ type: FRAME_HELLO, payload: Buffer.from("s3cret") }]);
  });

  it("carries an empty payload and a negative exit code", () => {
    const { frames, feed } = collect();
    feed(encodeFrame(FRAME_DATA, Buffer.alloc(0)));
    feed(encodeExit(-1));
    expect(frames[0].payload.length).toBe(0);
    expect(frames[1].payload.readInt32BE(0)).toBe(-1);
  });

  it("clamps a resize into the u16 range, never below 1", () => {
    const { frames, feed } = collect();
    feed(encodeResize(0, 70000));
    feed(encodeResize(Number.NaN, 2.7));
    expect([frames[0].payload.readUInt16BE(0), frames[0].payload.readUInt16BE(2)]).toEqual([
      1, 65535,
    ]);
    expect([frames[1].payload.readUInt16BE(0), frames[1].payload.readUInt16BE(2)]).toEqual([1, 2]);
  });

  it("throws on a frame that declares more than the size cap", () => {
    const { feed } = collect();
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME_DATA, 0);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
    expect(() => feed(header)).toThrow(/exceeds/);
  });

  // Issue #2168: masters outlive the release that started them, so an existing
  // encoding may never change - only new frames may be added. These bytes are
  // what v1 masters and clients already speak.
  it("keeps every existing frame encoding byte-for-byte (additive-only rule)", () => {
    const hex = (b: Buffer) => b.toString("hex");
    expect(hex(encodeFrame(FRAME_DATA, Buffer.from("hi")))).toBe(golden.frames.data_hi);
    expect(hex(encodeResize(120, 40))).toBe(golden.frames.resize_120x40);
    expect(hex(encodeExit(3))).toBe(golden.frames.exit_3);
    expect(hex(encodeExit(-1))).toBe(golden.frames.exit_minus1);
    expect(hex(encodeHello("tok"))).toBe(golden.frames.hello_tok);
    expect(hex(encodeVersion(2, 1))).toBe(golden.added.version_2_1);
  });

  it("round-trips a VERSION frame and rejects a short payload", () => {
    const { frames, feed } = collect();
    feed(encodeVersion());
    expect(frames[0].type).toBe(FRAME_VERSION);
    expect(decodeVersion(frames[0].payload)).toEqual({
      version: PROTOCOL_VERSION,
      minClient: MIN_CLIENT_VERSION,
    });
    expect(decodeVersion(Buffer.alloc(3))).toBeNull();
  });

  it("treats a master with no VERSION frame as v1, compatible while the minimum is 1", () => {
    expect(masterCompatibility(null)).toEqual({ compatible: true, masterVersion: 1, minClient: 1 });
    expect(MIN_MASTER_VERSION).toBe(1);
  });

  it("reports a master that needs a newer client as incompatible", () => {
    const verdict = masterCompatibility({ version: 9, minClient: PROTOCOL_VERSION + 1 });
    expect(verdict).toEqual({
      compatible: false,
      masterVersion: 9,
      minClient: PROTOCOL_VERSION + 1,
    });
    expect(masterCompatibility({ version: 9, minClient: PROTOCOL_VERSION }).compatible).toBe(true);
  });
});
