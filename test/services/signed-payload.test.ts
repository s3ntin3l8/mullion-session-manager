import { describe, it, expect } from "vitest";
import fastifyCookie from "@fastify/cookie";
import {
  parseCookieHeader,
  signPayload,
  verifySignedPayload,
} from "../../src/services/signed-payload.js";

const SECRET = "test-signed-payload-secret-0123456789";
const MAX_AGE_MS = 60 * 1000;

interface Payload {
  slug: string;
  issuedAt: number;
}

function isValidPayload(value: unknown): value is Payload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Payload>;
  return typeof candidate.slug === "string" && typeof candidate.issuedAt === "number";
}

describe("signPayload / verifySignedPayload", () => {
  it("round-trips a freshly minted payload", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() });
    const result = verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload);
    expect(result).toMatchObject({ slug: "abc" });
  });

  it("rejects a payload signed with a different secret", () => {
    const value = signPayload("a-completely-different-secret", {
      slug: "abc",
      issuedAt: Date.now(),
    });
    expect(verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects when the verifying secret is empty", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() });
    expect(verifySignedPayload("", value, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects a missing raw value", () => {
    expect(verifySignedPayload(SECRET, undefined, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() });
    expect(verifySignedPayload(SECRET, `${value}x`, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects a validly-signed value whose decoded payload isn't valid JSON", () => {
    const garbage = fastifyCookie.sign("not-valid-base64url-json", SECRET);
    expect(verifySignedPayload(SECRET, garbage, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects a payload that fails the caller's own shape check", () => {
    const encoded = Buffer.from(JSON.stringify({ issuedAt: Date.now() })).toString("base64url");
    const signed = fastifyCookie.sign(encoded, SECRET);
    expect(verifySignedPayload(SECRET, signed, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("rejects a payload older than maxAgeMs", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() - MAX_AGE_MS - 1 });
    expect(verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  it("accepts a payload right at the boundary of maxAgeMs", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() - MAX_AGE_MS + 1000 });
    expect(verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload)).not.toBeNull();
  });

  // Finding AS11: `Date.now() - issuedAt > maxAgeMs` alone always passes
  // when the difference is negative — i.e. issuedAt is in the future — so a
  // payload minted during a forward clock jump (NTP correction, VM pause/
  // resume, misconfiguration) would never expire under the staleness check
  // alone. A payload noticeably in the future must be rejected outright.
  it("rejects a payload whose issuedAt is noticeably in the future (finding AS11)", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() + 10 * 60 * 1000 });
    expect(verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload)).toBeNull();
  });

  // The clock-skew tolerance is a window, not an outright ban on any
  // future issuedAt — real clock drift between processes is expected and
  // must not itself reject an otherwise-legitimate payload.
  it("accepts a payload only slightly in the future, within the clock-skew tolerance", () => {
    const value = signPayload(SECRET, { slug: "abc", issuedAt: Date.now() + 60 * 1000 });
    expect(verifySignedPayload(SECRET, value, MAX_AGE_MS, isValidPayload)).not.toBeNull();
  });

  // Byte-compat: the wire format must stay identical to the hand-rolled
  // inline logic services/auth.ts used before this module existed
  // (JSON.stringify -> base64url -> fastifyCookie.sign), so existing
  // session/OIDC cookies minted before this refactor aren't invalidated by
  // it. Two directions: an old-format value must still verify via the new
  // helper, and a new-format value must be exactly what the old hand-rolled
  // logic would have produced.
  describe("byte-compatibility with the pre-refactor hand-rolled cookie logic", () => {
    it("verifySignedPayload accepts a value minted the old, hand-rolled way", () => {
      const payload: Payload = { slug: "legacy", issuedAt: Date.now() };
      const oldStyleValue = fastifyCookie.sign(
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        SECRET,
      );
      const result = verifySignedPayload(SECRET, oldStyleValue, MAX_AGE_MS, isValidPayload);
      expect(result).toEqual(payload);
    });

    it("signPayload produces exactly what the old hand-rolled logic would have for the same payload", () => {
      const payload: Payload = { slug: "new", issuedAt: 1_700_000_000_000 };
      const newValue = signPayload(SECRET, payload);
      const oldStyleValue = fastifyCookie.sign(
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        SECRET,
      );
      expect(newValue).toBe(oldStyleValue);
    });
  });
});

describe("parseCookieHeader", () => {
  it("finds a named cookie among several", () => {
    expect(parseCookieHeader("a=1; target=hello; b=2", "target")).toBe("hello");
  });

  it("returns null when the cookie header is missing", () => {
    expect(parseCookieHeader(undefined, "target")).toBeNull();
  });

  it("returns null when the named cookie isn't present", () => {
    expect(parseCookieHeader("a=1; b=2", "target")).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(parseCookieHeader("target=hello%20world", "target")).toBe("hello world");
  });

  it("returns null for malformed percent-encoding", () => {
    expect(parseCookieHeader("target=%E0%A4%A", "target")).toBeNull();
  });
});
