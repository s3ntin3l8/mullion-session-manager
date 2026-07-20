import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  createOidcTxnCookieValue,
  createSessionCookieValue,
  OIDC_TXN_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../../src/services/auth.js";
import type * as OidcService from "../../src/services/oidc.js";

// buildOidcAuthorizationUrl/completeOidcLogin talk to a real OIDC provider
// over the network (via services/oidc.ts's openid-client wiring, itself
// unit-tested with openid-client mocked in test/services/oidc.test.ts) —
// mocked here so these route-level tests exercise routes/auth.ts's own
// cookie/redirect plumbing around them without a live IdP. isOidcEnabled/
// isOidcConfigPartial are left real (spread from importOriginal) since
// isAuthEnabled/getAuthMethods and src/app.ts's boot check depend on their
// real behavior across every describe block in this file, not just the
// OIDC-specific ones below. vi.mock's factory is hoisted above every
// import/const in this file, so the mock functions themselves must be
// created via vi.hoisted().
const { buildOidcAuthorizationUrlMock, completeOidcLoginMock } = vi.hoisted(() => ({
  buildOidcAuthorizationUrlMock: vi.fn(),
  completeOidcLoginMock: vi.fn(),
}));
vi.mock("../../src/services/oidc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OidcService>();
  return {
    ...actual,
    buildOidcAuthorizationUrl: buildOidcAuthorizationUrlMock,
    completeOidcLogin: completeOidcLoginMock,
  };
});

// Issue #19's optional in-process auth: a single shared token, checked via
// src/plugins/auth.ts's global onRequest hook, plus its POST
// /api/auth/login|logout and GET /api/auth/me routes (src/routes/auth.ts).
// Issue #30's native OIDC login extends the same routes file with GET
// /api/auth/oidc/login|callback — see the dedicated describe blocks near
// the bottom of this file. The /ws/terminal upgrade's own real-socket
// coverage lives alongside test/routes/terminal.test.ts's existing
// PTY-mocking infrastructure instead of here (see that file's own
// "in-process auth gate" describe block) — this file covers everything
// reachable via app.inject().

const TEST_TOKEN = "test-auth-token-0123456789";
const TEST_SECRET = "test-session-secret-0123456789";
const TEST_OIDC_ISSUER = "https://idp.test";
const TEST_OIDC_CLIENT_ID = "test-oidc-client-id";
const TEST_OIDC_CLIENT_SECRET = "test-oidc-client-secret";
const TEST_OIDC_REDIRECT_URI = "https://tessera.test/api/auth/oidc/callback";

describe("auth plugin + routes (issues #19, #30)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.TESSERA_AUTH_TOKEN;
    delete process.env.TESSERA_SESSION_SECRET;
    delete process.env.PREVIEW_BASE_HOST;
    delete process.env.TESSERA_OIDC_ISSUER;
    delete process.env.TESSERA_OIDC_CLIENT_ID;
    delete process.env.TESSERA_OIDC_CLIENT_SECRET;
    delete process.env.TESSERA_OIDC_REDIRECT_URI;
  });

  describe("auth disabled (default — TESSERA_AUTH_TOKEN unset)", () => {
    it("leaves every route reachable with no credential, unchanged from before this feature existed", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("GET /api/auth/me reports both methods false, authenticated: true", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.json()).toEqual({
        methods: { token: false, oidc: false },
        authenticated: true,
      });
      await app.close();
    });

    it("404s GET /api/auth/oidc/login when OIDC isn't configured either", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
      expect(res.statusCode).toBe(404);
      expect(buildOidcAuthorizationUrlMock).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe("auth enabled (TESSERA_AUTH_TOKEN set)", () => {
    beforeEach(() => {
      process.env.TESSERA_AUTH_TOKEN = TEST_TOKEN;
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
    });

    it("refuses to boot if TESSERA_SESSION_SECRET is missing — an unsigned session cookie would be forgeable", async () => {
      delete process.env.TESSERA_SESSION_SECRET;
      await expect(buildApp()).rejects.toThrow(/TESSERA_SESSION_SECRET/);
    });

    it("401s a protected API route with no credential", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("401s the /ws/terminal path itself (pre-upgrade) with no credential", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/ws/terminal?sessionId=1" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("allows /health without a credential — infrastructure, not product surface", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("allows GET / without a credential — the SPA shell has to load before it can call /api/auth/me", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("200s a protected route with a valid bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("401s a protected route with a wrong bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    describe("POST /api/auth/login", () => {
      it("is itself reachable with no credential — a gate can't block the endpoint that satisfies it", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { token: "wrong" },
        });
        // 401 for the *wrong token*, not for missing auth on the route itself.
        expect(res.statusCode).toBe(401);
        await app.close();
      });

      it("sets a session cookie for a valid token, which then authenticates subsequent requests", async () => {
        const app = await buildApp();
        const loginRes = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { token: TEST_TOKEN },
        });
        expect(loginRes.statusCode).toBe(204);
        const cookie = loginRes.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
        expect(cookie).toBeDefined();
        expect(cookie?.httpOnly).toBe(true);
        expect(cookie?.sameSite).toBe("Lax");

        const res = await app.inject({
          method: "GET",
          url: "/api/projects",
          cookies: { [SESSION_COOKIE_NAME]: cookie!.value },
        });
        expect(res.statusCode).toBe(200);
        await app.close();
      });

      it("is rate-limited independently of RATE_LIMIT_MAX — a dedicated brute-force bound (CodeQL js/missing-rate-limiting)", async () => {
        const app = await buildApp();
        // src/routes/auth.ts's LOGIN_RATE_LIMIT caps this route at 10/min
        // regardless of the app-wide default, since a request that only
        // ever hits this one route could otherwise spend that whole budget
        // guessing tokens.
        for (let i = 0; i < 10; i++) {
          const res = await app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { token: "wrong" },
          });
          expect(res.statusCode).toBe(401);
        }
        const eleventh = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { token: TEST_TOKEN },
        });
        expect(eleventh.statusCode).toBe(429);
        await app.close();
      });
    });

    describe("POST /api/auth/logout", () => {
      it("clears the session cookie", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          cookies: { [SESSION_COOKIE_NAME]: createSessionCookieValue(TEST_SECRET) },
        });
        expect(res.statusCode).toBe(204);
        const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
        expect(cookie?.value).toBe("");
        await app.close();
      });
    });

    describe("GET /api/auth/me", () => {
      it("reports authenticated: true via a valid session cookie", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          cookies: { [SESSION_COOKIE_NAME]: createSessionCookieValue(TEST_SECRET) },
        });
        expect(res.json()).toEqual({
          methods: { token: true, oidc: false },
          authenticated: true,
        });
        await app.close();
      });

      it("reports authenticated: false with no credential", async () => {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/api/auth/me" });
        expect(res.json()).toEqual({
          methods: { token: true, oidc: false },
          authenticated: false,
        });
        await app.close();
      });

      it("reports authenticated: false for a tampered session cookie", async () => {
        const app = await buildApp();
        const tampered = createSessionCookieValue(TEST_SECRET) + "x";
        const res = await app.inject({
          method: "GET",
          url: "/api/auth/me",
          cookies: { [SESSION_COOKIE_NAME]: tampered },
        });
        expect(res.json()).toEqual({
          methods: { token: true, oidc: false },
          authenticated: false,
        });
        await app.close();
      });
    });

    describe("preview-host exemption (see src/plugins/auth.ts's own doc comment on why)", () => {
      beforeEach(() => {
        process.env.PREVIEW_BASE_HOST = "preview.test";
      });

      it("does not gate a GET preview-host request, even against an /api/ path, with no credential", async () => {
        const app = await buildApp();
        // No preview is registered for this slug — previewProxyPlugin's own
        // onRequest hook resolves it and 404s "Unknown preview". A 401 here
        // would mean the auth gate (registered earlier) intercepted first;
        // a 404 instead proves it recognized the preview Host header and
        // got out of the way, letting previewProxyPlugin's hook run — even
        // though the path (/api/whatever) would otherwise be gated. GET is
        // the method previewProxyPlugin actually serves — see the sibling
        // "does not extend the preview-host bypass to non-GET/HEAD" test
        // below for why this can't extend to every method.
        const res = await app.inject({
          method: "GET",
          url: "/api/whatever",
          headers: { host: "preview-nonexistent.preview.test" },
        });
        expect(res.statusCode).toBe(404);
        await app.close();
      });

      it("does not extend the preview-host bypass to non-GET/HEAD methods — the fix for a real auth-bypass found in review", async () => {
        // previewProxyPlugin's own onRequest hook only ever serves GET/HEAD
        // (preview-proxy.ts). request.headers.host is fully attacker-
        // controlled, so a bypass keyed on Host alone (regardless of method)
        // would let a forged `Host: preview-x.<PREVIEW_BASE_HOST>` on a
        // state-changing request fall straight through to the real /api/*
        // handler with no credential check at all — previewProxyPlugin
        // never touches non-GET/HEAD requests either, so nothing else would
        // catch it. Exercises the actual state-changing routes these
        // methods gate, not just a bare /api/whatever placeholder, so a
        // regression here would mean a real unauthenticated write, not a
        // hypothetical one.
        const app = await buildApp();
        const previewHeaders = { host: "preview-nonexistent.preview.test" };

        const post = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: previewHeaders,
          payload: { name: "p", cwd: "/tmp" },
        });
        expect(post.statusCode).toBe(401);

        const patch = await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: previewHeaders,
          payload: {},
        });
        expect(patch.statusCode).toBe(401);

        const del = await app.inject({
          method: "DELETE",
          url: "/api/projects/1",
          headers: previewHeaders,
        });
        expect(del.statusCode).toBe(401);

        await app.close();
      });

      it("still gates a normal (non-preview) request to the same path", async () => {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/api/whatever" });
        expect(res.statusCode).toBe(401);
        await app.close();
      });
    });
  });

  describe("OIDC boot invariants (issue #30)", () => {
    it("refuses to boot with OIDC fully configured but no TESSERA_SESSION_SECRET", async () => {
      process.env.TESSERA_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.TESSERA_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.TESSERA_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.TESSERA_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      await expect(buildApp()).rejects.toThrow(/TESSERA_SESSION_SECRET/);
    });

    it("refuses to boot with only some TESSERA_OIDC_* keys set, even with a session secret", async () => {
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
      process.env.TESSERA_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.TESSERA_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      // TESSERA_OIDC_CLIENT_SECRET and TESSERA_OIDC_REDIRECT_URI left unset.
      await expect(buildApp()).rejects.toThrow(/TESSERA_OIDC_/);
    });

    it("boots fine with every TESSERA_OIDC_* key and TESSERA_SESSION_SECRET set", async () => {
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
      process.env.TESSERA_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.TESSERA_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.TESSERA_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.TESSERA_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      const app = await buildApp();
      await app.close();
    });
  });

  describe("GET /api/auth/oidc/login (issue #30)", () => {
    beforeEach(() => {
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
      process.env.TESSERA_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.TESSERA_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.TESSERA_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.TESSERA_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
    });

    it("redirects to the provider's authorization URL and sets a short-lived signed txn cookie", async () => {
      // This also doubles as the "OIDC routes stay reachable with no
      // credential" regression test for the /api/auth/ prefix exemption in
      // src/plugins/auth.ts — OIDC being configured turns the gate ON, so a
      // 401 here (instead of the expected 302) would mean that exemption
      // doesn't cover /api/auth/oidc/* the way it covers /api/auth/login.
      buildOidcAuthorizationUrlMock.mockResolvedValue({
        url: new URL("https://idp.test/authorize?client_id=test-oidc-client-id&state=state-1"),
        codeVerifier: "verifier-1",
        state: "state-1",
        nonce: "nonce-1",
      });
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        "https://idp.test/authorize?client_id=test-oidc-client-id&state=state-1",
      );

      const txnCookie = res.cookies.find((c) => c.name === OIDC_TXN_COOKIE_NAME);
      expect(txnCookie).toBeDefined();
      expect(txnCookie?.httpOnly).toBe(true);
      expect(txnCookie?.sameSite).toBe("Lax");
      await app.close();
    });
  });

  describe("GET /api/auth/oidc/callback (issue #30)", () => {
    beforeEach(() => {
      process.env.TESSERA_SESSION_SECRET = TEST_SECRET;
      process.env.TESSERA_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.TESSERA_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.TESSERA_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.TESSERA_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
    });

    function txnCookie() {
      return createOidcTxnCookieValue(TEST_SECRET, {
        codeVerifier: "verifier-1",
        state: "state-1",
        nonce: "nonce-1",
      });
    }

    it("mints a session cookie carrying the returned identity and redirects to /", async () => {
      completeOidcLoginMock.mockResolvedValue({
        sub: "user-1",
        email: "user@example.com",
        name: "User One",
      });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/callback?code=abc&state=state-1",
        cookies: { [OIDC_TXN_COOKIE_NAME]: txnCookie() },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");

      const [, currentUrl] = completeOidcLoginMock.mock.calls[0];
      expect(currentUrl.href).toBe(
        "https://tessera.test/api/auth/oidc/callback?code=abc&state=state-1",
      );

      const sessionCookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const clearedTxn = res.cookies.find((c) => c.name === OIDC_TXN_COOKIE_NAME);
      expect(clearedTxn?.value).toBe("");

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [SESSION_COOKIE_NAME]: sessionCookie!.value },
      });
      expect(meRes.json()).toEqual({
        methods: { token: false, oidc: true },
        authenticated: true,
        user: { sub: "user-1", email: "user@example.com", name: "User One" },
      });
      await app.close();
    });

    it("sends the configured TESSERA_OIDC_REDIRECT_URI's own path, not request.url's, to the token exchange — regression for a reverse-proxy path-rewrite bug found in review", async () => {
      // A reverse proxy that strips a path prefix (e.g. Traefik mounting
      // this app under /some-prefix and rewriting it away before the
      // request reaches this process) would make Fastify's own
      // request.url disagree with the *externally* registered
      // TESSERA_OIDC_REDIRECT_URI path. openid-client derives the
      // redirect_uri it sends to the token endpoint from currentUrl's own
      // path — building currentUrl from request.url's path (instead of
      // the configured URI's) would silently send the wrong redirect_uri
      // and get rejected by the IdP. This route is always registered at
      // the literal "/api/auth/oidc/callback" path regardless of what
      // TESSERA_OIDC_REDIRECT_URI is configured to, so setting it to a
      // different path here reproduces exactly that proxy-rewrite
      // scenario without needing an actual proxy in the test.
      process.env.TESSERA_OIDC_REDIRECT_URI =
        "https://tessera.test/some-prefix/api/auth/oidc/callback";
      completeOidcLoginMock.mockResolvedValue({ sub: "user-1" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/callback?code=abc&state=state-1",
        cookies: { [OIDC_TXN_COOKIE_NAME]: txnCookie() },
      });
      expect(res.statusCode).toBe(302);

      const [, currentUrl] = completeOidcLoginMock.mock.calls[0];
      expect(currentUrl.href).toBe(
        "https://tessera.test/some-prefix/api/auth/oidc/callback?code=abc&state=state-1",
      );
      await app.close();
    });

    it("redirects to / without minting a session when the txn cookie is missing", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/callback?code=abc&state=state-1",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)).toBeUndefined();
      expect(completeOidcLoginMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("redirects to / without minting a session when the exchange fails (state/nonce mismatch)", async () => {
      completeOidcLoginMock.mockRejectedValue(new Error("state mismatch"));
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/callback?code=abc&state=wrong",
        cookies: { [OIDC_TXN_COOKIE_NAME]: txnCookie() },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)).toBeUndefined();
      await app.close();
    });

    it("never echoes a client-supplied redirect target — always redirects to the hardcoded /", async () => {
      // Open-redirect regression guard: a query param that looks like a
      // return-to target must never influence the redirect destination.
      completeOidcLoginMock.mockResolvedValue({ sub: "user-1" });
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/oidc/callback?code=abc&state=state-1&returnTo=https://evil.example.com",
        cookies: { [OIDC_TXN_COOKIE_NAME]: txnCookie() },
      });
      expect(res.headers.location).toBe("/");
      await app.close();
    });
  });
});
