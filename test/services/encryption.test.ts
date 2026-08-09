import { describe, it, expect } from "vitest";
import { EncryptionService, DecryptionError } from "../../src/services/encryption.js";
import crypto from "node:crypto";

describe("EncryptionService", () => {
  const key = crypto.randomBytes(32).toString("base64url");

  describe("when encryption is enabled", () => {
    const svc = new EncryptionService({ key });

    it("encrypts and decrypts a string round-trip", () => {
      const token = svc.encryptString("hunter2");
      expect(token).not.toBe("hunter2");
      expect(svc.decryptString(token)).toBe("hunter2");
    });

    it("encrypts and decrypts JSON round-trip", () => {
      const data = { a: 1, b: ["x", "y"] };
      expect(svc.decryptJson(svc.encryptJson(data))).toEqual(data);
    });

    it("isEnabled returns true", () => {
      expect(svc.isEnabled).toBe(true);
    });

    it("throws DecryptionError for malformed ciphertext with valid prefix", () => {
      expect(() => svc.decryptString("enc:AAAA:BBBB:CCCC")).toThrow(DecryptionError);
    });

    it("returns legacy plaintext unchanged if it lacks the prefix", () => {
      expect(svc.decryptString("legacy-plaintext")).toBe("legacy-plaintext");
    });
  });

  describe("when encryption is disabled (empty key)", () => {
    const svc = new EncryptionService({ key: "" });

    it("isEnabled returns false", () => {
      expect(svc.isEnabled).toBe(false);
    });

    it("passes strings through unchanged", () => {
      expect(svc.encryptString("plain")).toBe("plain");
      expect(svc.decryptString("plain")).toBe("plain");
    });
  });

  // Security audit finding AS3: the old constructor did
  // `Buffer.from(opts.key, "base64url").subarray(0, 32)` with no length
  // check, so a short/malformed key was silently truncated to whatever fit
  // rather than rejected. Two concrete failure modes this closes.
  describe("key length validation (finding AS3)", () => {
    it("throws when the decoded key is shorter than 32 bytes", () => {
      const shortKey = crypto.randomBytes(15).toString("base64url");
      expect(() => new EncryptionService({ key: shortKey })).toThrow(/32 bytes/);
    });

    it("throws for a plain passphrase that isn't valid base64url — decodes short, not 32 bytes", () => {
      expect(() => new EncryptionService({ key: "my-secret-passphrase!!" })).toThrow(/32 bytes/);
    });

    it("throws for a 'rotated' key that shares the same first 32 decoded bytes as another — no silent no-op rotation", () => {
      // Before the fix, appending extra bytes to an existing key produced a
      // Buffer whose first 32 bytes were untouched by subarray(0, 32) — so
      // "rotating" to this value would have decrypted every existing
      // ciphertext identically to the original key, with the operator
      // believing a compromised key had been retired. Now both fail to even
      // construct, since neither decodes to exactly 32 bytes.
      const base = crypto.randomBytes(32);
      const rotated = Buffer.concat([base, crypto.randomBytes(8)]);
      expect(() => new EncryptionService({ key: base.toString("base64url") })).not.toThrow();
      expect(() => new EncryptionService({ key: rotated.toString("base64url") })).toThrow(
        /32 bytes/,
      );
    });

    it("accepts exactly 32 decoded bytes and round-trips correctly", () => {
      const exact = crypto.randomBytes(32).toString("base64url");
      const svc = new EncryptionService({ key: exact });
      const token = svc.encryptString("hello world");
      expect(svc.decryptString(token)).toBe("hello world");
    });
  });
});
