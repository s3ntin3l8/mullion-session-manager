import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hostIdentityEvents } from "../../src/db/schema.js";
import { recordHostIdentityEvent } from "../../src/services/host-registry.js";

// Issue #3435 — audit trail of host identity lifecycle events and surfacing
// unacknowledged identity replacements on /api/hosts.
const tmpDb = path.join(os.tmpdir(), `host-identity-events-test-${process.pid}.db`);

describe("host identity events (issue #3435)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret-3435"; // pragma: allowlist secret
  });

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("records a single `replaced` event with peer on live-identity claim and surfaces recentIdentityReplacement until acknowledged", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "claimable-box", baseUrl: "http://10.2.0.1:4000" },
    });
    expect(created.statusCode).toBe(201);
    const { id: hostId, token: perHostToken } = created.json() as { id: string; token: string };

    // First claim: establishes the live machine identity (`claimed` event, no `replaced`).
    const firstClaim = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      remoteAddress: "10.2.0.10",
      payload: {
        token: perHostToken,
        hostname: "claimable-box",
        baseUrl: "http://10.2.0.1:4000",
        wantsMachineCredential: true,
      },
    });
    expect(firstClaim.statusCode).toBe(200);
    const firstCred = firstClaim.json().machine_credential as string;

    // Second claim while the first identity is still live: writes `replaced` with peer.
    const secondClaim = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      remoteAddress: "10.2.0.99",
      payload: {
        token: perHostToken,
        hostname: "claimable-box",
        baseUrl: "http://10.2.0.1:4000",
        wantsMachineCredential: true,
      },
    });
    expect(secondClaim.statusCode).toBe(200);
    const secondCred = secondClaim.json().machine_credential as string;
    const secondSessionId = secondClaim.json().session_id as string;
    const secondSessionSecret = secondClaim.json().session_secret as string;

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json() as Array<{
      id: number;
      hostId: string;
      kind: string;
      at: string;
      peer: string | null;
      acknowledgedAt: string | null;
    }>;
    const replacedEvents = events.filter((e) => e.kind === "replaced");
    expect(replacedEvents).toHaveLength(1);
    expect(replacedEvents[0].peer).toBe("10.2.0.99");
    expect(replacedEvents[0].acknowledgedAt).toBeNull();

    // Verify no credential, token, or secret appears anywhere in the serialized event rows.
    const serialized = JSON.stringify(events);
    for (const secret of [
      perHostToken,
      firstCred,
      secondCred,
      secondSessionId,
      secondSessionSecret,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // /api/hosts includes recentIdentityReplacement until acknowledged.
    const listBefore = await app.inject({ method: "GET", url: "/api/hosts" });
    expect(listBefore.statusCode).toBe(200);
    const itemBefore = (listBefore.json() as Array<Record<string, unknown>>).find(
      (h) => h.id === hostId,
    );
    expect(itemBefore?.recentIdentityReplacement).toMatchObject({
      id: replacedEvents[0].id,
      peer: "10.2.0.99",
    });

    const ackRes = await app.inject({
      method: "POST",
      url: `/api/hosts/${hostId}/identity-events/acknowledge`,
    });
    expect(ackRes.statusCode).toBe(200);

    const listAfter = await app.inject({ method: "GET", url: "/api/hosts" });
    const itemAfter = (listAfter.json() as Array<Record<string, unknown>>).find(
      (h) => h.id === hostId,
    );
    expect(itemAfter?.recentIdentityReplacement).toBeNull();
  });

  it("writes `enrolled` on enrollment and no event on normal machine credential renewal", async () => {
    const enrollRes = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      remoteAddress: "10.3.0.5",
      payload: {
        token: "fleet-secret-3435",
        hostname: "enrolled-box",
        baseUrl: "http://10.3.0.5:4000",
        wantsMachineCredential: true,
      },
    });
    expect(enrollRes.statusCode).toBe(200);
    const { host_id: hostId, machine_credential: cred } = enrollRes.json() as {
      host_id: string;
      machine_credential: string;
    };

    const renewRes = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      remoteAddress: "10.3.0.5",
      payload: {
        hostId,
        machineCredential: cred,
        hostname: "enrolled-box",
        baseUrl: "http://10.3.0.5:4000",
      },
    });
    expect(renewRes.statusCode).toBe(200);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json() as Array<{ kind: string; peer: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "enrolled", peer: "10.3.0.5" });
    expect(JSON.stringify(events)).not.toContain("fleet-secret-3435");
    expect(JSON.stringify(events)).not.toContain(cred);
  });

  it("writes `claimed` on first claim", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "manual-box", baseUrl: "http://10.4.0.1:4000" },
    });
    const { id: hostId, token } = created.json() as { id: string; token: string };

    const claimRes = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      remoteAddress: "10.4.0.1",
      payload: {
        token,
        hostname: "manual-box",
        baseUrl: "http://10.4.0.1:4000",
        wantsMachineCredential: true,
      },
    });
    expect(claimRes.statusCode).toBe(200);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    const events = eventsRes.json() as Array<{ kind: string; peer: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "claimed", peer: "10.4.0.1" });
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("writes `paired` on pairing redeem", async () => {
    const issueRes = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { host: "primary.example:3000" },
      payload: { label: "laptop" },
    });
    expect(issueRes.statusCode).toBe(200);
    const { code } = issueRes.json() as { code: string };

    const redeemRes = await app.inject({
      method: "POST",
      url: "/api/internal/pair",
      remoteAddress: "10.5.0.8",
      payload: {
        code,
        requestId: "req-pair-3435-1",
        hostname: "laptop",
      },
    });
    expect(redeemRes.statusCode).toBe(200);
    const { host_id: hostId, machine_credential: cred } = redeemRes.json() as {
      host_id: string;
      machine_credential: string;
    };

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    const events = eventsRes.json() as Array<{ kind: string; peer: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "paired", peer: "10.5.0.8" });
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(cred);
  });

  it("writes `revoked` on revoke and `token_rotated` on rotate-token", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "rotate-revoke-box", baseUrl: "http://10.6.0.1:4000" },
    });
    const { id: hostId } = created.json() as { id: string };

    const rotateRes = await app.inject({
      method: "POST",
      url: `/api/hosts/${hostId}/rotate-token`,
      remoteAddress: "10.6.0.2",
    });
    expect(rotateRes.statusCode).toBe(200);
    const rotatedToken = rotateRes.json().token as string;

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/hosts/${hostId}/revoke`,
      remoteAddress: "10.6.0.3",
    });
    expect(revokeRes.statusCode).toBe(204);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    const events = eventsRes.json() as Array<{ kind: string; peer: string | null }>;
    expect(events.map((e) => ({ kind: e.kind, peer: e.peer }))).toEqual([
      { kind: "revoked", peer: "10.6.0.3" },
      { kind: "token_rotated", peer: "10.6.0.2" },
    ]);
    expect(JSON.stringify(events)).not.toContain(rotatedToken);
  });

  it("caps GET /api/hosts/:id/identity-events at 100 newest-first and deletes events when host is deleted", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "many-events-box", baseUrl: "http://10.7.0.1:4000" },
    });
    const { id: hostId } = created.json() as { id: string };

    for (let i = 0; i < 105; i++) {
      recordHostIdentityEvent(app, hostId, "token_rotated", null);
    }

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/identity-events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    const events = eventsRes.json() as Array<{ id: number }>;
    expect(events).toHaveLength(100);
    expect(events[0].id).toBeGreaterThan(events[99].id);

    const beforeDelete = app.db
      .select()
      .from(hostIdentityEvents)
      .where(eq(hostIdentityEvents.hostId, hostId))
      .all();
    expect(beforeDelete).toHaveLength(100);

    const delRes = await app.inject({ method: "DELETE", url: `/api/hosts/${hostId}` });
    expect(delRes.statusCode).toBe(204);

    const remaining = app.db
      .select()
      .from(hostIdentityEvents)
      .where(eq(hostIdentityEvents.hostId, hostId))
      .all();
    expect(remaining).toHaveLength(0);
  });

  it("returns 404 for unknown host on identity-events and acknowledge, and ignores replacements older than 30 days", async () => {
    const missingGet = await app.inject({
      method: "GET",
      url: "/api/hosts/nonexistent-host/identity-events",
    });
    expect(missingGet.statusCode).toBe(404);

    const missingAck = await app.inject({
      method: "POST",
      url: "/api/hosts/nonexistent-host/identity-events/acknowledge",
    });
    expect(missingAck.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "old-replaced-box", baseUrl: "http://10.8.0.1:4000" },
    });
    const { id: hostId } = created.json() as { id: string };

    app.db
      .insert(hostIdentityEvents)
      .values({
        hostId,
        kind: "replaced",
        at: new Date(Date.now() - 31 * 86_400_000),
        peer: "10.8.0.9",
      })
      .run();

    const listRes = await app.inject({ method: "GET", url: "/api/hosts" });
    const item = (listRes.json() as Array<Record<string, unknown>>).find((h) => h.id === hostId);
    expect(item?.recentIdentityReplacement).toBeNull();
  });
});
