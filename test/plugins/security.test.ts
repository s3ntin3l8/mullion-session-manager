import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { CONTROL_SOCKET_ADDR } from "../../src/services/control-socket-addr.js";

describe("security plugin", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.CORS_ORIGIN;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("sets security headers from helmet", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("allows framing any http(s) origin by default (direct-embed browser pane, no PREVIEW_BASE_HOST)", async () => {
    // With no subdomain preview proxy configured, BrowserPanel.tsx embeds a
    // project's dev server / an external URL directly — this is the CSP
    // allowance that makes that possible. Deliberately broad (any origin,
    // not a specific host — there's no fixed set of dev-server/external
    // URLs to allowlist), but scoped to frame-src only: it does not affect
    // frame-ancestors (who may embed this app), so it isn't a same-origin
    // exposure.
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/frame-src [^;]*'self'/);
    expect(csp).toMatch(/frame-src [^;]*\bhttp:/);
    expect(csp).toMatch(/frame-src [^;]*\bhttps:/);
  });

  it("allows framing the preview subdomain once PREVIEW_BASE_HOST is set (issue #28)", async () => {
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/frame-src [^;]*'self'/);
    expect(csp).toContain("http://*.preview.example.com");
    expect(csp).toContain("https://*.preview.example.com");
  });

  it("blocks inline scripts (A5 — no 'unsafe-inline'/nonce/hash in script-src)", async () => {
    // Regression guard for A5: frontend/index.html's iOS status-bar theme
    // hint used to be an inline <script> block that this exact directive
    // silently killed in production (it only appeared to work under Vite's
    // dev server, which doesn't apply helmet). The fix moved the script to
    // frontend/public/theme-hint.js, loaded via <script src>, which 'self'
    // already permits — so this test intentionally keeps asserting the
    // strict directive rather than relaxing it; a future 'unsafe-inline'/
    // nonce/hash addition here should be a deliberate, reviewed decision,
    // not an accidental fix for a script that should have been externalized
    // instead (see the plan's rationale for rejecting a CSP hash: brittle
    // against Prettier reformatting silently invalidating it).
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'sha256-/);
  });

  it("rate-limits requests beyond the configured max", async () => {
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildTestApp();

    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });
    const third = await app.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it("exempts requests tagged with CONTROL_SOCKET_ADDR from rate limiting (Phase 4, #185)", async () => {
    // control-socket.ts's app.inject() dispatch tags every request with this
    // sentinel remoteAddress so a `mullion ps` polling loop isn't throttled
    // the same way a hostile HTTP client would be — see
    // control-socket-addr.ts's own comment for why a real network client can
    // never present this string as its own connection address.
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildTestApp();

    const first = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: CONTROL_SOCKET_ADDR,
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: CONTROL_SOCKET_ADDR,
    });
    const third = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: CONTROL_SOCKET_ADDR,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
  });

  it("rate-limits by raw TCP peer address, ignoring X-Forwarded-For/X-Real-Ip (B5 — trustProxy stays off)", async () => {
    // Pins the accepted trade-off documented in this plugin's rate-limit
    // registration comment and docs/auth.md's "Current limitations": with
    // `trustProxy` off, `request.ip` is always the raw connection peer —
    // simulating "two different real clients behind the same Traefik" as
    // one shared `remoteAddress` with two DIFFERENT forwarded-for headers
    // must still land in the SAME bucket. If a future change (a trustProxy
    // flip, or an unreviewed keyGenerator) starts trusting these headers,
    // this test starts failing loudly instead of the characteristic
    // drifting silently.
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildTestApp();
    const remoteAddress = "10.0.0.1"; // stand-in for "Traefik's own IP"

    const first = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress,
      headers: { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.1" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress,
      headers: { "x-forwarded-for": "203.0.113.2", "x-real-ip": "203.0.113.2" },
    });
    // A third distinct forwarded-for identity, same raw peer — still 429 if
    // (and only if) the bucket is keyed on the raw peer, not the header.
    const third = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress,
      headers: { "x-forwarded-for": "203.0.113.3", "x-real-ip": "203.0.113.3" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it("reflects an allowlisted CORS origin", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com";
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
});
