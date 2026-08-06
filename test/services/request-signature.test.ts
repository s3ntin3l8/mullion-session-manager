import { describe, it, expect } from "vitest";
import {
  DRIFT_WINDOW_MS,
  buildCanonicalString,
  hashBody,
  isTimestampFresh,
  isUnsignedBodyPath,
  sign,
  verify,
} from "../../src/services/request-signature.js";

describe("request-signature (issue #249 / roadmap 7.5)", () => {
  describe("buildCanonicalString", () => {
    it("joins the versioned fields with newlines, in order", () => {
      const result = buildCanonicalString({
        method: "post",
        requestTarget: "/internal/discover?x=1",
        timestamp: "1000",
        nonce: "abc",
        bodyHashed: true,
        bodyHash: "deadbeef",
      });
      expect(result).toBe("v1\nPOST\n/internal/discover?x=1\n1000\nabc\nh:deadbeef");
    });

    it("uppercases the method", () => {
      const result = buildCanonicalString({
        method: "get",
        requestTarget: "/x",
        timestamp: "1",
        nonce: "n",
        bodyHashed: true,
        bodyHash: "",
      });
      expect(result).toContain("\nGET\n");
    });

    it("uses bodyMode 'n' with an empty hash for an unsigned-body request", () => {
      const result = buildCanonicalString({
        method: "POST",
        requestTarget: "/internal/uploads?cwd=x&mime=y",
        timestamp: "1",
        nonce: "n",
        bodyHashed: false,
        bodyHash: "",
      });
      expect(result.endsWith("\nn:")).toBe(true);
    });

    it("query string is part of the signed request target, not stripped", () => {
      const withQuery = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/actions?cwd=/a",
        timestamp: "1",
        nonce: "n",
        bodyHashed: true,
        bodyHash: "",
      });
      const withoutQuery = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/actions",
        timestamp: "1",
        nonce: "n",
        bodyHashed: true,
        bodyHash: "",
      });
      expect(withQuery).not.toBe(withoutQuery);
    });
  });

  describe("hashBody", () => {
    it("is deterministic for the same input", () => {
      expect(hashBody("hello")).toBe(hashBody("hello"));
    });

    it("differs for different input", () => {
      expect(hashBody("hello")).not.toBe(hashBody("world"));
    });

    it("hashes a Buffer the same way as its equivalent string", () => {
      expect(hashBody(Buffer.from("hello"))).toBe(hashBody("hello"));
    });

    it("hashes the empty string to a fixed, well-known value", () => {
      // The canonical sha256("") — asserted literally so a future refactor
      // that silently changes the hash function gets caught immediately,
      // not just via "some other string now differs" tests.
      expect(hashBody("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // pragma: allowlist secret
      );
    });
  });

  describe("sign / verify", () => {
    it("verify returns true for a signature produced by sign() with the same secret+string", () => {
      const canonicalString = "v1\nGET\n/x\n1\nn\nh:";
      const signature = sign("secret", canonicalString);
      expect(verify("secret", canonicalString, signature)).toBe(true);
    });

    it("verify returns false for the right shape but wrong secret", () => {
      const canonicalString = "v1\nGET\n/x\n1\nn\nh:";
      const signature = sign("secret-a", canonicalString);
      expect(verify("secret-b", canonicalString, signature)).toBe(false);
    });

    it("verify returns false when the canonical string changed (e.g. a tampered path)", () => {
      const canonicalString = "v1\nGET\n/x\n1\nn\nh:";
      const signature = sign("secret", canonicalString);
      const tampered = "v1\nGET\n/y\n1\nn\nh:";
      expect(verify("secret", tampered, signature)).toBe(false);
    });

    it("verify returns false for a garbage/wrong-length provided signature, without throwing", () => {
      const canonicalString = "v1\nGET\n/x\n1\nn\nh:";
      expect(() => verify("secret", canonicalString, "not-a-real-signature")).not.toThrow();
      expect(verify("secret", canonicalString, "not-a-real-signature")).toBe(false);
    });

    it("verify returns false for an empty provided signature", () => {
      const canonicalString = "v1\nGET\n/x\n1\nn\nh:";
      expect(verify("secret", canonicalString, "")).toBe(false);
    });
  });

  describe("isTimestampFresh", () => {
    const now = 1_000_000;

    it("accepts a timestamp exactly at now", () => {
      expect(isTimestampFresh(String(now), now)).toBe(true);
    });

    it("accepts a timestamp exactly at the edge of the drift window (past)", () => {
      expect(isTimestampFresh(String(now - DRIFT_WINDOW_MS), now)).toBe(true);
    });

    it("accepts a timestamp exactly at the edge of the drift window (future)", () => {
      expect(isTimestampFresh(String(now + DRIFT_WINDOW_MS), now)).toBe(true);
    });

    it("rejects a timestamp just past the drift window (stale)", () => {
      expect(isTimestampFresh(String(now - DRIFT_WINDOW_MS - 1), now)).toBe(false);
    });

    it("rejects a timestamp just past the drift window (future)", () => {
      expect(isTimestampFresh(String(now + DRIFT_WINDOW_MS + 1), now)).toBe(false);
    });

    it("rejects a non-numeric timestamp", () => {
      expect(isTimestampFresh("not-a-number", now)).toBe(false);
    });

    it("rejects an empty timestamp", () => {
      expect(isTimestampFresh("", now)).toBe(false);
    });
  });

  describe("isUnsignedBodyPath", () => {
    it("matches an /internal/preview/... request target", () => {
      expect(isUnsignedBodyPath("/internal/preview/5173/index.html")).toBe(true);
    });

    it("matches an /internal/uploads request target, query string included", () => {
      expect(isUnsignedBodyPath("/internal/uploads?cwd=/x&mime=image/png")).toBe(true);
    });

    it("does not match an ordinary JSON-body route", () => {
      expect(isUnsignedBodyPath("/internal/sessions")).toBe(false);
    });

    it("does not match a route that merely starts similarly", () => {
      // Guards the prefix match itself — "/internal/preview-extra" must not
      // accidentally fall under the "/internal/preview/" prefix.
      expect(isUnsignedBodyPath("/internal/preview-extra")).toBe(false);
      expect(isUnsignedBodyPath("/internal/uploads-extra")).toBe(false);
    });
  });
});
