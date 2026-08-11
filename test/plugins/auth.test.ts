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
const TEST_OIDC_REDIRECT_URI = "https://mullion.test/api/auth/oidc/callback";

describe("auth plugin + routes (issues #19, #30)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
    delete process.env.PREVIEW_BASE_HOST;
    delete process.env.MULLION_OIDC_ISSUER;
    delete process.env.MULLION_OIDC_CLIENT_ID;
    delete process.env.MULLION_OIDC_CLIENT_SECRET;
    delete process.env.MULLION_OIDC_REDIRECT_URI;
    delete process.env.PREVIEW_AUTH_REQUIRED;
  });

  describe("auth disabled (default — MULLION_AUTH_TOKEN unset)", () => {
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

  describe("auth enabled (MULLION_AUTH_TOKEN set)", () => {
    beforeEach(() => {
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
    });

    it("refuses to boot if MULLION_SESSION_SECRET is missing — an unsigned session cookie would be forgeable", async () => {
      delete process.env.MULLION_SESSION_SECRET;
      await expect(buildApp()).rejects.toThrow(/MULLION_SESSION_SECRET/);
    });

    it("refuses to boot with a whitespace-only MULLION_AUTH_TOKEN (finding AS2)", async () => {
      // Before this check, a `.env` line with a trailing space
      // (MULLION_AUTH_TOKEN="   ") booted "successfully" into an
      // inconsistent state — see test/services/auth.test.ts's own AS2 suite
      // for the runtime inconsistency this boot check exists to preempt.
      process.env.MULLION_AUTH_TOKEN = "   ";
      await expect(buildApp()).rejects.toThrow(/MULLION_AUTH_TOKEN.*blank/);
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

    describe("CSRF: Origin check on cookie-authenticated writes (finding AS1)", () => {
      // POST /api/projects is a real, non-webhook, non-GET write route
      // that's already used elsewhere in this file to prove a request
      // actually reached routes/projects.ts (as opposed to being rejected
      // earlier) — reused here for the same reason: a 200/201 here means
      // the request got all the way through, a 403 means this plugin's own
      // new Origin check rejected it first. The DB is shared across every
      // test in this file (see test/setup.ts — one temp SQLite DB per file,
      // not per test), so any project this successfully creates is cleaned
      // up immediately via DELETE, keeping this describe block's writes
      // invisible to the sibling "spoofed preview Host" tests elsewhere in
      // this file that assert an empty project list.
      async function postProject(app: Awaited<ReturnType<typeof buildApp>>, headers: object) {
        const res = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { createDir: true, name: "p", cwd: "/tmp" },
        });
        if (res.statusCode === 201) {
          const { id } = JSON.parse(res.body);
          await app.inject({
            method: "DELETE",
            url: `/api/projects/${id}`,
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
          });
        }
        return res;
      }

      it("403s a cookie-authenticated write carrying a foreign Origin — the CSRF scenario AS1 describes", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          origin: "https://attacker.example.com",
        });
        expect(res.statusCode).toBe(403);
        // Prove the request never reached the handler at all, not just that
        // it got some 4xx — same discipline as this file's other
        // "never reached the handler" assertions.
        const list = await app.inject({
          method: "GET",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(JSON.parse(list.body)).toEqual([]);
        await app.close();
      });

      it("succeeds for a cookie-authenticated write with no Origin header", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, { cookie: `${SESSION_COOKIE_NAME}=${cookie}` });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("succeeds for a cookie-authenticated write whose Origin matches the dashboard's own origin", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        // app.inject() with no explicit `authority`/Host defaults to
        // "localhost:80" over plain http, but a real browser's Origin
        // header never includes a scheme's default port — see
        // stripDefaultPort in src/plugins/auth.ts, which normalizes the
        // request-derived origin the same way before comparing.
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          origin: "http://localhost",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("leaves a bearer-token-authenticated write unaffected regardless of Origin", async () => {
        const app = await buildApp();
        const res = await postProject(app, {
          authorization: `Bearer ${TEST_TOKEN}`,
          origin: "https://attacker.example.com",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("succeeds behind a Traefik-shaped hop — Host without a port, X-Forwarded-Proto: https, Origin matching both", async () => {
        // The realistic production shape (see src/plugins/security.ts's own
        // comment on this deployment model): Traefik terminates TLS and
        // forwards plain HTTP internally, with Host set to the public
        // hostname (no port) and X-Forwarded-Proto: https identifying the
        // scheme the browser actually used. requestOrigin (src/plugins/
        // auth.ts) must reconstruct "https://mullion.example.com" from
        // exactly these headers to match the Origin a real browser sends —
        // the other tests in this block only exercise app.inject()'s
        // artificial "http://localhost:80" default, not this path.
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          host: "mullion.example.com",
          "x-forwarded-proto": "https",
          origin: "https://mullion.example.com",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("succeeds with a comma-joined X-Forwarded-Proto from a second proxy hop in front of Traefik", async () => {
        // A CDN/LB in front of Traefik that also sets X-Forwarded-Proto
        // makes Node join duplicate headers into "https, http" — reading
        // only the first (outermost) hop's value here, same as requestScheme
        // in src/plugins/auth.ts does, must still resolve to https and match
        // the browser's real Origin. Before that comma-splitting, this
        // shape fell back to request.protocol's "http" and 403'd every
        // cookie-authenticated write behind such a deployment — a full
        // write outage, not just a weaker check.
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          host: "mullion.example.com",
          "x-forwarded-proto": "https, http",
          origin: "https://mullion.example.com",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("succeeds when Host carries an explicit default port that Origin (correctly) omits", async () => {
        // Browsers never include a scheme's default port in the Origin
        // header they send (https://host, never https://host:443) — but a
        // Host header reaching this process can carry one explicitly,
        // depending on proxy config (found in Hermes review on this same
        // PR). "host:443" under https must be treated as equivalent to
        // "host" when comparing against the browser's real Origin.
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          host: "mullion.example.com:443",
          "x-forwarded-proto": "https",
          origin: "https://mullion.example.com",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("succeeds with a non-default port present on both Host and Origin — the make dev shape", async () => {
        // stripDefaultPort only strips the scheme's own default port
        // (:443 for https, :80 for http) — a non-default port like `make
        // dev`'s Vite-proxied :3000 must survive untouched on both sides
        // and still compare equal. Pinned separately from the
        // default-port test above so a future change to stripDefaultPort
        // that strips *any* port, not just the default one, would 403
        // every local-dev write and get caught here.
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await postProject(app, {
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
          host: "localhost:3000",
          origin: "http://localhost:3000",
        });
        expect(res.statusCode).toBe(201);
        await app.close();
      });

      it("does not apply the Origin check to a cookie-authenticated GET", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await app.inject({
          method: "GET",
          url: "/api/projects",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
            origin: "https://attacker.example.com",
          },
        });
        expect(res.statusCode).toBe(200);
        await app.close();
      });

      // Unlike every other case in this block, /ws/terminal's upgrade is a
      // GET on the wire — but a WS handshake isn't subject to the Same-
      // Origin Policy or a CORS preflight the way fetch/XHR/navigation are,
      // so the GET exemption above must NOT extend to it (found in review
      // on this PR): a same-site previewed page could otherwise open
      // `new WebSocket(...)` directly and get a live, interactive PTY with
      // no forgeable header at all. This only proves the onRequest hook
      // rejects the request before any upgrade would occur (app.inject()
      // doesn't perform a real WS handshake) — the real-socket coverage,
      // including a same-origin upgrade that must still succeed, lives in
      // test/routes/terminal.test.ts's "in-process auth gate" describe
      // block, alongside its existing PTY-mocking infrastructure.
      it("403s a cookie-authenticated /ws/terminal upgrade attempt carrying a foreign Origin (finding AS1, WS upgrade)", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await app.inject({
          method: "GET",
          url: "/ws/terminal?sessionId=1",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
            origin: "https://attacker.example.com",
          },
        });
        expect(res.statusCode).toBe(403);
        await app.close();
      });

      // Every real browser client (frontend/src/TerminalPane.tsx and
      // siblings) derives the WS URL's host/protocol from
      // location.host/location.protocol, so a production browser's Origin
      // on a /ws/terminal handshake behind Traefik is always exactly this
      // shape: no port on Host, X-Forwarded-Proto: https, Origin matching
      // both. requestOrigin (src/plugins/auth.ts) is the exact same
      // function this hook already uses for non-GET writes — pinned there
      // by the sibling "succeeds behind a Traefik-shaped hop" test above —
      // but is exercised here specifically against the /ws/ prefix branch,
      // since unlike the POST case, a real WS handshake's Origin header is
      // never absent: an off-by-one in this derivation would 403 every
      // production terminal connection, not just fail closed on an edge
      // case. app.inject() doesn't perform a real upgrade, but it does
      // exercise this hook's onRequest logic (including the Origin
      // comparison) exactly as a real request would before the upgrade is
      // ever attempted.
      it("does not 403 a cookie-authenticated /ws/terminal upgrade behind a Traefik-shaped hop with a matching Origin", async () => {
        const app = await buildApp();
        const cookie = createSessionCookieValue(TEST_SECRET);
        const res = await app.inject({
          method: "GET",
          url: "/ws/terminal?sessionId=1",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
            host: "mullion.example.com",
            "x-forwarded-proto": "https",
            origin: "https://mullion.example.com",
          },
        });
        // app.inject() never performs a real upgrade, and session "1" doesn't
        // exist in this test's DB, so a request that got past this plugin's
        // own Origin check still 404s — routes/terminal.ts's own
        // preValidation hook (NotFoundError, "No session 1") runs strictly
        // after this plugin's onRequest hook and is what produces it. A 403
        // here would mean the Origin check itself rejected the request; a
        // 404 is proof it didn't, i.e. that requestOrigin correctly matched
        // this Traefik-shaped Host/X-Forwarded-Proto/Origin triple.
        expect(res.statusCode).toBe(404);
        await app.close();
      });
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

      it("is rate-limited, unlike before this fix (finding AS9)", async () => {
        // Every other route in routes/auth.ts already had a dedicated
        // { config: { rateLimit } } — logout didn't, the one gap this pins
        // shut. Reuses LOGIN_RATE_LIMIT's own 10/min bound (same "cheap,
        // no-body POST" shape), so the 11th call in one minute 429s.
        const app = await buildApp();
        for (let i = 0; i < 10; i++) {
          const res = await app.inject({
            method: "POST",
            url: "/api/auth/logout",
            cookies: { [SESSION_COOKIE_NAME]: createSessionCookieValue(TEST_SECRET) },
          });
          expect(res.statusCode).toBe(204);
        }
        const eleventh = await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          cookies: { [SESSION_COOKIE_NAME]: createSessionCookieValue(TEST_SECRET) },
        });
        expect(eleventh.statusCode).toBe(429);
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
        // onRequest hook resolves it and 404s (a generic, detail-free body
        // as of finding AS15 — see preview-proxy.ts's PREVIEW_UNAVAILABLE_MESSAGE).
        // A 401 here would mean the auth gate (registered earlier) intercepted first;
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

      it("a spoofed preview Host on a write never reaches the real /api/* handler, with or without auth", async () => {
        // Regression test for a real auth-bypass found in review, now
        // proven differently: previewProxyPlugin's own onRequest hook used
        // to serve GET/HEAD only, so this plugin's host-only preview bypass
        // had to mirror that method gate exactly, or a forged
        // `Host: preview-x.<PREVIEW_BASE_HOST>` on a write would fall
        // straight through this hook into the real /api/* handler with no
        // credential check. Now previewProxyPlugin consumes every method for
        // a matching Host and always terminates the request itself (here: a
        // generic 404 — no such preview is registered; see finding AS15's
        // PREVIEW_UNAVAILABLE_MESSAGE for why the body no longer names the
        // slug), so the invariant holds even though this plugin's own
        // bypass is host-only again — see both plugins' updated doc
        // comments. Assert the *stronger* claim than "401": the request
        // never reached routes/projects.ts at all, proven by no project
        // having been created — a 401 alone wouldn't rule that out if some
        // other bypass existed.
        const app = await buildApp();
        const previewHeaders = { host: "preview-nonexistent.preview.test" };

        const post = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: previewHeaders,
          payload: { createDir: true, name: "p", cwd: "/tmp" },
        });
        expect(post.statusCode).toBe(404);

        const patch = await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: previewHeaders,
          payload: {},
        });
        expect(patch.statusCode).toBe(404);

        const del = await app.inject({
          method: "DELETE",
          url: "/api/projects/1",
          headers: previewHeaders,
        });
        expect(del.statusCode).toBe(404);

        const list = await app.inject({
          method: "GET",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(list.statusCode).toBe(200);
        expect(JSON.parse(list.body)).toEqual([]);

        await app.close();
      });

      it("still gates a normal (non-preview) request to the same path", async () => {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/api/whatever" });
        expect(res.statusCode).toBe(401);
        await app.close();
      });

      it("with PREVIEW_AUTH_REQUIRED also on, a spoofed preview Host on a write still never reaches the real /api/* handler (both gates active at once)", async () => {
        // Sibling of the test above, but with issue #383's own gate also
        // enabled — the single most safety-critical thing to verify here,
        // since a bug in either gate's ordering could let a spoofed Host
        // header bypass BOTH at once. Unlike the plain preview-host-exemption
        // case above (which 404s — no bootstrap token/cookie gate installed),
        // this now 401s: previewProxyPlugin's own new auth check runs before
        // resolvePreviewTarget and rejects with no valid token/cookie, so the
        // request still never reaches routes/projects.ts — proven the same
        // way, by asserting nothing was actually created.
        process.env.PREVIEW_AUTH_REQUIRED = "true";
        const app = await buildApp();
        const previewHeaders = { host: "preview-nonexistent.preview.test" };

        const post = await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: previewHeaders,
          payload: { createDir: true, name: "p", cwd: "/tmp" },
        });
        expect(post.statusCode).toBe(401);

        const list = await app.inject({
          method: "GET",
          url: "/api/projects",
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        });
        expect(list.statusCode).toBe(200);
        expect(JSON.parse(list.body)).toEqual([]);

        await app.close();
      });
    });

    describe("POST /api/webhooks/github exemption (issue #523)", () => {
      it("gets past this hook with no credential — reaches the handler's own rejection, not this plugin's", async () => {
        // No integrations row is seeded in this file, so getWebhookSecret
        // returns null and webhooks.ts's own ladder 401s with "webhook not
        // configured" (checked before the signature) — NOT "missing
        // signature". Both this bug and its fix produce a 401 here, so the
        // *body* is what proves the gate got out of the way: webhooks.ts
        // sends `{ error: "..." }` directly (not via @fastify/sensible, so
        // no "message" key), while this plugin's own rejection is a sensible
        // `{ message: "authentication required" }` — see the assertion just
        // below, a structurally distinct body. Same reasoning as the
        // preview-host exemption tests above (a 404 there, not a 401, is
        // what proves previewProxyPlugin's own hook ran instead of this
        // one).
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/webhooks/github",
          payload: {},
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "webhook not configured" });
        await app.close();
      });

      it("a normal /api/* path right next to it is still gated, with this plugin's own rejection", async () => {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/api/projects" });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe("authentication required");
        await app.close();
      });

      it("does not exempt webhook management under a neighboring path — still session-gated", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/api/integrations/github/webhooks/status",
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe("authentication required");
        await app.close();
      });

      it("a traversal path that resolves off the exemption stays gated with this plugin's own rejection", async () => {
        // requestPathname's URL-based normalization (shared by every
        // exact-match exemption in isProtectedPath) collapses ".." segments
        // before the comparison runs, so /api/webhooks/github/../projects
        // is checked as /api/projects, not the literal exempted string —
        // pinning that this exemption can't be walked off of via a crafted
        // path.
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/webhooks/github/../projects",
          payload: { name: "p", cwd: "/tmp" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe("authentication required");
        await app.close();
      });
    });

    describe("/api/auth/* exact-match exemption, not a prefix (finding AS8)", () => {
      it("a hypothetical future route under /api/auth/* is PROTECTED by default, unlike the old startsWith prefix", async () => {
        // Proves the fix actually closes the gap: with the old
        // `pathname.startsWith("/api/auth/")` check, any route later
        // dropped under this prefix would have been silently exempted from
        // this hook with no reviewer signal. isProtectedPath now only
        // exempts the five routes routes/auth.ts actually registers, so a
        // synthetic path outside that exact-match set is gated exactly like
        // any other /api/* route.
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/api/auth/sessions" });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe("authentication required");
        await app.close();
      });

      it("still exempts all five real routes/auth.ts routes", async () => {
        const app = await buildApp();

        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { token: "wrong" },
        });
        // 401 for the wrong token (the route's own rejection), not this
        // plugin's — proven by the distinct body shape used throughout this
        // file (no "message" key from this plugin's sensible rejection).
        expect(login.json()).not.toHaveProperty("message", "authentication required");

        const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
        expect(logout.statusCode).toBe(204);

        const me = await app.inject({ method: "GET", url: "/api/auth/me" });
        expect(me.statusCode).toBe(200);

        const oidcLogin = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
        // 404 (OIDC not configured in this test's env) — the route's own
        // rejection, proving this plugin's hook got out of the way.
        expect(oidcLogin.statusCode).toBe(404);

        const oidcCallback = await app.inject({ method: "GET", url: "/api/auth/oidc/callback" });
        expect(oidcCallback.statusCode).toBe(404);

        await app.close();
      });
    });
  });

  describe("OIDC boot invariants (issue #30)", () => {
    it("refuses to boot with OIDC fully configured but no MULLION_SESSION_SECRET", async () => {
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      await expect(buildApp()).rejects.toThrow(/MULLION_SESSION_SECRET/);
    });

    it("refuses to boot with only some MULLION_OIDC_* keys set, even with a session secret", async () => {
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      // MULLION_OIDC_CLIENT_SECRET and MULLION_OIDC_REDIRECT_URI left unset.
      await expect(buildApp()).rejects.toThrow(/MULLION_OIDC_/);
    });

    it("boots fine with every MULLION_OIDC_* key and MULLION_SESSION_SECRET set", async () => {
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      const app = await buildApp();
      await app.close();
    });
  });

  describe("MULLION_TRUST_GATEWAY boot invariant (issue #603)", () => {
    afterEach(() => {
      delete process.env.MULLION_TRUST_GATEWAY;
      delete process.env.MULLION_ROLE;
      delete process.env.MULLION_AGENT_TOKEN;
      // Explicit, not just relied-on-from-earlier-describes cleanup: mirrors
      // the exact condition the invariant itself checks (isAuthEnabled),
      // rather than trusting the OIDC/token describes above this one to have
      // cleaned up after themselves — if one of them ever left a credential
      // set, "refuses to boot" below would fail with a different error (or
      // silently boot) instead of exercising the invariant this block is
      // named for.
      delete process.env.MULLION_AUTH_TOKEN;
      delete process.env.MULLION_OIDC_ISSUER;
      delete process.env.MULLION_OIDC_CLIENT_ID;
      delete process.env.MULLION_OIDC_CLIENT_SECRET;
      delete process.env.MULLION_OIDC_REDIRECT_URI;
    });

    it("refuses to boot with no in-process auth and MULLION_TRUST_GATEWAY unset — test/setup.ts forces this true for every other test in the suite", async () => {
      delete process.env.MULLION_TRUST_GATEWAY;
      delete process.env.MULLION_AUTH_TOKEN;
      delete process.env.MULLION_OIDC_ISSUER;
      delete process.env.MULLION_OIDC_CLIENT_ID;
      delete process.env.MULLION_OIDC_CLIENT_SECRET;
      delete process.env.MULLION_OIDC_REDIRECT_URI;
      await expect(buildApp()).rejects.toThrow(/MULLION_TRUST_GATEWAY/);
    });

    it("boots with MULLION_TRUST_GATEWAY=true and no in-process auth", async () => {
      process.env.MULLION_TRUST_GATEWAY = "true";
      const app = await buildApp();
      await app.close();
    });

    it("does not require MULLION_TRUST_GATEWAY when MULLION_AUTH_TOKEN is configured", async () => {
      delete process.env.MULLION_TRUST_GATEWAY;
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      const app = await buildApp();
      await app.close();
    });

    it("does not require MULLION_TRUST_GATEWAY when OIDC is fully configured", async () => {
      delete process.env.MULLION_TRUST_GATEWAY;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      const app = await buildApp();
      await app.close();
    });

    it("does not apply to the agent role — an agent's trust boundary is MULLION_AGENT_TOKEN, not this flag", async () => {
      delete process.env.MULLION_TRUST_GATEWAY;
      process.env.MULLION_ROLE = "agent";
      process.env.MULLION_AGENT_TOKEN = "test-agent-token";
      const app = await buildApp();
      await app.close();
    });
  });

  describe("PREVIEW_AUTH_REQUIRED boot invariant (issue #383)", () => {
    afterEach(() => {
      delete process.env.PREVIEW_AUTH_REQUIRED;
      delete process.env.MULLION_ROLE;
      delete process.env.MULLION_AGENT_TOKEN;
    });

    it("refuses to boot with PREVIEW_AUTH_REQUIRED set but no in-process auth configured at all — the bootstrap-token mint route would otherwise be reachable with no credential", async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      // MULLION_AUTH_TOKEN and MULLION_OIDC_* both left unset — authPlugin's
      // own onRequest gate installs no hook at all in that combination (see
      // its early return), so PREVIEW_AUTH_REQUIRED alone would otherwise
      // let anyone reach POST /api/previews/:slug/token uncredentialed.
      await expect(buildApp()).rejects.toThrow(/MULLION_AUTH_TOKEN|MULLION_OIDC_/);
    });

    it("refuses to boot with PREVIEW_AUTH_REQUIRED set, auth enabled, but no MULLION_SESSION_SECRET", async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      await expect(buildApp()).rejects.toThrow(/MULLION_SESSION_SECRET/);
    });

    it("boots fine with PREVIEW_AUTH_REQUIRED, MULLION_AUTH_TOKEN, and MULLION_SESSION_SECRET all set", async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      const app = await buildApp();
      await app.close();
    });

    it("boots fine with PREVIEW_AUTH_REQUIRED and full OIDC configured, MULLION_AUTH_TOKEN left unset (security review, PR #427)", async () => {
      // The boot check is isAuthEnabled(config) — token OR OIDC — not
      // MULLION_AUTH_TOKEN specifically; this pins the OIDC-only side of
      // that OR so a future regression narrowing the check to token-only
      // wouldn't silently start refusing to boot for OIDC-only operators.
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
      const app = await buildApp();
      await app.close();
    });

    it("does not refuse to boot as an agent even with PREVIEW_AUTH_REQUIRED set and nothing else configured — the flag only applies to the primary role", async () => {
      process.env.PREVIEW_AUTH_REQUIRED = "true";
      process.env.MULLION_ROLE = "agent";
      process.env.MULLION_AGENT_TOKEN = "test-agent-token";
      const app = await buildApp();
      await app.close();
    });
  });

  describe("GET /api/auth/oidc/login (issue #30)", () => {
    beforeEach(() => {
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
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
      process.env.MULLION_SESSION_SECRET = TEST_SECRET;
      process.env.MULLION_OIDC_ISSUER = TEST_OIDC_ISSUER;
      process.env.MULLION_OIDC_CLIENT_ID = TEST_OIDC_CLIENT_ID;
      process.env.MULLION_OIDC_CLIENT_SECRET = TEST_OIDC_CLIENT_SECRET;
      process.env.MULLION_OIDC_REDIRECT_URI = TEST_OIDC_REDIRECT_URI;
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
        "https://mullion.test/api/auth/oidc/callback?code=abc&state=state-1",
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

    it("sends the configured MULLION_OIDC_REDIRECT_URI's own path, not request.url's, to the token exchange — regression for a reverse-proxy path-rewrite bug found in review", async () => {
      // A reverse proxy that strips a path prefix (e.g. Traefik mounting
      // this app under /some-prefix and rewriting it away before the
      // request reaches this process) would make Fastify's own
      // request.url disagree with the *externally* registered
      // MULLION_OIDC_REDIRECT_URI path. openid-client derives the
      // redirect_uri it sends to the token endpoint from currentUrl's own
      // path — building currentUrl from request.url's path (instead of
      // the configured URI's) would silently send the wrong redirect_uri
      // and get rejected by the IdP. This route is always registered at
      // the literal "/api/auth/oidc/callback" path regardless of what
      // MULLION_OIDC_REDIRECT_URI is configured to, so setting it to a
      // different path here reproduces exactly that proxy-rewrite
      // scenario without needing an actual proxy in the test.
      process.env.MULLION_OIDC_REDIRECT_URI =
        "https://mullion.test/some-prefix/api/auth/oidc/callback";
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
        "https://mullion.test/some-prefix/api/auth/oidc/callback?code=abc&state=state-1",
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
