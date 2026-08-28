import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  clearBridgeSession,
  deleteBridge,
  decodePairingPayload,
  encodePairingPayload,
  getBridgeRow,
  issuePairingCode,
  listBridges,
  redeemPairingCode,
  rotateBridgeSession,
  touchBridgeLastSeen,
  verifyBridgeSession,
} from "../../src/services/bridge-registry.js";

const tmpDb = path.join(os.tmpdir(), `bridge-registry-test-${process.pid}.db`);

describe("bridge-registry", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("starts with no bridges on a fresh DB", async () => {
    const app = await buildApp();
    expect(listBridges(app)).toEqual([]);
    await app.close();
  });

  it("issuePairingCode creates an unpaired row with no session and no name yet", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const row = getBridgeRow(app, pairing.bridgeId)!;
    expect(row).toBeDefined();
    expect(row.name).toBeNull();
    expect(row.sessionIdEnc).toBeNull();
    expect(row.pairingSecretEnc).not.toBeNull();
    expect(pairing.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await app.close();
  });

  it("redeemPairingCode issues a session and clears the pairing fields — single-use", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);

    const session = redeemPairingCode(app, pairing.code, { name: "MacBook", platform: "darwin" });
    expect(session).not.toBeNull();
    expect(session!.bridgeId).toBe(pairing.bridgeId);

    const row = getBridgeRow(app, pairing.bridgeId)!;
    expect(row.name).toBe("MacBook");
    expect(row.platform).toBe("darwin");
    expect(row.pairingSecretEnc).toBeNull();
    expect(row.pairingExpiresAt).toBeNull();
    expect(row.sessionIdEnc).not.toBeNull();

    // The same code must never redeem twice.
    const second = redeemPairingCode(app, pairing.code, { name: "Retry" });
    expect(second).toBeNull();
    await app.close();
  });

  // Mirrors host-registry.test.ts's own "a corrupt candidate row's decrypt
  // failure doesn't break a match on a different row" — redeemPairingCode
  // decrypts every unexpired candidate unconditionally (the same AS13-style
  // fix claimHost uses), so a single corrupt row anywhere must not deny a
  // legitimate redeem of a different, healthy row.
  it("a corrupt candidate row's decrypt failure doesn't break a redeem on a different row", async () => {
    const app = await buildApp();
    const healthy = issuePairingCode(app);
    const corrupt = issuePairingCode(app);
    const corruptCiphertext = getBridgeRow(app, corrupt.bridgeId)!.pairingSecretEnc!;

    const original = app.encryption.decryptString.bind(app.encryption);
    vi.spyOn(app.encryption, "decryptString").mockImplementation((ciphertext: string) => {
      if (ciphertext === corruptCiphertext) {
        throw new Error("simulated corrupt row (bad GCM auth tag)");
      }
      return original(ciphertext);
    });

    const result = redeemPairingCode(app, healthy.code, { name: "healthy-one" });

    expect(result).not.toBeNull();
    expect(result!.bridgeId).toBe(healthy.bridgeId);
    vi.restoreAllMocks();
    await app.close();
  });

  it("redeemPairingCode rejects an unknown code without throwing", async () => {
    const app = await buildApp();
    expect(redeemPairingCode(app, "not-a-real-code", {})).toBeNull();
    await app.close();
  });

  it("redeemPairingCode rejects an expired code", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    // Force expiry directly — issuePairingCode's own TTL is 10 minutes,
    // too long to wait out in a test.
    const { bridges } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    app.db
      .update(bridges)
      .set({ pairingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(bridges.id, pairing.bridgeId))
      .run();

    expect(redeemPairingCode(app, pairing.code, {})).toBeNull();
    await app.close();
  });

  it("redeemPairingCode defaults name to null when the caller doesn't supply one", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    redeemPairingCode(app, pairing.code, {});
    expect(getBridgeRow(app, pairing.bridgeId)!.name).toBeNull();
    await app.close();
  });

  it("stores pairing and session secrets opaque to EncryptionService when DB_ENCRYPTION_KEY is set", async () => {
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const beforeRedeem = getBridgeRow(app, pairing.bridgeId)!;
    expect(beforeRedeem.pairingSecretEnc).not.toBe(pairing.code);

    const session = redeemPairingCode(app, pairing.code, {})!;
    const afterRedeem = getBridgeRow(app, pairing.bridgeId)!;
    expect(afterRedeem.sessionIdEnc).not.toBe(session.sessionId);
    expect(afterRedeem.sessionSecretEnc).not.toBe(session.sessionSecret);
    await app.close();
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("rotateBridgeSession issues a fresh session and returns null for a stale/wrong session id", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const session = redeemPairingCode(app, pairing.code, {})!;

    const rotated = rotateBridgeSession(app, session.bridgeId, session.sessionId);
    expect(rotated).not.toBeNull();
    expect(rotated!.sessionId).not.toBe(session.sessionId);

    // The OLD session id must no longer verify after rotation.
    expect(verifyBridgeSession(app, session.bridgeId, session.sessionId)).toBe(false);
    expect(verifyBridgeSession(app, session.bridgeId, rotated!.sessionId)).toBe(true);

    expect(rotateBridgeSession(app, session.bridgeId, "wrong-session-id")).toBeNull();
    await app.close();
  });

  it("verifyBridgeSession returns false for an unknown bridge id", async () => {
    const app = await buildApp();
    expect(verifyBridgeSession(app, "does-not-exist", "anything")).toBe(false);
    await app.close();
  });

  it("clearBridgeSession revokes the session outright — nothing verifies afterward", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const session = redeemPairingCode(app, pairing.code, {})!;
    expect(verifyBridgeSession(app, session.bridgeId, session.sessionId)).toBe(true);

    clearBridgeSession(app, session.bridgeId);

    expect(verifyBridgeSession(app, session.bridgeId, session.sessionId)).toBe(false);
    const row = getBridgeRow(app, session.bridgeId)!;
    expect(row.sessionIdEnc).toBeNull();
    expect(row.sessionSecretEnc).toBeNull();
    expect(row.sessionExpiresAt).toBeNull();
    await app.close();
  });

  it("touchBridgeLastSeen updates lastSeenAt without disturbing the session", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const session = redeemPairingCode(app, pairing.code, {})!;
    expect(getBridgeRow(app, session.bridgeId)!.lastSeenAt).not.toBeNull(); // set by redeem itself

    const before = getBridgeRow(app, session.bridgeId)!.lastSeenAt;
    // The timestamp column has whole-second precision (sqlite integer
    // "timestamp" mode) — a sub-second gap wouldn't move it at all.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    touchBridgeLastSeen(app, session.bridgeId);

    const row = getBridgeRow(app, session.bridgeId)!;
    expect(row.lastSeenAt!.getTime()).toBeGreaterThan(before!.getTime());
    expect(verifyBridgeSession(app, session.bridgeId, session.sessionId)).toBe(true);
    await app.close();
  });

  it("listBridges reports hasLiveSession correctly across the pairing/session lifecycle", async () => {
    // DB is shared across this whole file's tests (matches
    // host-registry.test.ts's own beforeAll/afterAll structure) — assert
    // on this test's own row via .find(), not on the full list, since
    // earlier tests' rows are still present.
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    const findOwn = () => listBridges(app).find((b) => b.id === pairing.bridgeId);
    expect(findOwn()).toEqual(
      expect.objectContaining({ id: pairing.bridgeId, hasLiveSession: false }),
    );

    const session = redeemPairingCode(app, pairing.code, { name: "Windows PC" })!;
    expect(findOwn()).toEqual(
      expect.objectContaining({ id: session.bridgeId, name: "Windows PC", hasLiveSession: true }),
    );

    clearBridgeSession(app, session.bridgeId);
    expect(findOwn()).toEqual(
      expect.objectContaining({ id: session.bridgeId, hasLiveSession: false }),
    );
    await app.close();
  });

  it("deleteBridge removes the row", async () => {
    const app = await buildApp();
    const pairing = issuePairingCode(app);
    deleteBridge(app, pairing.bridgeId);
    expect(getBridgeRow(app, pairing.bridgeId)).toBeUndefined();
    await app.close();
  });

  it("deleteBridge on an unknown id is a silent no-op, not an error", async () => {
    const app = await buildApp();
    expect(() => deleteBridge(app, "does-not-exist")).not.toThrow();
    await app.close();
  });

  describe("encodePairingPayload / decodePairingPayload", () => {
    it("round-trips baseUrl and code", () => {
      const encoded = encodePairingPayload({
        baseUrl: "https://mullion.example.com",
        code: "abc123",
      });
      expect(decodePairingPayload(encoded)).toEqual({
        baseUrl: "https://mullion.example.com",
        code: "abc123",
      });
    });

    it("is not raw JSON — the encoded form doesn't leak the URL/code in plain sight", () => {
      const encoded = encodePairingPayload({
        baseUrl: "https://mullion.example.com",
        code: "abc123",
      });
      expect(encoded).not.toContain("mullion.example.com");
      expect(encoded).not.toContain("abc123");
    });

    it("returns null for garbage input rather than throwing", () => {
      expect(decodePairingPayload("not-valid-base64url-json!!!")).toBeNull();
      expect(decodePairingPayload("")).toBeNull();
    });

    it("returns null for well-formed base64url JSON missing required fields", () => {
      const malformed = Buffer.from(JSON.stringify({ baseUrl: "https://x" }), "utf8").toString(
        "base64url",
      );
      expect(decodePairingPayload(malformed)).toBeNull();
    });

    it("returns null when a field is present but the wrong type", () => {
      const malformed = Buffer.from(
        JSON.stringify({ baseUrl: "https://x", code: 12345 }),
        "utf8",
      ).toString("base64url");
      expect(decodePairingPayload(malformed)).toBeNull();
    });

    it("returns null for an empty-string field", () => {
      const malformed = Buffer.from(JSON.stringify({ baseUrl: "", code: "x" }), "utf8").toString(
        "base64url",
      );
      expect(decodePairingPayload(malformed)).toBeNull();
    });

    it("returns null when the decoded JSON isn't an object", () => {
      const malformed = Buffer.from(JSON.stringify("just a string"), "utf8").toString("base64url");
      expect(decodePairingPayload(malformed)).toBeNull();
    });
  });
});
