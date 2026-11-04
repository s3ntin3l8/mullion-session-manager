import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hostPairings, hosts } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { parsePairingLink } from "../../src/shared/pairing-link.js";
import { listHosts } from "../../src/services/host-registry.js";

// Issue #2449 — one-time execution-host pairing.
const tmpDb = path.join(os.tmpdir(), `host-pairing-test-${process.pid}.db`);

describe("host pairing (issue #2449)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  beforeEach(async () => {
    app = await buildApp();
    app.db.delete(hostPairings).run();
    app.db.delete(hosts).where(eq(hosts.origin, "enrolled")).run();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  const create = async (payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { host: "primary.test:4000" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; pairing_link: string; code: string; expires_at: string };
  };
  const redeem = (code: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/internal/pair",
      payload: { code, requestId: "request-0001", hostname: "mac-mini", ...extra },
    });
  const pairedRows = () => app.db.select().from(hosts).where(eq(hosts.origin, "enrolled")).all();

  it("returns a link carrying only the primary url and the code", async () => {
    const p = await create();
    const parsed = parsePairingLink(p.pairing_link);
    expect(parsed).toEqual({ url: "http://primary.test:4000", code: p.code });
    expect(new URL(p.pairing_link).searchParams.size).toBe(2);
    expect(Date.parse(p.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("redeems a code for a host identity and credential, and lists it as paired", async () => {
    const p = await create({ label: "Mac mini" });
    const res = await redeem(p.code, { platform: "darwin" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machine_credential).toMatch(/^[0-9a-f]{64}$/);
    expect(body.session_id).toMatch(/^[0-9a-f]{64}$/);
    const host = listHosts(app).find((h) => h.id === body.host_id)!;
    expect(host).toMatchObject({
      paired: true,
      hasMachineIdentity: true,
      origin: "enrolled",
      platform: "darwin",
      name: "Mac mini",
    });
    // Pairing success is not reachability: no URL was advertised.
    expect(host.baseUrl).toBeNull();
    const list = (await app.inject({ method: "GET", url: "/api/host-pairings" })).json();
    expect(list[0]).toMatchObject({ id: p.id, state: "paired", host_id: body.host_id });
    // The issued credential renews like any other machine credential.
    const renewed = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        hostId: body.host_id,
        machineCredential: body.machine_credential,
        baseUrl: "http://10.0.0.5:4000",
        hostname: "mac-mini",
      },
    });
    expect(renewed.statusCode).toBe(200);
  });

  it("does not redeem a replayed code with a different request id", async () => {
    const p = await create();
    expect((await redeem(p.code)).statusCode).toBe(200);
    const replay = await redeem(p.code, { requestId: "request-other" });
    expect(replay.statusCode).toBe(401);
    expect(pairedRows()).toHaveLength(1);
  });

  it("lets only one of many concurrent redemptions win", async () => {
    const p = await create();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => redeem(p.code, { requestId: `request-conc-${i}` })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(pairedRows()).toHaveLength(1);
  });

  it("rejects an expired code", async () => {
    const p = await create();
    app.db
      .update(hostPairings)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(hostPairings.id, p.id))
      .run();
    expect((await redeem(p.code)).statusCode).toBe(401);
    expect(pairedRows()).toHaveLength(0);
    const list = (await app.inject({ method: "GET", url: "/api/host-pairings" })).json();
    expect(list[0].state).toBe("expired");
  });

  it("rejects malformed and unknown codes uniformly", async () => {
    await create();
    expect((await redeem("short")).statusCode).toBe(401);
    expect((await redeem("cd".repeat(32))).statusCode).toBe(401);
    expect(pairedRows()).toHaveLength(0);
  });

  it("rejects a cancelled code", async () => {
    const p = await create();
    expect(
      (await app.inject({ method: "DELETE", url: `/api/host-pairings/${p.id}` })).statusCode,
    ).toBe(204);
    expect((await redeem(p.code)).statusCode).toBe(401);
    const list = (await app.inject({ method: "GET", url: "/api/host-pairings" })).json();
    expect(list[0].state).toBe("revoked");
    // Already-redeemed pairings cannot be cancelled; revoke the host instead.
    const q = await create();
    await redeem(q.code);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/host-pairings/${q.id}` })).statusCode,
    ).toBe(404);
  });

  it("converges an interrupted setup onto the same host on a same-request retry", async () => {
    const p = await create();
    const first = (await redeem(p.code)).json();
    // The Helper never saw `first`; it retries with the same request id.
    const retry = await redeem(p.code);
    expect(retry.statusCode).toBe(200);
    const second = retry.json();
    expect(second.host_id).toBe(first.host_id);
    expect(second.machine_credential).not.toBe(first.machine_credential);
    expect(pairedRows()).toHaveLength(1);
    // The never-delivered first credential is dead; the retried one works.
    const reg = (cred: string) =>
      app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          hostId: first.host_id,
          machineCredential: cred,
          baseUrl: "http://10.0.0.5:4000",
          hostname: "x",
        },
      });
    expect((await reg(first.machine_credential)).statusCode).toBe(401);
    expect((await reg(second.machine_credential)).statusCode).toBe(200);
    // Once the Helper has renewed, the code can no longer be retried.
    expect((await redeem(p.code)).statusCode).toBe(401);
  });

  it("refuses a retry after the host's identity was revoked", async () => {
    const p = await create();
    const first = (await redeem(p.code)).json();
    expect(
      (await app.inject({ method: "POST", url: `/api/hosts/${first.host_id}/revoke` })).statusCode,
    ).toBe(204);
    expect((await redeem(p.code)).statusCode).toBe(401);
    // Revocation stays final: the old credential no longer renews either.
    const renew = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        hostId: first.host_id,
        machineCredential: first.machine_credential,
        baseUrl: "http://10.0.0.5:4000",
        hostname: "x",
      },
    });
    expect(renew.statusCode).toBe(401);
  });

  it("refuses a retry once the retry window has passed", async () => {
    const p = await create();
    await redeem(p.code);
    app.db
      .update(hostPairings)
      .set({ redeemedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(hostPairings.id, p.id))
      .run();
    expect((await redeem(p.code)).statusCode).toBe(401);
  });

  it("leaves manual hosts untouched", async () => {
    const p = await create();
    await redeem(p.code);
    expect(listHosts(app).every((h) => h.origin === "manual" || h.paired)).toBe(true);
  });

  it("validates the redeem body", async () => {
    const p = await create();
    expect((await redeem(p.code, { baseUrl: "ftp://x" })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/internal/pair", payload: { code: p.code } }))
        .statusCode,
    ).toBe(400);
  });
});
