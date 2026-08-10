import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";

describe("staticPlugin", () => {
  const originalFrontendDist = process.env.FRONTEND_DIST;
  let tmpDist: string | undefined;

  afterEach(() => {
    if (tmpDist) fs.rmSync(tmpDist, { recursive: true, force: true });
    tmpDist = undefined;
    process.env.FRONTEND_DIST = originalFrontendDist;
  });

  it("serves the built frontend at / instead of the placeholder, once it exists", async () => {
    tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), "static-plugin-test-"));
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("the real frontend");

    await app.close();
  });

  // Perf audit finding A4 — content-hashed /assets/* files are safe to
  // cache forever (Vite never reuses a filename for different content);
  // index.html and sw.js must stay revalidated on every request so a
  // deploy's new content-hash URLs and the VitePWA autoUpdate flow both
  // still work (see static.ts's own doc comment).
  it("gives /assets/* a long, immutable cache lifetime but leaves index.html/sw.js at max-age=0", async () => {
    tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), "static-plugin-test-"));
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    fs.writeFileSync(path.join(tmpDist, "sw.js"), "// service worker");
    fs.mkdirSync(path.join(tmpDist, "assets"));
    fs.writeFileSync(path.join(tmpDist, "assets", "index-abc123.js"), "console.log('hi')");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildApp();

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

    await app.close();
  });

  // Regression for a substring-match bug caught in review: an earlier
  // version checked `filePath.includes(path.sep + "assets" + path.sep)`
  // against the full filesystem path, which would wrongly match index.html
  // if FRONTEND_DIST itself sat under a directory containing an "assets"
  // path segment (e.g. `/srv/assets/mullion-dist`). Root the temp dist dir
  // under a directory literally named "assets" to exercise exactly that.
  it("does not treat index.html as a long-cache asset even when FRONTEND_DIST's own path contains an 'assets' segment", async () => {
    const assetsParent = fs.mkdtempSync(path.join(os.tmpdir(), "static-plugin-assets-"));
    tmpDist = path.join(assetsParent, "assets", "dist");
    fs.mkdirSync(tmpDist, { recursive: true });
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildApp();

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).not.toContain("immutable");
    expect(index.headers["cache-control"]).toContain("max-age=0");

    await app.close();
    fs.rmSync(assetsParent, { recursive: true, force: true });
  });

  // Perf audit finding A4 — @fastify/compress must actually apply to
  // @fastify/static's responses, not just be registered somewhere in the
  // app (its own docs warn registration order matters here — see app.ts's
  // comment on why it's registered before staticPlugin).
  it("compresses a static asset response when the client accepts gzip", async () => {
    tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), "static-plugin-test-"));
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    fs.mkdirSync(path.join(tmpDist, "assets"));
    // @fastify/compress's default threshold is 1024 bytes — pad well past it
    // so this isn't skipped as "too small to bother compressing".
    fs.writeFileSync(path.join(tmpDist, "assets", "big-abc123.js"), "x".repeat(5000));
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/assets/big-abc123.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");

    await app.close();
  });
});
