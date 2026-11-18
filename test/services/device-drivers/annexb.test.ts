import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnnexBPacketizer,
  AnnexBSplitter,
  GopBuffer,
  nalType,
} from "../../../src/services/device-drivers/annexb.js";
import type { DeviceVideoPacket } from "../../../src/services/device-drivers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(path.resolve(here, "../../fixtures/devices/idb-h264-sample.h264")),
);

function splitAll(chunks: Uint8Array[]): Uint8Array[] {
  const s = new AnnexBSplitter();
  const out = chunks.flatMap((c) => s.push(c));
  return [...out, ...s.flush()];
}

/** Deterministic PRNG so a failing chunking is reproducible. */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function cut(bytes: Uint8Array, nextSize: () => number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length;) {
    const n = Math.max(1, nextSize());
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

const nal = (type: number, ...rest: number[]) => Uint8Array.of(type, 0xaa, ...rest);
const sc4 = (n: Uint8Array) => Uint8Array.of(0, 0, 0, 1, ...n);
const sc3 = (n: Uint8Array) => Uint8Array.of(0, 0, 1, ...n);
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

describe("AnnexBSplitter", () => {
  const whole = splitAll([fixture]);

  it("reads the fixture as SPS, PPS, one IDR and 20 slices", () => {
    expect(whole.map(nalType)).toEqual([7, 8, 5, ...Array<number>(20).fill(1)]);
  });

  it("yields the same NALs for 1-byte chunks", () => {
    expect(splitAll(cut(fixture, () => 1))).toEqual(whole);
  });

  it("yields the same NALs for random chunk sizes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed);
      expect(splitAll(cut(fixture, () => Math.floor(r() * 400)))).toEqual(whole);
    }
  });

  it("handles 3-byte start codes, mixed with 4-byte ones", () => {
    const a = nal(0x67, 1, 2);
    const b = nal(0x68, 3);
    const c = nal(0x65, 4, 5, 6);
    const stream = cat(sc3(a), sc4(b), sc3(c));
    expect(splitAll([stream])).toEqual([a, b, c]);
    expect(splitAll(cut(stream, () => 1))).toEqual([a, b, c]);
  });

  it("does not leak the leading zero of a 4-byte code into the previous NAL", () => {
    const a = nal(0x41, 9);
    const b = nal(0x41, 8);
    expect(splitAll([cat(sc4(a), sc4(b))])).toEqual([a, b]);
  });

  it("drops bytes before the first start code", () => {
    const a = nal(0x67, 1);
    expect(splitAll([cat(Uint8Array.of(7, 7, 0, 7), sc4(a))])).toEqual([a]);
  });

  it("holds the last NAL until the next start code or flush", () => {
    const s = new AnnexBSplitter();
    const a = nal(0x67, 1);
    expect(s.push(sc4(a))).toEqual([]);
    expect(s.flush()).toEqual([a]);
    expect(s.flush()).toEqual([]);
    expect(s.push(new Uint8Array())).toEqual([]);
  });

  it("resynchronises after an absurdly long NAL", () => {
    const s = new AnnexBSplitter();
    s.push(sc4(nal(0x41)));
    const big = new Uint8Array(1024 * 1024).fill(0x11);
    for (let i = 0; i < 9; i++) s.push(big);
    const a = nal(0x67, 1);
    s.push(sc4(a));
    expect(s.flush()).toEqual([a]);
  });
});

describe("AnnexBPacketizer", () => {
  it("turns the fixture into config, a keyframe, then deltas", () => {
    const packets = new AnnexBPacketizer();
    const out = [...packets.push(fixture), ...packets.flush()];
    expect(out).toHaveLength(22);
    expect(out[0]!.type).toBe("configuration");
    // SPS + PPS, each with a 4-byte start code.
    const config = out[0]!.data;
    expect([...config.subarray(0, 5)]).toEqual([0, 0, 0, 1, 0x27]);
    const ppsAt = config.findIndex(
      (_, i) => i > 4 && config[i + 4] === 0x28 && config[i + 3] === 1,
    );
    expect(ppsAt).toBeGreaterThan(0);
    expect(out[1]).toMatchObject({ type: "data", keyframe: true });
    expect([...out[1]!.data.subarray(0, 5)]).toEqual([0, 0, 0, 1, 0x25]);
    for (const p of out.slice(2)) {
      expect(p.type).toBe("data");
      expect((p as { keyframe?: boolean }).keyframe).toBeFalsy();
      expect(nalType(p.data.subarray(4))).toBe(1);
    }
  });

  it("produces identical packets for 1-byte and random chunks", () => {
    const run = (chunks: Uint8Array[]) => {
      const p = new AnnexBPacketizer();
      return [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
    };
    const whole = run([fixture]);
    expect(run(cut(fixture, () => 1))).toEqual(whole);
    const r = rng(99);
    expect(run(cut(fixture, () => Math.floor(r() * 300)))).toEqual(whole);
  });

  it("does not re-announce identical parameter sets", () => {
    const sps = nal(0x67);
    const pps = nal(0x68);
    const idr = nal(0x65);
    const p = new AnnexBPacketizer();
    const out = [
      ...p.push(cat(sc4(sps), sc4(pps), sc4(idr))),
      ...p.push(cat(sc4(nal(0x41)), sc4(sps), sc4(pps), sc4(nal(0x41)), sc4(sps))),
      ...p.flush(),
    ];
    expect(out.filter((x) => x.type === "configuration")).toHaveLength(1);
    // The delta after the repeated sets still decodes (the run was kept).
    expect(out.filter((x) => x.type === "data" && !x.keyframe).length).toBeGreaterThanOrEqual(1);
    // A different SPS is announced again.
    const q = new AnnexBPacketizer();
    const out2 = [
      ...q.push(cat(sc4(sps), sc4(pps), sc4(sps), sc4(nal(0x68, 9)), sc4(idr))),
      ...q.flush(),
    ];
    expect(out2.filter((x) => x.type === "configuration")).toHaveLength(2);
  });

  it("holds an IDR (and its slices) that arrives before SPS/PPS", () => {
    const idr = nal(0x65, 1);
    const slice = nal(0x41, 2);
    const sps = nal(0x67, 3);
    const pps = nal(0x68, 4);
    const p = new AnnexBPacketizer();
    // Slices before any IDR are dropped; the IDR and its slice are held.
    expect(p.push(cat(sc4(nal(0x41, 0)), sc4(idr), sc4(slice), sc4(sps)))).toEqual([]);
    const out = [...p.push(cat(sc4(pps), sc4(nal(0x41, 9)))), ...p.flush()];
    expect(out.map((x) => [x.type, (x as { keyframe?: boolean }).keyframe ?? false])).toEqual([
      ["configuration", false],
      ["data", true],
      ["data", false],
      ["data", false],
    ]);
    expect(out[1]!.data).toEqual(sc4(idr));
    expect(out[2]!.data).toEqual(sc4(slice));
  });

  it("emits nothing for an IDR that never gets SPS/PPS, or an SPS without PPS", () => {
    const p = new AnnexBPacketizer();
    expect(p.push(cat(sc4(nal(0x65)), sc4(nal(0x41)), sc4(nal(0x67)), sc4(nal(0x65))))).toEqual([]);
    expect(p.flush()).toEqual([]);
  });

  it("bounds what it holds while waiting for a configuration", () => {
    const p = new AnnexBPacketizer(100);
    const big = new Uint8Array(200).fill(1);
    big[0] = 0x41;
    const out = [
      ...p.push(cat(sc4(nal(0x65)), sc4(big), sc4(nal(0x67)), sc4(nal(0x68)), sc4(nal(0x41)))),
      ...p.flush(),
    ];
    // The held run overflowed and was dropped: only the configuration emerges.
    expect(out.map((x) => x.type)).toEqual(["configuration"]);
  });

  it("drops SEI/AUD and deltas before the first IDR after a configuration", () => {
    const p = new AnnexBPacketizer();
    const out = [
      ...p.push(
        cat(
          sc4(nal(0x67)),
          sc4(nal(0x68)),
          sc4(nal(0x41)),
          sc4(nal(0x06)),
          sc4(nal(0x09)),
          sc4(nal(0x65)),
          sc4(nal(0x41, 1)),
        ),
      ),
      ...p.flush(),
    ];
    expect(out.map((x) => x.type)).toEqual(["configuration", "data", "data"]);
    expect((out[1] as { keyframe?: boolean }).keyframe).toBe(true);
  });
});

describe("GopBuffer", () => {
  const config: DeviceVideoPacket = { type: "configuration", data: new Uint8Array(10) };
  const idr = (n = 100): DeviceVideoPacket => ({
    type: "data",
    keyframe: true,
    data: new Uint8Array(n),
  });
  const delta = (n = 100): DeviceVideoPacket => ({ type: "data", data: new Uint8Array(n) });

  it("is empty until a configuration arrives", () => {
    const g = new GopBuffer();
    g.push(idr());
    expect(g.snapshot()).toEqual([]);
  });

  it("replays config, the last IDR and every delta since", () => {
    const g = new GopBuffer();
    const last = idr(7);
    const d1 = delta(1);
    const d2 = delta(2);
    g.push(config);
    g.push(delta()); // no IDR yet: ignored
    g.push(idr());
    g.push(delta());
    g.push(last);
    g.push(d1);
    g.push(d2);
    expect(g.snapshot()).toEqual([config, last, d1, d2]);
  });

  it("drops an overflowing GOP and keeps nothing until the next IDR", () => {
    const g = new GopBuffer(250);
    g.push(config);
    g.push(idr(100));
    g.push(delta(100));
    g.push(delta(100)); // 300 > 250: the GOP is dropped
    expect(g.snapshot()).toEqual([config]);
    g.push(delta(10)); // still no IDR to hang it on
    expect(g.snapshot()).toEqual([config]);
    const next = idr(100);
    g.push(next);
    g.push(delta(50));
    expect(g.snapshot()).toHaveLength(3);
    expect(g.snapshot()[1]).toBe(next);
  });

  it("never holds more than the cap", () => {
    const g = new GopBuffer(1000);
    g.push(config);
    g.push(idr(100));
    for (let i = 0; i < 100; i++) g.push(delta(100));
    const bytes = g
      .snapshot()
      .slice(1)
      .reduce((n, p) => n + p.data.length, 0);
    expect(bytes).toBeLessThanOrEqual(1000);
  });

  it("a new configuration discards frames of the old one", () => {
    const g = new GopBuffer();
    g.push(config);
    g.push(idr());
    const config2: DeviceVideoPacket = { type: "configuration", data: new Uint8Array(3) };
    g.push(config2);
    expect(g.snapshot()).toEqual([config2]);
    g.clear();
    expect(g.snapshot()).toEqual([]);
  });
});
