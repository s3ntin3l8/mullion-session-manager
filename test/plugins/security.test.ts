import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";

describe("security plugin", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.CORS_ORIGIN;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("sets security headers from helmet", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    await app.close();
  });

  it("allows framing any http(s) origin by default (direct-embed browser pane, no PREVIEW_BASE_HOST)", async () => {
    // With no subdomain preview proxy configured, BrowserPanel.tsx embeds a
    // project's dev server / an external URL directly — this is the CSP
    // allowance that makes that possible. Deliberately broad (any origin,
    // not a specific host — there's no fixed set of dev-server/external
    // URLs to allowlist), but scoped to frame-src only: it does not affect
    // frame-ancestors (who may embed this app), so it isn't a same-origin
    // exposure.
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/frame-src [^;]*'self'/);
    expect(csp).toMatch(/frame-src [^;]*\bhttp:/);
    expect(csp).toMatch(/frame-src [^;]*\bhttps:/);
    await app.close();
  });

  it("allows framing the preview subdomain once PREVIEW_BASE_HOST is set (issue #28)", async () => {
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/frame-src [^;]*'self'/);
    expect(csp).toContain("http://*.preview.example.com");
    expect(csp).toContain("https://*.preview.example.com");
    await app.close();
  });

  it("rate-limits requests beyond the configured max", async () => {
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildApp();

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });
    const third = await app.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    await app.close();
  });

  it("reflects an allowlisted CORS origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    await app.close();
  });
});
