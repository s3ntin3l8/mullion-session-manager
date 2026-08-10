import { describe, it, expect, vi } from "vitest";
import {
  PREVIEW_COOKIE_MAX_AGE_SECONDS,
  PREVIEW_COOKIE_NAME,
  PREVIEW_COOKIE_REFRESH_AGE_MS,
  checkPreviewCookie,
  mintPreviewCookie,
  mintPreviewToken,
  verifyPreviewCookie,
  verifyPreviewToken,
} from "../../src/services/preview-auth.js";

const SECRET = "test-preview-auth-secret-0123456789";
const SLUG = "abc-123";

function cookieHeader(value: string) {
  return `${PREVIEW_COOKIE_NAME}=${value}`;
}

describe("mintPreviewToken / verifyPreviewToken", () => {
  it("accepts a freshly minted token for the same slug", () => {
    const token = mintPreviewToken(SECRET, SLUG);
    expect(verifyPreviewToken(SECRET, token, SLUG)).toBe(true);
  });

  it("rejects a token minted for a different slug (defense in depth)", () => {
    const token = mintPreviewToken(SECRET, SLUG);
    expect(verifyPreviewToken(SECRET, token, "some-other-slug")).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintPreviewToken("a-completely-different-secret", SLUG);
    expect(verifyPreviewToken(SECRET, token, SLUG)).toBe(false);
  });

  it("rejects a tampered token", () => {
    const token = mintPreviewToken(SECRET, SLUG);
    expect(verifyPreviewToken(SECRET, `${token}x`, SLUG)).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(verifyPreviewToken(SECRET, undefined, SLUG)).toBe(false);
  });

  it("rejects a token 61 seconds after mint, while a cookie minted at the same instant is still valid (security review, PR #427)", () => {
    // Pins the actual asymmetry the short bootstrap TTL exists for — a
    // signed-payload.ts-level expiry test alone can't catch
    // PREVIEW_TOKEN_MAX_AGE_MS (60s, private to this module) being
    // accidentally set equal to the 24h PREVIEW_COOKIE_MAX_AGE_SECONDS
    // (finding AS12), or the two constants being swapped between the
    // mint/verify call sites — either bug would leave every other test in
    // this file green.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      const token = mintPreviewToken(SECRET, SLUG);
      const cookieValue = mintPreviewCookie(SECRET, SLUG);

      vi.setSystemTime(new Date(2026, 0, 1, 0, 1, 1)); // +61s
      expect(verifyPreviewToken(SECRET, token, SLUG)).toBe(false);
      expect(verifyPreviewCookie(SECRET, cookieHeader(cookieValue), SLUG)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mintPreviewCookie / verifyPreviewCookie", () => {
  it("accepts a freshly minted cookie for the same slug", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(verifyPreviewCookie(SECRET, cookieHeader(value), SLUG)).toBe(true);
  });

  it("rejects a cookie minted for a different slug (defense in depth)", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(verifyPreviewCookie(SECRET, cookieHeader(value), "some-other-slug")).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const value = mintPreviewCookie("a-completely-different-secret", SLUG);
    expect(verifyPreviewCookie(SECRET, cookieHeader(value), SLUG)).toBe(false);
  });

  it("rejects a tampered cookie", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(verifyPreviewCookie(SECRET, cookieHeader(`${value}x`), SLUG)).toBe(false);
  });

  it("rejects a missing cookie header", () => {
    expect(verifyPreviewCookie(SECRET, undefined, SLUG)).toBe(false);
  });

  it("finds the preview cookie among other cookies in the same header", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(verifyPreviewCookie(SECRET, `foo=bar; ${cookieHeader(value)}; baz=qux`, SLUG)).toBe(
      true,
    );
  });

  it("rejects a token verified as a cookie and vice versa (distinct max ages notwithstanding, wrong slug still rejects)", () => {
    // Tokens and cookies share the same wire format (both are
    // { slug, issuedAt } payloads signed the same way) but different max
    // ages — a bootstrap token is still only ever read via
    // verifyPreviewToken and a cookie via verifyPreviewCookie in
    // preview-proxy.ts, so cross-checking isn't a real code path, but this
    // pins down that both independently enforce the slug match regardless.
    const token = mintPreviewToken(SECRET, SLUG);
    expect(verifyPreviewToken(SECRET, token, SLUG)).toBe(true);
    const cookie = mintPreviewCookie(SECRET, SLUG);
    expect(verifyPreviewCookie(SECRET, cookieHeader(cookie), SLUG)).toBe(true);
  });
});

// Finding AS12 — the preview cookie now uses a sliding idle timeout: a
// short-ish absolute TTL (PREVIEW_COOKIE_MAX_AGE_SECONDS, 24h — down from
// reusing the dashboard session's 30-day TTL) bounds how long revocation lag
// can be, while checkPreviewCookie tells its caller to silently re-mint a
// still-valid cookie once it's more than half that old, so a preview that's
// genuinely still in use never actually hits the cap.
describe("checkPreviewCookie (finding AS12 — sliding idle timeout)", () => {
  it("is 24h, not the 30-day dashboard session TTL", () => {
    expect(PREVIEW_COOKIE_MAX_AGE_SECONDS).toBe(24 * 60 * 60);
  });

  it("does not ask for a refresh on a freshly minted cookie", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(checkPreviewCookie(SECRET, cookieHeader(value), SLUG)).toEqual({
      valid: true,
      shouldRefresh: false,
    });
  });

  it("does not ask for a refresh while still under the refresh threshold", () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date(2026, 0, 1, 0, 0, 0);
      vi.setSystemTime(t0);
      const value = mintPreviewCookie(SECRET, SLUG);

      vi.setSystemTime(new Date(t0.getTime() + PREVIEW_COOKIE_REFRESH_AGE_MS - 1000));
      expect(checkPreviewCookie(SECRET, cookieHeader(value), SLUG)).toEqual({
        valid: true,
        shouldRefresh: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a refresh once older than the refresh threshold, while still valid", () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date(2026, 0, 1, 0, 0, 0);
      vi.setSystemTime(t0);
      const value = mintPreviewCookie(SECRET, SLUG);

      vi.setSystemTime(new Date(t0.getTime() + PREVIEW_COOKIE_REFRESH_AGE_MS + 1000));
      expect(checkPreviewCookie(SECRET, cookieHeader(value), SLUG)).toEqual({
        valid: true,
        shouldRefresh: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is genuinely invalid (not just refresh-worthy) once past the full 24h TTL", () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date(2026, 0, 1, 0, 0, 0);
      vi.setSystemTime(t0);
      const value = mintPreviewCookie(SECRET, SLUG);

      vi.setSystemTime(new Date(t0.getTime() + PREVIEW_COOKIE_MAX_AGE_SECONDS * 1000 + 1000));
      expect(checkPreviewCookie(SECRET, cookieHeader(value), SLUG)).toEqual({
        valid: false,
        shouldRefresh: false,
      });
      expect(verifyPreviewCookie(SECRET, cookieHeader(value), SLUG)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks for a refresh on an invalid cookie (wrong slug, wrong secret, missing)", () => {
    const value = mintPreviewCookie(SECRET, SLUG);
    expect(checkPreviewCookie(SECRET, cookieHeader(value), "other-slug")).toEqual({
      valid: false,
      shouldRefresh: false,
    });
    expect(checkPreviewCookie("wrong-secret", cookieHeader(value), SLUG)).toEqual({
      valid: false,
      shouldRefresh: false,
    });
    expect(checkPreviewCookie(SECRET, undefined, SLUG)).toEqual({
      valid: false,
      shouldRefresh: false,
    });
  });
});
