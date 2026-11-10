import { describe, it, expect } from "vitest";
import jpeg from "jpeg-js";
import { decodePng, pngDimensions, shapeScreenshot } from "../../src/services/screenshot-image.js";
import { makeFilteredRgbPng, makePng } from "../helpers/png.js";

describe("screenshot-image", () => {
  it("reads dimensions and decodes pixels", () => {
    const png = makePng(8, 4);
    expect(pngDimensions(png)).toEqual({ width: 8, height: 4 });
    const px = decodePng(png)!;
    expect(Array.from(px.rgba.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(px.rgba.subarray(7 * 4, 7 * 4 + 4))).toEqual([0, 0, 255, 255]);
  });

  it("returns null dimensions for non-PNG bytes", () => {
    expect(pngDimensions(Buffer.from("nope"))).toBeNull();
  });

  it("downscales to a JPEG keeping aspect ratio", () => {
    const out = shapeScreenshot(makePng(40, 20), 20);
    expect(out).toMatchObject({ mimeType: "image/jpeg", width: 20, height: 10, nativeWidth: 40 });
    const dec = jpeg.decode(Buffer.from(out.data));
    expect(dec.width).toBe(20);
    expect(dec.height).toBe(10);
    expect(dec.data[0]).toBeGreaterThan(200); // red on the left
  });

  it("returns the native PNG for 0, undefined or a width >= native", () => {
    const png = makePng(40, 20);
    for (const w of [0, undefined, 40, 100]) {
      const out = shapeScreenshot(png, w);
      expect(out.mimeType).toBe("image/png");
      expect(out.data).toBe(png);
    }
  });

  it("falls back to native for PNGs it cannot decode (16-bit)", () => {
    const png = Buffer.from(makePng(40, 20));
    png[24] = 16;
    expect(shapeScreenshot(png, 10).mimeType).toBe("image/png");
  });

  it("decodes RGB PNGs through every scanline filter", () => {
    const pixels = [
      [
        [10, 20, 30],
        [200, 100, 50],
        [5, 6, 7],
      ],
      [
        [40, 50, 60],
        [70, 80, 90],
        [250, 1, 2],
      ],
      [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      [
        [90, 80, 70],
        [60, 50, 40],
        [30, 20, 10],
      ],
      [
        [11, 22, 33],
        [44, 55, 66],
        [77, 88, 99],
      ],
    ];
    const png = makeFilteredRgbPng(pixels, [1, 2, 3, 4, 0]);
    const px = decodePng(png)!;
    const got = [];
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) {
        const o = (y * 3 + x) * 4;
        got.push([px.rgba[o], px.rgba[o + 1], px.rgba[o + 2]]);
      }
    expect(got).toEqual(pixels.flat());
  });
});

describe("pngDimensions signature check", () => {
  it("rejects bytes with IHDR at offset 12 but no PNG signature", () => {
    const fake = Buffer.from(makePng(8, 4));
    fake[0] = 0;
    expect(pngDimensions(fake)).toBeNull();
  });
});
