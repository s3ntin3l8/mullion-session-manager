import { describe, it, expect } from "vitest";

// Issue #87 — index.html's apple-touch-startup-image hrefs are a hand-pasted
// copy of `npm run generate-pwa-assets`'s output (frontend/pwa-assets.config.ts).
// A future regeneration with a different device/size matrix (an
// assets-generator version bump, a changed `createAppleSplashScreens`
// filter) can silently leave stale hrefs behind — iOS just shows no splash
// for that entry rather than erroring. This asserts every declared href
// resolves to an actual public/ file, so drift fails CI instead of failing
// silently on a real device.
//
// import.meta.glob (rather than node:fs) keeps this file within
// tsconfig.app.json's browser-only type universe — no other src/ file
// imports "node:*" modules, since that tsconfig deliberately omits Node's
// global types (see tsconfig.node.json's contrasting "types": ["node"],
// reserved for vite.config.ts).
const [indexHtml] = Object.values(
  import.meta.glob("../index.html", { eager: true, query: "?raw", import: "default" }),
) as [string];
const splashFiles = import.meta.glob("../public/apple-splash-*.png");
const availableFiles = new Set(
  Object.keys(splashFiles).map((filePath) => filePath.split("/").pop()),
);

describe("apple-touch-startup-image links", () => {
  const hrefs = [...indexHtml.matchAll(/rel="apple-touch-startup-image"[^>]*href="([^"]+)"/g)].map(
    (match) => match[1],
  );

  it("declares at least one splash-screen link", () => {
    expect(hrefs.length).toBeGreaterThan(0);
  });

  it.each(hrefs)("%s resolves to a file under public/", (href) => {
    expect(availableFiles.has(href.replace(/^\//, ""))).toBe(true);
  });
});
