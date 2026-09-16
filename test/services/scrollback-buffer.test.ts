import { describe, it, expect } from "vitest";
import { ScrollbackBuffer, SCROLLBACK_MAX_BYTES } from "../../src/services/scrollback-buffer.js";

describe("ScrollbackBuffer.push / totalBufferedBytes", () => {
  it("starts empty", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.totalBufferedBytes()).toBe(0);
  });

  it("tracks total buffered bytes across pushes", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("hello"));
    buf.push(Buffer.from(" world"));
    expect(buf.totalBufferedBytes()).toBe(11);
  });

  it("evicts oldest chunks first once the total exceeds SCROLLBACK_MAX_BYTES", () => {
    const buf = new ScrollbackBuffer();
    const chunkSize = 100 * 1024;
    const chunkCount = Math.ceil(SCROLLBACK_MAX_BYTES / chunkSize) + 2;
    const chunks: Buffer[] = [];
    for (let i = 0; i < chunkCount; i++) {
      // Each chunk is filled with a distinct byte value so eviction order is
      // independently verifiable via toBuffer() below, not just the total.
      const chunk = Buffer.alloc(chunkSize, i % 256);
      chunks.push(chunk);
      buf.push(chunk);
    }
    expect(buf.totalBufferedBytes()).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
    // The oldest chunk (value 0) must have been evicted — its byte value
    // must not appear anywhere in a fresh replay.
    const replay = buf.toBuffer(Buffer.alloc(0));
    expect(replay.includes(0)).toBe(false);
    // The newest chunk must have survived.
    expect(replay.includes(chunkCount - 1)).toBe(true);
  });

  it("never evicts the last remaining chunk, even if it alone exceeds the cap", () => {
    const buf = new ScrollbackBuffer();
    const oversized = Buffer.alloc(SCROLLBACK_MAX_BYTES * 2, 7);
    buf.push(oversized);
    expect(buf.totalBufferedBytes()).toBe(oversized.length);
    expect(buf.toBuffer(Buffer.alloc(0)).length).toBe(oversized.length);
  });

  it("evicts down to a single oversized chunk once total pushed exceeds the cap, without ever going empty", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("small chunk that will be evicted"));
    const oversized = Buffer.alloc(SCROLLBACK_MAX_BYTES + 1, 9);
    buf.push(oversized);
    // The small first chunk is evicted (total now exceeds the cap and
    // chunks.length > 1), but the oversized second chunk is the sole
    // survivor rather than leaving the buffer empty.
    expect(buf.totalBufferedBytes()).toBe(oversized.length);
  });
});

describe("ScrollbackBuffer.toBuffer", () => {
  it("prefixes buffered chunks with the given preamble", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("hello"));
    buf.push(Buffer.from(" world"));
    expect(buf.toBuffer(Buffer.from(">> ")).toString("utf8")).toBe(">> hello world");
  });

  it("returns just the preamble when nothing has been pushed", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.toBuffer(Buffer.from("preamble")).toString("utf8")).toBe("preamble");
  });
});

describe("ScrollbackBuffer.tail", () => {
  it("returns everything when the buffer holds less than maxBytes", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("short"));
    expect(buf.tail(1024).toString("utf8")).toBe("short");
  });

  it("returns exactly the last maxBytes when it spans multiple chunk boundaries", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("aaaaa")); // 5 bytes, fully evicted from the tail window
    buf.push(Buffer.from("bbb")); // 3 bytes, partially within the tail window
    buf.push(Buffer.from("ccccc")); // 5 bytes, fully within the tail window
    // Last 7 bytes: "bb" (last 2 of "bbb") + "ccccc" (5).
    expect(buf.tail(7).toString("utf8")).toBe("bbccccc");
  });

  it("trims the oldest included chunk down to exactly maxBytes, not the whole chunk", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("0123456789")); // 10 bytes
    expect(buf.tail(3).toString("utf8")).toBe("789");
  });

  it("returns an empty buffer for an empty ScrollbackBuffer", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.tail(1024).length).toBe(0);
  });

  it("returns an empty buffer when maxBytes is 0", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("some content"));
    expect(buf.tail(0).length).toBe(0);
  });

  it("can cut mid-multibyte-character, which is exactly why a caller must treat a truncated read as possibly unsafe to decode from its start", () => {
    // "é" (U+00E9) is 2 bytes in UTF-8 (0xC3 0xA9), the last 2 of "café"'s 5
    // total bytes. Asking for only the last 1 byte returns the lone 0xA9
    // continuation byte with its leading 0xC3 byte cut off — decoding that
    // alone as UTF-8 (`toString("utf8")`) yields a U+FFFD replacement
    // character rather than the real character or a thrown error. This is
    // the real-world hazard terminal-text.ts's lastMeaningfulLine's
    // `truncated` option exists to guard against by discarding a truncated
    // read's first line outright.
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("café", "utf8"));
    const cut = buf.tail(1);
    expect(cut.length).toBe(1);
    expect(cut.toString("utf8")).toBe("�");
  });
});
