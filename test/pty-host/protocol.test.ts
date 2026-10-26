import { describe, it, expect } from "vitest";
import {
  FRAME_DATA,
  FRAME_EXIT,
  FRAME_RESIZE,
  MAX_FRAME_BYTES,
  createDeframer,
  encodeExit,
  encodeFrame,
  encodeResize,
} from "../../src/pty-host/protocol.mjs";

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
});
