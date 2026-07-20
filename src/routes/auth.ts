import type { FastifyInstance } from "fastify";
import {
  createOidcTxnCookieValue,
  createSessionCookieValue,
  getAuthMethods,
  getSessionIdentity,
  isAuthEnabled,
  isRequestAuthenticated,
  isValidLoginToken,
  OIDC_TXN_COOKIE_NAME,
  OIDC_TXN_MAX_AGE_SECONDS,
  readOidcTxnCookieValue,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "../services/auth.js";
import { buildOidcAuthorizationUrl, completeOidcLogin, isOidcEnabled } from "../services/oidc.js";

const loginSchema = {
  body: {
    type: "object",
    required: ["token"],
    properties: {
      token: { type: "string" },
    },
  },
};

// Both routes below perform an authorization check (isValidLoginToken /
// isRequestAuthenticated) reachable with no credential at all — CodeQL's
// js/missing-rate-limiting flagged them prior to this: the app-wide default
// (security.ts's RATE_LIMIT_MAX, tuned for a browser's normal UI traffic —
// dozens of calls per page load) isn't a *dedicated* bound on login
// attempts specifically, so a request that only ever hits this one route
// could still exhaust most of that budget guessing tokens. Much stricter
// ceilings here, independent of RATE_LIMIT_MAX, same
// `{ config: { rateLimit } }` per-route override mechanism internal.ts's own
// INTERNAL_RATE_LIMIT uses.
// Kept as bare rateLimit option objects, not pre-wrapped in `{ config: {...} }`
// — CodeQL's js/missing-rate-limiting query couldn't trace `config.rateLimit`
// through an object-spread (`...LOGIN_RATE_LIMIT`) at the route-registration
// call site, only a literal `config: { rateLimit }` there directly (compare:
// the `me` route below, registered the literal way, cleared the same alert;
// `login` spread this same shape and stayed flagged even after being
// genuinely rate-limited at runtime — a static-analysis limitation, not a
// behavior difference, but literal is what satisfies it).
const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const ME_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
// Same "dedicated bound, not just the app-wide default" reasoning as
// LOGIN_RATE_LIMIT above, applied to the two new OIDC routes.
const OIDC_LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const OIDC_CALLBACK_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

// All three routes live under /api/auth/ — src/plugins/auth.ts's onRequest
// gate deliberately exempts that whole prefix (see its own comment), since
// a request can't authenticate itself against a gate that also blocks the
// one endpoint that authenticates it. GET /api/auth/me is what the frontend
// polls on load to decide whether to render the dashboard or a login view
// (see App.tsx) — reachable unauthenticated by design.
export async function authRoute(app: FastifyInstance) {
  app.post<{ Body: { token: string } }>(
    "/api/auth/login",
    { schema: loginSchema, config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (request, reply) => {
      if (!isValidLoginToken(request.body.token, app.config)) {
        return reply.unauthorized("invalid token");
      }

      reply.setCookie(
        SESSION_COOKIE_NAME,
        createSessionCookieValue(app.config.TESSERA_SESSION_SECRET),
        {
          httpOnly: true,
          sameSite: "lax",
          // Traefik terminates TLS and talks plain HTTP to this process
          // internally (see src/plugins/security.ts's own CSP comment on the
          // same deployment model) — Secure governs what the *browser* sends
          // based on the origin it sees (https, once Traefik is in front), not
          // this internal hop, so it's safe to require in production. In dev
          // (plain http://localhost) requiring it would silently drop the
          // cookie, so it's off outside production.
          secure: app.config.NODE_ENV === "production",
          path: "/",
          maxAge: SESSION_MAX_AGE_SECONDS,
        },
      );
      reply.code(204);
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    // No RP-initiated (provider-side) logout here even when the session
    // carries an OIDC identity — that needs the id_token as an
    // id_token_hint, and completeOidcLogin (services/oidc.ts) deliberately
    // never keeps that token around once it's extracted the claims it
    // needs. Clearing the local session is what every other route already
    // relies on for "logged out" anyway; provider-side logout is a
    // possible follow-up, not a correctness gap in this one.
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.code(204);
  });

  app.get("/api/auth/me", { config: { rateLimit: ME_RATE_LIMIT } }, async (request) => {
    const enabled = isAuthEnabled(app.config);
    const authenticated = enabled ? isRequestAuthenticated(request.headers, app.config) : true;
    const identity = authenticated
      ? getSessionIdentity(app.config.TESSERA_SESSION_SECRET, request.headers.cookie)
      : undefined;
    return {
      methods: getAuthMethods(app.config),
      authenticated,
      ...(identity ? { user: identity } : {}),
    };
  });

  // Both OIDC routes are GETs the browser navigates to directly (a
  // provider's authorize/redirect response is a top-level GET, not
  // something an SPA fetch()es) — reachable with no credential, same as
  // POST /api/auth/login above, since a request can't authenticate itself
  // against a gate that also blocks the endpoint that authenticates it.
  app.get(
    "/api/auth/oidc/login",
    { config: { rateLimit: OIDC_LOGIN_RATE_LIMIT } },
    async (_request, reply) => {
      if (!isOidcEnabled(app.config)) return reply.notFound();

      const txn = await buildOidcAuthorizationUrl(app.config);
      reply.setCookie(
        OIDC_TXN_COOKIE_NAME,
        createOidcTxnCookieValue(app.config.TESSERA_SESSION_SECRET, txn),
        {
          httpOnly: true,
          // Lax, not Strict: the callback below is reached via a cross-site
          // top-level navigation *back from the IdP* — Strict would drop
          // this cookie on that navigation and silently break the flow.
          // Same reasoning as the session cookie's own sameSite choice.
          sameSite: "lax",
          secure: app.config.NODE_ENV === "production",
          path: "/api/auth/oidc",
          maxAge: OIDC_TXN_MAX_AGE_SECONDS,
        },
      );
      return reply.redirect(txn.url.href);
    },
  );

  app.get(
    "/api/auth/oidc/callback",
    { config: { rateLimit: OIDC_CALLBACK_RATE_LIMIT } },
    async (request, reply) => {
      const clearTxnCookie = () =>
        reply.clearCookie(OIDC_TXN_COOKIE_NAME, { path: "/api/auth/oidc" });

      if (!isOidcEnabled(app.config)) return reply.notFound();

      const txn = readOidcTxnCookieValue(app.config.TESSERA_SESSION_SECRET, request.headers.cookie);
      if (!txn) {
        clearTxnCookie();
        // Expired/missing/replayed transaction — nothing to safely resume;
        // send the user back to start a fresh login rather than exposing
        // provider error detail here (never echo the callback's own query
        // string back to the client).
        return reply.redirect("/");
      }

      try {
        const currentUrl = new URL(request.url, app.config.TESSERA_OIDC_REDIRECT_URI);
        const identity = await completeOidcLogin(app.config, currentUrl, txn);
        clearTxnCookie();
        reply.setCookie(
          SESSION_COOKIE_NAME,
          createSessionCookieValue(app.config.TESSERA_SESSION_SECRET, identity),
          {
            httpOnly: true,
            sameSite: "lax",
            secure: app.config.NODE_ENV === "production",
            path: "/",
            maxAge: SESSION_MAX_AGE_SECONDS,
          },
        );
      } catch (err) {
        app.log.warn({ err }, "OIDC callback failed");
        clearTxnCookie();
      }
      // Always a fixed, hardcoded redirect target — never a client-supplied
      // returnTo/redirect parameter, which would make this an open
      // redirect. AuthGate re-checks GET /api/auth/me on load either way.
      return reply.redirect("/");
    },
  );
}
