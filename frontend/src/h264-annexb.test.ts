import { describe, it, expect } from "vitest";
import {
  splitAnnexBNalUnits,
  deriveAvcCodecString,
  deriveAvcCodecStringFromConfig,
} from "./h264-annexb.js";

// A synthetic but structurally real Annex-B stream: SPS (baseline profile,
// 0x42/0x00/0x1f — the well-known "avc1.42001f" test-vector triple used
// throughout WebCodecs/MSE examples) followed by a PPS, each with its own
// 4-byte start code. Payload bytes after the fixed profile/constraint/level
// triple are arbitrary (exp-golomb-coded SPS fields this module never
// reads).
const SPS_NAL = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xaa, 0xbb, 0xcc]);
const PPS_NAL = new Uint8Array([0x68, 0x11, 0x22]);
const START_CODE_4 = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const CONFIG_PACKET = concat(START_CODE_4, SPS_NAL, START_CODE_4, PPS_NAL);

describe("splitAnnexBNalUnits", () => {
  it("splits a stream with 4-byte start codes into SPS + PPS", () => {
    const units = splitAnnexBNalUnits(CONFIG_PACKET);
    expect(units).toHaveLength(2);
    expect(units[0].type).toBe(7); // SPS
    expect(units[0].payload).toEqual(SPS_NAL.subarray(1));
    expect(units[1].type).toBe(8); // PPS
    expect(units[1].payload).toEqual(PPS_NAL.subarray(1));
  });

  it("also splits a stream using 3-byte start codes", () => {
    const START_CODE_3 = new Uint8Array([0x00, 0x00, 0x01]);
    const stream = concat(START_CODE_3, SPS_NAL, START_CODE_3, PPS_NAL);
    const units = splitAnnexBNalUnits(stream);
    expect(units).toHaveLength(2);
    expect(units[0].type).toBe(7);
    expect(units[1].type).toBe(8);
  });

  it("returns an empty array for a stream with no start code at all", () => {
    expect(splitAnnexBNalUnits(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
  });

  it("handles a single NAL unit with nothing following it", () => {
    const units = splitAnnexBNalUnits(concat(START_CODE_4, SPS_NAL));
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(7);
    expect(units[0].payload).toEqual(SPS_NAL.subarray(1));
  });
});

describe("deriveAvcCodecString", () => {
  it("derives the canonical avc1.42001f baseline-profile string", () => {
    expect(deriveAvcCodecString(SPS_NAL.subarray(1))).toBe("avc1.42001f");
  });

  it("pads single-digit hex bytes with a leading zero", () => {
    expect(deriveAvcCodecString(new Uint8Array([0x0a, 0x0b, 0x0c]))).toBe("avc1.0a0b0c");
  });

  it("returns null for a payload too short to contain the triple", () => {
    expect(deriveAvcCodecString(new Uint8Array([0x42, 0x00]))).toBeNull();
    expect(deriveAvcCodecString(new Uint8Array([]))).toBeNull();
  });
});

describe("deriveAvcCodecStringFromConfig", () => {
  it("finds the SPS among multiple NAL units and derives its codec string", () => {
    expect(deriveAvcCodecStringFromConfig(CONFIG_PACKET)).toBe("avc1.42001f");
  });

  it("returns null when no SPS (type 7) NAL unit is present", () => {
    expect(deriveAvcCodecStringFromConfig(concat(START_CODE_4, PPS_NAL))).toBeNull();
  });
});
