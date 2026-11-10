// Downscale an Android `screencap -p` PNG to a JPEG (issue #2884).
//
// Pure JS on purpose: PNG decoding rides on node:zlib and JPEG encoding on
// `jpeg-js` (no native module), so it builds on every supported host (Linux,
// macOS, Windows agent) without a prebuilt-binary matrix.
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";

const JPEG_QUALITY = 80;

export interface ScreenshotImage {
  mimeType: "image/png" | "image/jpeg";
  data: Uint8Array;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

/** Width/height from the IHDR chunk, or null when the buffer is not a PNG. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24) return null;
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what `screencap -p` emits).
 * Returns null for anything else so the caller falls back to the native PNG. */
export function decodePng(png: Uint8Array): Pixels | null {
  const dims = pngDimensions(png);
  if (!dims) return null;
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
  const channels = colorType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) return null;
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === "IEND") break;
    pos += 12 + len;
  }
  if (idat.length === 0) return null;

  const { width, height } = dims;
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-scanline filters in place.
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[dst - stride + i - channels] : 0;
      let v = raw[src + i];
      switch (filter) {
        case 0:
          break;
        case 1:
          v += a;
          break;
        case 2:
          v += b;
          break;
        case 3:
          v += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          return null;
      }
      out[dst + i] = v & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = out[p * 3];
    rgba[p * 4 + 1] = out[p * 3 + 1];
    rgba[p * 4 + 2] = out[p * 3 + 2];
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Box-filter downscale (area average) — sharp enough for UI text. */
export function boxDownscale(src: Pixels, width: number, height: number): Pixels {
  const rgba = new Uint8Array(width * height * 4);
  const xRatio = src.width / width;
  const yRatio = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.rgba[i];
          g += src.rgba[i + 1];
          b += src.rgba[i + 2];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Shape a validated PNG for the caller. `maxWidth` undefined/<=0, or at least
 * the native width, returns the native PNG untouched; otherwise the image is
 * downscaled to `maxWidth` (aspect preserved) and JPEG-encoded. A PNG this
 * decoder does not handle (16-bit, palette, interlaced) falls back to native.
 */
export function shapeScreenshot(png: Uint8Array, maxWidth: number | undefined): ScreenshotImage {
  const dims = pngDimensions(png);
  if (!dims) throw new Error("not a PNG");
  const native: ScreenshotImage = {
    mimeType: "image/png",
    data: png,
    width: dims.width,
    height: dims.height,
    nativeWidth: dims.width,
    nativeHeight: dims.height,
  };
  if (!maxWidth || maxWidth <= 0 || maxWidth >= dims.width) return native;
  const decoded = decodePng(png);
  if (!decoded) return native;
  const width = Math.max(1, Math.floor(maxWidth));
  const height = Math.max(1, Math.round((dims.height * width) / dims.width));
  const scaled = boxDownscale(decoded, width, height);
  const encoded = jpeg.encode({ data: Buffer.from(scaled.rgba), width, height }, JPEG_QUALITY);
  return {
    mimeType: "image/jpeg",
    data: encoded.data,
    width,
    height,
    nativeWidth: dims.width,
    nativeHeight: dims.height,
  };
}
