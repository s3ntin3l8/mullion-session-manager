import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { buildTestApp } from "../helpers/app.js";
import { uniqueDir } from "../helpers/tmpdir.js";

describe("staticPlugin", () => {
  const originalFrontendDist = process.env.FRONTEND_DIST;
  let tmpDist: string | undefined;

  afterEach(() => {
    if (tmpDist) fs.rmSync(tmpDist, { recursive: true, force: true });
    tmpDist = undefined;
    process.env.FRONTEND_DIST = originalFrontendDist;
  });

  it("serves the built frontend at / instead of the placeholder, once it exists", async () => {
    tmpDist = uniqueDir("static-plugin-test-");
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildTestApp();

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("the real frontend");
  });

  // Perf audit finding A4 — content-hashed /assets/* files are safe to
  // cache forever (Vite never reuses a filename for different content);
  // index.html and sw.js must stay revalidated on every request so a
  // deploy's new content-hash URLs and the VitePWA autoUpdate flow both
  // still work (see static.ts's own doc comment).
  it("gives /assets/* a long, immutable cache lifetime but leaves index.html/sw.js at max-age=0", async () => {
    tmpDist = uniqueDir("static-plugin-test-");
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    fs.writeFileSync(path.join(tmpDist, "sw.js"), "// service worker");
    fs.mkdirSync(path.join(tmpDist, "assets"));
    fs.writeFileSync(path.join(tmpDist, "assets", "index-abc123.js"), "console.log('hi')");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildTestApp();

    const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).not.toContain("immutable");
    expect(index.headers["cache-control"]).toContain("max-age=0");

    const sw = await app.inject({ method: "GET", url: "/sw.js" });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers["cache-control"]).not.toContain("immutable");
    expect(sw.headers["cache-control"]).toContain("max-age=0");
  });

  // Regression for a substring-match bug caught in review: an earlier
  // version checked `filePath.includes(path.sep + "assets" + path.sep)`
  // against the full filesystem path, which would wrongly match index.html
  // if FRONTEND_DIST itself sat under a directory containing an "assets"
  // path segment (e.g. `/srv/assets/mullion-dist`). Root the temp dist dir
  // under a directory literally named "assets" to exercise exactly that.
  it("does not treat index.html as a long-cache asset even when FRONTEND_DIST's own path contains an 'assets' segment", async () => {
    const assetsParent = uniqueDir("static-plugin-assets-");
    tmpDist = path.join(assetsParent, "assets", "dist");
    fs.mkdirSync(tmpDist, { recursive: true });
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildTestApp();

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).not.toContain("immutable");
    expect(index.headers["cache-control"]).toContain("max-age=0");
    fs.rmSync(assetsParent, { recursive: true, force: true });
  });

  // Review finding — the root-relative check must scope to the TOP-LEVEL
  // `assets/` directory only, not "any directory literally named assets
  // anywhere under the dist tree". A nested, non-content-hashed `assets/`
  // dir (e.g. under some other served subpath) would go stale forever if
  // it wrongly picked up the immutable long-cache header.
  it("does not give a nested, non-root assets/ directory the long-cache header — only Vite's top-level assets/ output qualifies", async () => {
    tmpDist = uniqueDir("static-plugin-nested-assets-");
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    fs.mkdirSync(path.join(tmpDist, "assets"));
    fs.writeFileSync(path.join(tmpDist, "assets", "index-abc123.js"), "console.log('hi')");
    // A hypothetical nested assets/ dir under an unrelated subpath — not
    // Vite's content-hashed build output, must NOT get immutable caching.
    fs.mkdirSync(path.join(tmpDist, "some-other-dir", "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDist, "some-other-dir", "assets", "not-hashed.js"),
      "console.log('nested')",
    );
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildTestApp();

    const rootAsset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
    expect(rootAsset.statusCode).toBe(200);
    expect(rootAsset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const nestedAsset = await app.inject({
      method: "GET",
      url: "/some-other-dir/assets/not-hashed.js",
    });
    expect(nestedAsset.statusCode).toBe(200);
    expect(nestedAsset.headers["cache-control"]).not.toContain("immutable");
    expect(nestedAsset.headers["cache-control"]).toContain("max-age=0");
  });

  // Perf audit finding A4 — @fastify/compress must actually apply to
  // @fastify/static's responses, not just be registered somewhere in the
  // app (its own docs warn registration order matters here — see app.ts's
  // comment on why it's registered before staticPlugin).
  it("compresses a static asset response when the client accepts gzip", async () => {
    tmpDist = uniqueDir("static-plugin-test-");
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    fs.mkdirSync(path.join(tmpDist, "assets"));
    // @fastify/compress's default threshold is 1024 bytes — pad well past it
    // so this isn't skipped as "too small to bother compressing".
    fs.writeFileSync(path.join(tmpDist, "assets", "big-abc123.js"), "x".repeat(5000));
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/assets/big-abc123.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
  });
});
