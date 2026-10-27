import { describe, it, expect } from "vitest";
import { extractPng } from "../../src/routes/devices.js";

const IEND = [0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0];
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("extractPng", () => {
  it("passes a clean PNG through unchanged", () => {
    const png = Uint8Array.from([...SIG, 1, 2, 3, ...IEND]);
    expect(Array.from(extractPng(png)!)).toEqual(Array.from(png));
  });

  it("strips a leading warning", () => {
    const png = [...SIG, 9, 9, ...IEND];
    const out = extractPng(
      Buffer.concat([Buffer.from("[Warning] Multiple displays\n"), Buffer.from(png)]),
    );
    expect(Array.from(out!)).toEqual(png);
  });

  it("returns null when there is no PNG signature", () => {
    expect(extractPng(Buffer.from("error: nope"))).toBeNull();
    expect(extractPng(new Uint8Array())).toBeNull();
  });

  it("rejects a truncated PNG (signature but no IEND)", () => {
    expect(extractPng(Uint8Array.from([...SIG, 1, 2, 3]))).toBeNull();
  });

  it("honours byteOffset on a view into a pooled buffer", () => {
    const pool = Buffer.alloc(64, 0x41);
    const png = Buffer.from([...SIG, 7, ...IEND]);
    png.copy(pool, 10);
    const view = pool.subarray(5, 10 + png.length);
    expect(Array.from(extractPng(view)!)).toEqual(Array.from(png));
  });
});
