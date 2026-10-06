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

describe("ScrollbackBuffer.totalBytesEverPushed", () => {
  it("starts at 0", () => {
    const buf = new ScrollbackBuffer();
    expect(buf.totalBytesEverPushed()).toBe(0);
  });

  it("tracks total bytes pushed, same as totalBufferedBytes when nothing has been evicted", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.from("hello"));
    buf.push(Buffer.from(" world"));
    expect(buf.totalBytesEverPushed()).toBe(11);
    expect(buf.totalBytesEverPushed()).toBe(buf.totalBufferedBytes());
  });

  it("issue #1296 — unlike totalBufferedBytes(), never decreases when eviction drops old chunks", () => {
    // The whole reason this method exists: a caller (Session's alt-screen-
    // exit watermark) needs to diff two readings to get "bytes written
    // since moment X" even after the ring has evicted past X — an index
    // into the current buffer would silently decay under eviction, but a
    // monotonic total survives it.
    const buf = new ScrollbackBuffer();
    const chunkSize = 100 * 1024;
    const chunkCount = Math.ceil(SCROLLBACK_MAX_BYTES / chunkSize) + 2;
    for (let i = 0; i < chunkCount; i++) {
      buf.push(Buffer.alloc(chunkSize, i % 256));
    }
    // Eviction has run (buffered total is capped)...
    expect(buf.totalBufferedBytes()).toBeLessThan(chunkSize * chunkCount);
    // ...but the monotonic total reflects every byte ever pushed, including
    // the evicted ones.
    expect(buf.totalBytesEverPushed()).toBe(chunkSize * chunkCount);
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

// Issue #1523 — the ring now coalesces small chunks into slabs; the replayed
// byte stream must be indistinguishable from the one-entry-per-chunk ring.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitRandomly(data: Buffer, rand: () => number, maxPiece: number): Buffer[] {
  const pieces: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const n = 1 + Math.floor(rand() * maxPiece);
    pieces.push(data.subarray(off, off + n));
    off += n;
  }
  return pieces;
}

describe("ScrollbackBuffer slab coalescing equivalence (issue #1523)", () => {
  it("random chunk splits of the same stream replay byte-identically (no eviction)", () => {
    const rand = mulberry32(1523);
    for (let round = 0; round < 25; round++) {
      const stream = Buffer.alloc(Math.floor(rand() * 400_000));
      for (let i = 0; i < stream.length; i++) stream[i] = Math.floor(rand() * 256);
      const whole = new ScrollbackBuffer();
      whole.push(stream);
      const maxPiece = [3, 50, 1000, 20_000, 70_000][round % 5];
      const split = new ScrollbackBuffer();
      for (const piece of splitRandomly(stream, rand, maxPiece)) split.push(Buffer.from(piece));
      const pre = Buffer.from("pre");
      expect(split.toBuffer(pre).equals(whole.toBuffer(pre))).toBe(true);
      expect(split.totalBufferedBytes()).toBe(stream.length);
      expect(split.totalBytesEverPushed()).toBe(stream.length);
      const n = Math.floor(rand() * (stream.length + 10));
      expect(split.tail(n).equals(whole.tail(n))).toBe(true);
      expect(split.tail(n).equals(stream.subarray(Math.max(0, stream.length - n)))).toBe(true);
    }
  });

  it("with eviction: replay is always a suffix of the stream, within the cap, accounting exact", () => {
    const rand = mulberry32(42);
    const stream = Buffer.alloc(3 * SCROLLBACK_MAX_BYTES + 12_345);
    for (let i = 0; i < stream.length; i++) stream[i] = Math.floor(rand() * 256);
    for (const maxPiece of [7, 300, 5_000, 40_000, 200_000]) {
      const buf = new ScrollbackBuffer();
      let pushed = 0;
      let pieceNo = 0;
      for (const piece of splitRandomly(stream, rand, maxPiece)) {
        buf.push(Buffer.from(piece));
        pushed += piece.length;
        // Invariants hold after every push, not only at the end.
        if (++pieceNo % 97 === 0 || pushed === stream.length) {
          const replay = buf.toBuffer(Buffer.alloc(0));
          expect(replay.length).toBe(buf.totalBufferedBytes());
          expect(replay.equals(stream.subarray(pushed - replay.length, pushed))).toBe(true);
          expect(buf.totalBytesEverPushed()).toBe(pushed);
        }
      }
      const replay = buf.toBuffer(Buffer.alloc(0));
      // Within the cap (every piece here is < the cap, so the "sole oversized
      // survivor" exemption can't apply), and not over-evicted by more than
      // one slab + one chunk.
      expect(replay.length).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
      expect(replay.length).toBeGreaterThan(SCROLLBACK_MAX_BYTES - 64 * 1024 - 200_000);
    }
  });

  it("many tiny chunks never leave the buffer empty and keep the newest bytes (compaction path)", () => {
    const buf = new ScrollbackBuffer();
    // ~20 MiB of 20 KiB-and-up chunks forces thousands of slab evictions and
    // several head compactions.
    for (let i = 0; i < 1000; i++) buf.push(Buffer.alloc(20 * 1024, i % 251));
    const replay = buf.toBuffer(Buffer.alloc(0));
    expect(replay.length).toBeGreaterThan(0);
    expect(replay[replay.length - 1]).toBe(999 % 251);
    expect(buf.totalBufferedBytes()).toBeLessThanOrEqual(SCROLLBACK_MAX_BYTES);
  });

  it("ignores empty chunks without disturbing accounting", () => {
    const buf = new ScrollbackBuffer();
    buf.push(Buffer.alloc(0));
    buf.push(Buffer.from("a"));
    buf.push(Buffer.alloc(0));
    expect(buf.toBuffer(Buffer.alloc(0)).toString()).toBe("a");
    expect(buf.totalBytesEverPushed()).toBe(1);
  });
});
