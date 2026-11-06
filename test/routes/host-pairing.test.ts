import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hostPairings, hosts } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import { parsePairingLink } from "../../src/shared/pairing-link.js";
import { listHosts, markChannelConnected } from "../../src/services/host-registry.js";
import {
  consumeHostPairing,
  issueHostPairingCode,
  listHostPairings,
  revokeHostPairing,
} from "../../src/services/host-pairing.js";

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

  it("lets only one of many redemptions win", async () => {
    const p = await create();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => redeem(p.code, { requestId: `request-conc-${i}` })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(pairedRows()).toHaveLength(1);
  });

  // better-sqlite3 is synchronous, so inject() calls never interleave and the
  // test above passes even without the guarded UPDATE. Two consumers holding
  // the SAME unredeemed row is the race the guard exists for.
  it("consumes a pairing row only once when two callers both saw it unredeemed", async () => {
    const issued = issueHostPairingCode(app);
    const row = app.db.select().from(hostPairings).where(eq(hostPairings.id, issued.id)).get()!;
    const input = { requestId: "request-race", hostname: "mac-mini" };
    const first = consumeHostPairing(app, row, "hash-1", input);
    const second = consumeHostPairing(app, row, "hash-2", input);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(pairedRows()).toHaveLength(1);
  });

  it("stores only a hash of the code, never the code", async () => {
    const p = await create();
    const row = app.db.select().from(hostPairings).where(eq(hostPairings.id, p.id)).get()!;
    expect(row.codeHash).toBe(crypto.createHash("sha256").update(p.code).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(p.code);
    expect("codeEnc" in row).toBe(false);
  });

  it("drops the lookup hash once the retry window has passed", async () => {
    const p = await create();
    await redeem(p.code);
    app.db
      .update(hostPairings)
      .set({ redeemedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(hostPairings.id, p.id))
      .run();
    listHostPairings(app);
    const row = app.db.select().from(hostPairings).where(eq(hostPairings.id, p.id)).get()!;
    expect(row.codeHash).toBeNull();
  });

  describe("unclaimed pairings", () => {
    const pairAndAge = async (minutes: number) => {
      const p = await create();
      const body = (await redeem(p.code)).json();
      app.db
        .update(hostPairings)
        .set({ redeemedAt: new Date(Date.now() - minutes * 60 * 1000) })
        .where(eq(hostPairings.id, p.id))
        .run();
      return body.host_id as string;
    };
    const apiHost = async (id: string) => {
      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as Array<{
        id: string;
        unclaimed: boolean;
        paired: boolean;
      }>;
      const host = list.find((h) => h.id === id);
      if (!host) throw new Error(`host ${id} not listed`);
      return host;
    };

    it("is not flagged inside the retry window", async () => {
      const id = await pairAndAge(1);
      expect((await apiHost(id)).unclaimed).toBe(false);
    });

    it("is flagged once the window passed with no renewal and no channel", async () => {
      const id = await pairAndAge(11);
      expect(await apiHost(id)).toMatchObject({ paired: true, unclaimed: true });
    });

    it("is not flagged once the Helper renewed its credential", async () => {
      const id = await pairAndAge(11);
      app.db
        .update(hosts)
        .set({ machineCredentialRotatedAt: new Date() })
        .where(eq(hosts.id, id))
        .run();
      expect((await apiHost(id)).unclaimed).toBe(false);
    });

    it("is not flagged once a channel has connected", async () => {
      const id = await pairAndAge(11);
      markChannelConnected(app, id);
      expect((await apiHost(id)).unclaimed).toBe(false);
      const first = app.db.select().from(hosts).where(eq(hosts.id, id)).get()!
        .channelFirstConnectedAt;
      markChannelConnected(app, id);
      expect(
        app.db.select().from(hosts).where(eq(hosts.id, id)).get()!.channelFirstConnectedAt,
      ).toEqual(first);
    });

    it("is not flagged for a revoked identity or a non-paired host", async () => {
      const id = await pairAndAge(11);
      await app.inject({ method: "POST", url: `/api/hosts/${id}/revoke` });
      expect((await apiHost(id)).unclaimed).toBe(false);
      expect((await apiHost("local")).unclaimed).toBe(false);
    });
  });

  describe("rate limits", () => {
    it("counts only failed redeems toward the redeem limit", async () => {
      // 25 successful redeems do not use up the failure budget.
      for (let i = 0; i < 25; i++) {
        const issued = issueHostPairingCode(app);
        expect((await redeem(issued.code, { requestId: `request-ok-${i}` })).statusCode).toBe(200);
      }
      for (let i = 0; i < 20; i++) expect((await redeem("cd".repeat(32))).statusCode).toBe(401);
      const blocked = await redeem("cd".repeat(32));
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    });

    describe("blocked address", () => {
      const exhaust = async () => {
        for (let i = 0; i < 20; i++) expect((await redeem("cd".repeat(32))).statusCode).toBe(401);
        expect((await redeem("cd".repeat(32))).statusCode).toBe(429);
      };

      it("still redeems a valid code, and a wrong code is still 429", async () => {
        await exhaust();
        const valid = issueHostPairingCode(app);
        expect((await redeem(valid.code, { requestId: "request-late" })).statusCode).toBe(200);
        const blocked = await redeem("ef".repeat(32));
        expect(blocked.statusCode).toBe(429);
        expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      });

      it("still answers a same-request retry, but not a different request id", async () => {
        const p = issueHostPairingCode(app);
        expect((await redeem(p.code, { requestId: "request-keep" })).statusCode).toBe(200);
        await exhaust();
        expect((await redeem(p.code, { requestId: "request-keep" })).statusCode).toBe(200);
        expect((await redeem(p.code, { requestId: "request-other" })).statusCode).toBe(429);
      });

      it("does not let a revoked code through", async () => {
        const revoked = issueHostPairingCode(app);
        revokeHostPairing(app, revoked.id);
        await exhaust();
        expect((await redeem(revoked.code)).statusCode).toBe(429);
      });

      it("does not count matching redeems as failures", async () => {
        await exhaust();
        for (let i = 0; i < 25; i++) {
          const issued = issueHostPairingCode(app);
          expect((await redeem(issued.code, { requestId: `request-ok-${i}` })).statusCode).toBe(
            200,
          );
        }
        // A matching request with a bad baseUrl (400) is not a failure either.
        const bad = issueHostPairingCode(app);
        expect((await redeem(bad.code, { baseUrl: "ftp://x" })).statusCode).toBe(400);
        // Still blocked for non-matching traffic, with the same single window.
        expect((await redeem("ef".repeat(32))).statusCode).toBe(429);
      });
    });

    it("counts schema failures (400) as failures", async () => {
      for (let i = 0; i < 20; i++) {
        expect(
          (await app.inject({ method: "POST", url: "/api/internal/pair", payload: { code: "x" } }))
            .statusCode,
        ).toBe(400);
      }
      expect((await redeem("cd".repeat(32))).statusCode).toBe(429);
    });

    it("is not exhausted by unrelated traffic", async () => {
      for (let i = 0; i < 30; i++) await app.inject({ method: "GET", url: "/api/hosts" });
      const p = await create();
      expect((await redeem(p.code)).statusCode).toBe(200);
    });

    it("gives the authenticated issue route its own bucket", async () => {
      for (let i = 0; i < 20; i++) await create();
      const over = await app.inject({ method: "POST", url: "/api/host-pairings", payload: {} });
      expect(over.statusCode).toBe(429);
      // The redeem route is unaffected by the issue route's bucket.
      expect((await redeem("cd".repeat(32))).statusCode).toBe(401);
    });
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

  it("bounds the redeem body field sizes", async () => {
    const p = await create();
    expect((await redeem(p.code, { name: "n".repeat(121) })).statusCode).toBe(400);
    expect((await redeem(p.code, { hostname: "h".repeat(256) })).statusCode).toBe(400);
    expect((await redeem(p.code, { capabilities: ["c".repeat(65)] })).statusCode).toBe(400);
    expect(
      (await redeem(p.code, { capabilities: Array.from({ length: 65 }, () => "c") })).statusCode,
    ).toBe(400);
    expect((await redeem(p.code, { capabilities: ["xcode", "docker"] })).statusCode).toBe(200);
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

describe("pairing link public URL (issue #2597)", () => {
  const tmp = path.join(os.tmpdir(), `host-pairing-url-test-${process.pid}.db`);
  beforeAll(() => {
    fs.rmSync(tmp, { force: true });
    process.env.DATABASE_URL = `file:${tmp}`;
  });
  afterEach(() => {
    delete process.env.MULLION_PUBLIC_URL;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmp, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("uses MULLION_PUBLIC_URL instead of the request headers", async () => {
    process.env.MULLION_PUBLIC_URL = "https://mullion.example.com";
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/host-pairings",
        headers: { host: "internal-proxy:4000" },
        payload: {},
      });
      expect(res.json().url).toBe("https://mullion.example.com");
      expect(parsePairingLink(res.json().pairing_link)?.url).toBe("https://mullion.example.com");
    } finally {
      await app.close();
    }
  });

  it.each(["ftp://x.test", "https://u:p@x.test", "https://x.test/base", "not a url"])(
    "refuses to boot with %s",
    async (value) => {
      process.env.MULLION_PUBLIC_URL = value;
      await expect(buildApp()).rejects.toThrow(/MULLION_PUBLIC_URL/);
    },
  );
});
