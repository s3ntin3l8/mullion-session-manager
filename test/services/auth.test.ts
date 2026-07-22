import { describe, it, expect } from "vitest";
import fastifyCookie from "@fastify/cookie";
import {
  createOidcTxnCookieValue,
  createSessionCookieValue,
  getAuthMethods,
  getSessionIdentity,
  hasValidBearerToken,
  hasValidSessionCookie,
  isAuthEnabled,
  isRequestAuthenticated,
  isValidLoginToken,
  OIDC_TXN_COOKIE_NAME,
  readOidcTxnCookieValue,
  SESSION_COOKIE_NAME,
  type AuthConfig,
} from "../../src/services/auth.js";

const SECRET = "test-session-secret-abcdef123456";
const TOKEN = "test-auth-token-abcdef123456";

// AuthConfig now extends OidcConfig (issue #30) — this is the "OIDC not
// configured" baseline every test below starts from, spreading in whatever
// MULLION_AUTH_TOKEN/MULLION_SESSION_SECRET (and, in the OIDC-specific
// describe blocks further down, MULLION_OIDC_*) values that test needs.
const NO_OIDC = {
  MULLION_OIDC_ISSUER: "",
  MULLION_OIDC_CLIENT_ID: "",
  MULLION_OIDC_CLIENT_SECRET: "",
  MULLION_OIDC_REDIRECT_URI: "",
};

const OIDC_CONFIGURED = {
  MULLION_OIDC_ISSUER: "https://idp.example.com",
  MULLION_OIDC_CLIENT_ID: "client-id",
  MULLION_OIDC_CLIENT_SECRET: "client-secret",
  MULLION_OIDC_REDIRECT_URI: "https://mullion.example.com/api/auth/oidc/callback",
};

function cookieHeader(value: string, name = SESSION_COOKIE_NAME) {
  return `${name}=${value}`;
}

describe("isAuthEnabled", () => {
  it("is false with an empty token and no OIDC (the default — 'rely on the gateway')", () => {
    expect(isAuthEnabled({ MULLION_AUTH_TOKEN: "", MULLION_SESSION_SECRET: "", ...NO_OIDC })).toBe(
      false,
    );
  });

  it("is false for a whitespace-only token", () => {
    expect(
      isAuthEnabled({ MULLION_AUTH_TOKEN: "   ", MULLION_SESSION_SECRET: "", ...NO_OIDC }),
    ).toBe(false);
  });

  it("is true once a token is set", () => {
    expect(
      isAuthEnabled({ MULLION_AUTH_TOKEN: TOKEN, MULLION_SESSION_SECRET: SECRET, ...NO_OIDC }),
    ).toBe(true);
  });

  it("is true once OIDC is fully configured, even with no token", () => {
    expect(
      isAuthEnabled({
        MULLION_AUTH_TOKEN: "",
        MULLION_SESSION_SECRET: SECRET,
        ...OIDC_CONFIGURED,
      }),
    ).toBe(true);
  });
});

describe("getAuthMethods", () => {
  it("reports both false when neither credential is configured", () => {
    expect(
      getAuthMethods({ MULLION_AUTH_TOKEN: "", MULLION_SESSION_SECRET: "", ...NO_OIDC }),
    ).toEqual({ token: false, oidc: false });
  });

  it("reports token and oidc independently — both can be on at once", () => {
    expect(
      getAuthMethods({
        MULLION_AUTH_TOKEN: TOKEN,
        MULLION_SESSION_SECRET: SECRET,
        ...OIDC_CONFIGURED,
      }),
    ).toEqual({ token: true, oidc: true });
  });

  it("reports oidc alone when only OIDC is configured", () => {
    expect(
      getAuthMethods({
        MULLION_AUTH_TOKEN: "",
        MULLION_SESSION_SECRET: SECRET,
        ...OIDC_CONFIGURED,
      }),
    ).toEqual({ token: false, oidc: true });
  });
});

describe("createSessionCookieValue / hasValidSessionCookie", () => {
  it("round-trips: a freshly minted cookie validates against the same secret", () => {
    const value = createSessionCookieValue(SECRET);
    expect(hasValidSessionCookie(SECRET, cookieHeader(value))).toBe(true);
  });

  it("rejects when secret is empty — never trusts an unsigned/unsignable cookie", () => {
    const value = createSessionCookieValue(SECRET);
    expect(hasValidSessionCookie("", cookieHeader(value))).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const value = createSessionCookieValue("a-completely-different-secret-value");
    expect(hasValidSessionCookie(SECRET, cookieHeader(value))).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const value = createSessionCookieValue(SECRET);
    expect(hasValidSessionCookie(SECRET, cookieHeader(`${value}x`))).toBe(false);
  });

  it("rejects a missing Cookie header entirely", () => {
    expect(hasValidSessionCookie(SECRET, undefined)).toBe(false);
  });

  it("rejects a Cookie header without the session cookie name present", () => {
    expect(hasValidSessionCookie(SECRET, "other=value; another=thing")).toBe(false);
  });

  it("rejects malformed percent-encoding in the cookie value", () => {
    // decodeURIComponent throws on a lone/invalid "%" escape.
    expect(hasValidSessionCookie(SECRET, cookieHeader("%E0%A4%A"))).toBe(false);
  });

  it("rejects a validly-signed value whose decoded payload isn't valid JSON", () => {
    // Sign a payload that fastifyCookie.unsign will accept (valid signature),
    // but that isn't the base64url-encoded JSON hasValidSessionCookie
    // expects — proves a signature alone isn't enough to be trusted.
    const garbage = fastifyCookie.sign("not-valid-base64url-json", SECRET);
    expect(hasValidSessionCookie(SECRET, cookieHeader(garbage))).toBe(false);
  });

  it("rejects a validly-signed payload missing authenticated: true", () => {
    const encoded = Buffer.from(JSON.stringify({ issuedAt: Date.now() })).toString("base64url");
    const signed = fastifyCookie.sign(encoded, SECRET);
    expect(hasValidSessionCookie(SECRET, cookieHeader(signed))).toBe(false);
  });

  it("rejects an expired session (older than the 30-day max age)", () => {
    const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
    const encoded = Buffer.from(
      JSON.stringify({ authenticated: true, issuedAt: Date.now() - THIRTY_ONE_DAYS_MS }),
    ).toString("base64url");
    const signed = fastifyCookie.sign(encoded, SECRET);
    expect(hasValidSessionCookie(SECRET, cookieHeader(signed))).toBe(false);
  });

  it("finds the session cookie among other cookies in the same header", () => {
    const value = createSessionCookieValue(SECRET);
    expect(hasValidSessionCookie(SECRET, `foo=bar; ${cookieHeader(value)}; baz=qux`)).toBe(true);
  });
});

describe("createSessionCookieValue / getSessionIdentity (issue #30)", () => {
  const identity = {
    sub: "user-1",
    email: "user@example.com",
    name: "User One",
    groups: ["admins"],
  };

  it("round-trips an OIDC identity through the session cookie", () => {
    const value = createSessionCookieValue(SECRET, identity);
    expect(getSessionIdentity(SECRET, cookieHeader(value))).toEqual(identity);
  });

  it("returns undefined for a token-only session (no identity minted)", () => {
    const value = createSessionCookieValue(SECRET);
    expect(getSessionIdentity(SECRET, cookieHeader(value))).toBeUndefined();
  });

  it("returns undefined for an invalid/tampered cookie, same as hasValidSessionCookie's rejection", () => {
    const value = createSessionCookieValue(SECRET, identity);
    expect(getSessionIdentity(SECRET, cookieHeader(`${value}x`))).toBeUndefined();
  });
});

describe("OIDC transaction cookie (issue #30)", () => {
  const txn = { codeVerifier: "verifier-abc", state: "state-xyz", nonce: "nonce-123" };

  function txnCookieHeader(value: string) {
    return cookieHeader(value, OIDC_TXN_COOKIE_NAME);
  }

  it("round-trips: a freshly minted txn cookie reads back the same values", () => {
    const value = createOidcTxnCookieValue(SECRET, txn);
    expect(readOidcTxnCookieValue(SECRET, txnCookieHeader(value))).toMatchObject(txn);
  });

  it("rejects when secret is empty", () => {
    const value = createOidcTxnCookieValue(SECRET, txn);
    expect(readOidcTxnCookieValue("", txnCookieHeader(value))).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const value = createOidcTxnCookieValue(SECRET, txn);
    expect(readOidcTxnCookieValue(SECRET, txnCookieHeader(`${value}x`))).toBeNull();
  });

  it("rejects a missing cookie", () => {
    expect(readOidcTxnCookieValue(SECRET, undefined)).toBeNull();
  });

  it("rejects an expired transaction (older than the 10-minute max age)", () => {
    const payload = { ...txn, issuedAt: Date.now() - 11 * 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signed = fastifyCookie.sign(encoded, SECRET);
    expect(readOidcTxnCookieValue(SECRET, txnCookieHeader(signed))).toBeNull();
  });

  it("is a distinct cookie name from the session cookie, so both can coexist mid-flow", () => {
    expect(OIDC_TXN_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
  });
});

describe("hasValidBearerToken", () => {
  it("accepts a matching Bearer header", () => {
    expect(hasValidBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a mismatched token", () => {
    expect(hasValidBearerToken("Bearer wrong-token", TOKEN)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(hasValidBearerToken(undefined, TOKEN)).toBe(false);
  });

  it("rejects a header without the Bearer prefix", () => {
    expect(hasValidBearerToken(TOKEN, TOKEN)).toBe(false);
  });

  it("rejects when the expected token is empty (auth not actually enabled)", () => {
    expect(hasValidBearerToken(`Bearer ${TOKEN}`, "")).toBe(false);
  });
});

describe("isValidLoginToken", () => {
  it("accepts the configured token", () => {
    expect(
      isValidLoginToken(TOKEN, {
        MULLION_AUTH_TOKEN: TOKEN,
        MULLION_SESSION_SECRET: SECRET,
        ...NO_OIDC,
      }),
    ).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(
      isValidLoginToken("wrong", {
        MULLION_AUTH_TOKEN: TOKEN,
        MULLION_SESSION_SECRET: SECRET,
        ...NO_OIDC,
      }),
    ).toBe(false);
  });

  it("rejects any token when none is configured", () => {
    expect(
      isValidLoginToken("", { MULLION_AUTH_TOKEN: "", MULLION_SESSION_SECRET: SECRET, ...NO_OIDC }),
    ).toBe(false);
  });
});

describe("isRequestAuthenticated", () => {
  const config: AuthConfig = {
    MULLION_AUTH_TOKEN: TOKEN,
    MULLION_SESSION_SECRET: SECRET,
    ...NO_OIDC,
  };

  it("accepts a valid session cookie alone", () => {
    const value = createSessionCookieValue(SECRET);
    expect(isRequestAuthenticated({ cookie: cookieHeader(value) }, config)).toBe(true);
  });

  it("accepts a valid bearer token alone", () => {
    expect(isRequestAuthenticated({ authorization: `Bearer ${TOKEN}` }, config)).toBe(true);
  });

  it("rejects when neither credential is present", () => {
    expect(isRequestAuthenticated({}, config)).toBe(false);
  });

  it("rejects an invalid cookie and a missing bearer header together", () => {
    expect(isRequestAuthenticated({ cookie: cookieHeader("garbage") }, config)).toBe(false);
  });
});
