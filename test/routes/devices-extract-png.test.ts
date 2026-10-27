import { describe, it, expect } from "vitest";
import { extractPng } from "../../src/routes/devices.js";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("extractPng", () => {
  it("passes a clean PNG through unchanged", () => {
    const png = Uint8Array.from([...SIG, 1, 2, 3]);
    expect(Array.from(extractPng(png)!)).toEqual(Array.from(png));
  });

  it("strips a leading warning", () => {
    const png = [...SIG, 9, 9];
    const out = extractPng(
      Buffer.concat([Buffer.from("[Warning] Multiple displays\n"), Buffer.from(png)]),
    );
    expect(Array.from(out!)).toEqual(png);
  });

  it("returns null when there is no PNG signature", () => {
    expect(extractPng(Buffer.from("error: nope"))).toBeNull();
    expect(extractPng(new Uint8Array())).toBeNull();
  });
});
