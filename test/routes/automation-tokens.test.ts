import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { automationTokens, hostIdentityEvents, hostPairings, hosts } from "../../src/db/schema.js";

// Issue #3440 — automation tokens that mint one-off pairing codes.
const tmpDb = path.join(os.tmpdir(), `automation-tokens-test-${process.pid}.db`);
const OPERATOR_TOKEN = "operator-auth-token-0123456789abcdef"; // pragma: allowlist secret

describe("automation tokens (issue #3440)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_AUTH_TOKEN = OPERATOR_TOKEN;
    process.env.MULLION_SESSION_SECRET = "test-session-secret-3440-0123456789"; // pragma: allowlist secret
  });

  beforeEach(async () => {
    app = await buildApp();
    app.db.delete(hostIdentityEvents).run();
    app.db.delete(hostPairings).run();
    app.db.delete(automationTokens).run();
    app.db.delete(hosts).where(eq(hosts.origin, "enrolled")).run();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
  });

  const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };

  async function createToken(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      headers: operatorHeaders,
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {
      id: string;
      label: string;
      scopes: string[];
      token: string;
      expires_at: string;
      allowed_cidrs: string | null;
      require_approval: boolean;
      last_used_at: string | null;
      revoked_at: string | null;
      state: string;
    };
  }

  it("enforces enroll vs repair scopes, records mintedByTokenId/requireApproval/lastUsedAt, and redeems via /api/internal/pair", async () => {
    const enrollToken = await createToken({
      label: "ansible-enroll",
      scopes: ["enroll"],
      requireApproval: true,
    });
    expect(enrollToken.token).toMatch(/^mat_[0-9a-f]{64}$/);
    expect(enrollToken.require_approval).toBe(true);
    expect(enrollToken.state).toBe("active");

    // Enroll token mints a new-host pairing code (no hostId).
    const mintRes = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${enrollToken.token}`,
      },
      remoteAddress: "10.1.2.3",
      payload: { label: "worker-01" },
    });
    expect(mintRes.statusCode).toBe(200);
    const minted = mintRes.json() as { id: string; code: string };

    // Pairing row records mintedByTokenId and a copy of requireApproval; lastUsedAt is updated.
    const pairingRow = app.db
      .select()
      .from(hostPairings)
      .where(eq(hostPairings.id, minted.id))
      .get();
    expect(pairingRow?.mintedByTokenId).toBe(enrollToken.id);
    expect(pairingRow?.requireApproval).toBe(true);

    const tokenRow = app.db
      .select()
      .from(automationTokens)
      .where(eq(automationTokens.id, enrollToken.id))
      .get();
    expect(tokenRow?.lastUsedAt).not.toBeNull();

    // Redeems into a new host via /api/internal/pair.
    const redeemRes = await app.inject({
      method: "POST",
      url: "/api/internal/pair",
      payload: {
        code: minted.code,
        requestId: "req-enroll-3440-1",
        hostname: "worker-01",
      },
    });
    expect(redeemRes.statusCode).toBe(200);
    const hostId = redeemRes.json().host_id as string;

    // Enroll-only token with hostId gets 403.
    const forbiddenRepair = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${enrollToken.token}`,
      },
      payload: { hostId },
    });
    expect(forbiddenRepair.statusCode).toBe(403);

    // Repair-only token is the reverse: 403 without hostId, 200 with hostId.
    const repairToken = await createToken({
      label: "ansible-repair",
      scopes: ["repair"],
    });
    const forbiddenEnroll = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${repairToken.token}`,
      },
      payload: { label: "should-fail" },
    });
    expect(forbiddenEnroll.statusCode).toBe(403);

    const repairMint = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${repairToken.token}`,
      },
      remoteAddress: "10.1.2.4",
      payload: { hostId },
    });
    expect(repairMint.statusCode).toBe(200);
  });

  it("rejects expired, revoked, CIDR-mismatched, unauthenticated, and wrong-route requests with 401", async () => {
    // Unauthenticated POST /api/host-pairings is still 401.
    const unauth = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { host: "primary.test:4000" },
      payload: {},
    });
    expect(unauth.statusCode).toBe(401);

    // CIDR-restricted token uses raw TCP peer (ignores X-Forwarded-For).
    const cidrToken = await createToken({
      label: "cidr-locked",
      scopes: ["enroll"],
      allowedCidrs: "10.20.0.0/16",
    });
    const badSource = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${cidrToken.token}`,
        "x-forwarded-for": "10.20.1.5",
      },
      remoteAddress: "192.168.1.50",
      payload: {},
    });
    expect(badSource.statusCode).toBe(401);

    const goodSource = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${cidrToken.token}`,
      },
      remoteAddress: "10.20.1.5",
      payload: {},
    });
    expect(goodSource.statusCode).toBe(200);

    // Automation token is rejected on every other route.
    for (const req of [
      { method: "GET" as const, url: "/api/hosts" },
      { method: "GET" as const, url: "/api/host-pairings" },
      { method: "DELETE" as const, url: "/api/host-pairings/nonexistent" },
      { method: "GET" as const, url: "/api/automation-tokens" },
      {
        method: "POST" as const,
        url: "/api/automation-tokens",
        payload: { label: "x", scopes: ["enroll"] },
      },
      { method: "DELETE" as const, url: `/api/automation-tokens/${cidrToken.id}` },
    ]) {
      const res = await app.inject({
        ...req,
        headers: { authorization: `Bearer ${cidrToken.token}` },
      });
      expect(res.statusCode).toBe(401);
    }

    // Revoked token gets 401.
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/automation-tokens/${cidrToken.id}`,
      headers: operatorHeaders,
    });
    expect(revokeRes.statusCode).toBe(204);
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${cidrToken.token}`,
      },
      remoteAddress: "10.20.1.5",
      payload: {},
    });
    expect(afterRevoke.statusCode).toBe(401);

    // Expired token gets 401.
    const expToken = await createToken({ label: "expired-tok", scopes: ["enroll"] });
    app.db
      .update(automationTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(automationTokens.id, expToken.id))
      .run();
    const afterExpire = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${expToken.token}`,
      },
      payload: {},
    });
    expect(afterExpire.statusCode).toBe(401);
  });

  it("never exposes the plaintext secret in GET, DB rows, event rows, or logs, and writes code_minted events", async () => {
    const logged: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      logged.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);

    const tok = await createToken({ label: "audit-token", scopes: ["enroll"] });
    const mintRes = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${tok.token}`,
      },
      remoteAddress: "10.9.8.7",
      payload: {},
    });
    expect(mintRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/automation-tokens",
      headers: operatorHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    const listJson = listRes.body;
    expect(listJson).not.toContain(tok.token);
    expect(listJson).not.toContain("secretHash");

    const dbTokens = app.db.select().from(automationTokens).all();
    const dbPairings = app.db.select().from(hostPairings).all();
    const dbEvents = app.db.select().from(hostIdentityEvents).all();

    expect(JSON.stringify(dbTokens)).not.toContain(tok.token);
    expect(JSON.stringify(dbPairings)).not.toContain(tok.token);
    expect(JSON.stringify(dbEvents)).not.toContain(tok.token);
    expect(logged.join("\n")).not.toContain(tok.token);

    const mintedEvents = dbEvents.filter((e) => e.kind === "code_minted");
    expect(mintedEvents).toHaveLength(1);
    expect(mintedEvents[0]).toMatchObject({
      kind: "code_minted",
      hostId: null,
      peer: "10.9.8.7",
      label: "audit-token",
    });
  });

  it("rate limits per token id so one token's flood does not block another", async () => {
    const tokenA = await createToken({ label: "flood-a", scopes: ["enroll"] });
    const tokenB = await createToken({ label: "victim-b", scopes: ["enroll"] });

    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/host-pairings",
        headers: {
          host: "primary.test:4000",
          authorization: `Bearer ${tokenA.token}`,
        },
        remoteAddress: "10.0.0.10",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }

    const blockedA = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${tokenA.token}`,
      },
      remoteAddress: "10.0.0.10",
      payload: {},
    });
    expect(blockedA.statusCode).toBe(429);

    // Same IP, different token: not blocked.
    const allowedB = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: {
        host: "primary.test:4000",
        authorization: `Bearer ${tokenB.token}`,
      },
      remoteAddress: "10.0.0.10",
      payload: {},
    });
    expect(allowedB.statusCode).toBe(200);
  });

  it("validates create input on POST /api/automation-tokens", async () => {
    const blankLabel = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      headers: operatorHeaders,
      payload: { label: "   ", scopes: ["enroll"] },
    });
    expect(blankLabel.statusCode).toBe(400);

    const badCidr = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      headers: operatorHeaders,
      payload: { label: "bad-cidr", scopes: ["enroll"], allowedCidrs: "10.0.0.0/" },
    });
    expect(badCidr.statusCode).toBe(400);

    const overMaxDays = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      headers: operatorHeaders,
      payload: { label: "too-long", scopes: ["enroll"], expiresInDays: 366 },
    });
    expect(overMaxDays.statusCode).toBe(400);
  });
});
