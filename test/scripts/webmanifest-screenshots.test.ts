import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `make screenshots` renders docs/screenshots (visual/scenes.json) and
// scripts/sync-pwa-screenshots.mjs copies what the manifest lists into
// frontend/public/screenshots. A renamed or resized scene must not leave the
// installed PWA pointing at a missing or wrongly sized image.

const publicDir = path.resolve(__dirname, "../../frontend/public");
const manifest = JSON.parse(readFileSync(path.join(publicDir, "site.webmanifest"), "utf8")) as {
  screenshots: { src: string; sizes: string; type: string; form_factor: string }[];
};

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (file: string) => {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
};

describe("site.webmanifest screenshots", () => {
  it("lists images that exist and are the size the manifest declares", () => {
    expect(manifest.screenshots.length).toBeGreaterThan(0);
    for (const s of manifest.screenshots) {
      const file = path.join(publicDir, s.src);
      expect(existsSync(file), `${s.src} is missing`).toBe(true);
      expect(pngSize(file), s.src).toBe(s.sizes);
    }
  });

  it("stays inside what Chrome's install UI accepts", () => {
    for (const factor of ["wide", "narrow"]) {
      const shots = manifest.screenshots.filter((s) => s.form_factor === factor);
      expect(shots.length).toBeLessThanOrEqual(8);
      for (const s of shots) {
        const [w, h] = s.sizes.split("x").map(Number);
        expect(Math.min(w, h)).toBeGreaterThanOrEqual(320);
        expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
        expect(Math.max(w, h) / Math.min(w, h)).toBeLessThanOrEqual(2.3);
      }
    }
  });
});
