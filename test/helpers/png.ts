import { deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 8-bit RGBA PNG (left half red, right half blue), as `screencap -p` emits. */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const o = 1 + x * 4;
      const left = x < width / 2;
      row[o] = left ? 255 : 0;
      row[o + 2] = left ? 0 : 255;
      row[o + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** RGB (3-channel) PNG from raw pixel rows, applying filter `filters[y]` to each row. */
export function makeFilteredRgbPng(pixels: number[][][], filters: number[]): Buffer {
  const height = pixels.length;
  const width = pixels[0].length;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const flat = pixels.map((row) => row.flat());
  const rows = flat.map((cur, y) => {
    const prev = y > 0 ? flat[y - 1] : cur.map(() => 0);
    const out = Buffer.alloc(1 + cur.length);
    out[0] = filters[y];
    for (let i = 0; i < cur.length; i++) {
      const a = i >= 3 ? cur[i - 3] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = y > 0 && i >= 3 ? prev[i - 3] : 0;
      let pred = 0;
      if (filters[y] === 1) pred = a;
      else if (filters[y] === 2) pred = b;
      else if (filters[y] === 3) pred = (a + b) >> 1;
      else if (filters[y] === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[1 + i] = (cur[i] - pred) & 0xff;
    }
    return out;
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
