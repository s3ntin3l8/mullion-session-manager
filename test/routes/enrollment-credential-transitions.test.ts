import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { getHostRow, listHosts } from "../../src/services/host-registry.js";

// Issue #2452 — the three credential transitions have deterministic results,
// and none of them lets stale bootstrap state win back revoked authority:
//   renewal         every identity-authenticated renewal rotates the credential
//   revoke          POST /api/hosts/:id/revoke — final
//   rotate-token    POST /api/hosts/:id/rotate-token — re-arms a revoked row
// plus a primary restart, which must change none of those outcomes.
const tmpDb = path.join(os.tmpdir(), `enrollment-transitions-test-${process.pid}.db`);
const HOUR = 60 * 60 * 1000;

describe("credential transitions (issue #2452)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret"; // pragma: allowlist secret
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

  const register = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { hostname: "box", ...payload },
    });
  const renew = (hostId: string, machineCredential: string, extra = {}) =>
    register({ hostId, machineCredential, ...extra });
  const post = (url: string) => app.inject({ method: "POST", url });

  // A per-host bootstrap token (the row an operator pre-creates), claimed once
  // by an agent that wants a machine credential.
  async function claimedHost(name: string) {
    const created = (
      await app.inject({ method: "POST", url: "/api/hosts", payload: { name } })
    ).json() as { id: string; token: string };
    const claim = await register({
      token: created.token,
      wantsMachineCredential: true,
    });
    expect(claim.statusCode).toBe(200);
    return { id: created.id, token: created.token, first: claim.json() };
  }

  describe("renewal", () => {
    it("rotates the credential on every renewal and keeps the previous one valid for the 24 h grace only", async () => {
      const { id, first } = await claimedHost("renewing");
      expect(first.host_id).toBe(id);
      const second = (await renew(id, first.machine_credential)).json();
      const third = (await renew(id, second.machine_credential)).json();
      const creds = [first, second, third].map((r) => r.machine_credential as string);
      expect(new Set(creds).size).toBe(3);

      // Only one previous credential is honoured: the one just replaced.
      const stale = await renew(id, first.machine_credential);
      expect(stale.statusCode).toBe(401);
      const prev = await renew(id, second.machine_credential);
      expect(prev.statusCode).toBe(200);
      // ...converging on the credential already issued, not rotating further.
      expect(prev.json().machine_credential).toBe(third.machine_credential);

      app.db
        .update(hosts)
        .set({ machineCredentialRotatedAt: new Date(Date.now() - 25 * HOUR) })
        .where(eq(hosts.id, id))
        .run();
      expect((await renew(id, second.machine_credential)).statusCode).toBe(401);
      // The current credential never depended on the grace window.
      expect((await renew(id, third.machine_credential)).statusCode).toBe(200);
    });

    it("rejects an expired credential, and the bootstrap token does not replace it", async () => {
      const { id, token, first } = await claimedHost("expiring");
      app.db
        .update(hosts)
        .set({ machineCredentialExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(hosts.id, id))
        .run();
      expect((await renew(id, first.machine_credential)).statusCode).toBe(401);
      // Re-enrolling is the operator's deliberate act with the bootstrap
      // token: it reaches the SAME row and issues a replacement credential.
      const reclaim = await register({ token, wantsMachineCredential: true });
      expect(reclaim.statusCode).toBe(200);
      expect(reclaim.json().host_id).toBe(id);
      expect((await renew(id, reclaim.json().machine_credential)).statusCode).toBe(200);
    });

    it("survives a primary restart: the rotated credential and one row remain", async () => {
      const { id, first } = await claimedHost("restarting");
      const rotated = (await renew(id, first.machine_credential)).json();
      const rows = listHosts(app).length;

      await app.close();
      app = await buildApp();

      expect(listHosts(app)).toHaveLength(rows);
      const afterRestart = await renew(id, rotated.machine_credential);
      expect(afterRestart.statusCode).toBe(200);
      expect(afterRestart.json().host_id).toBe(id);
      expect(listHosts(app)).toHaveLength(rows);
    });
  });

  describe("revocation", () => {
    it("is final: neither credential slot nor the old bootstrap token regains the host, across a restart", async () => {
      const { id, token, first } = await claimedHost("revoked");
      const rotated = (await renew(id, first.machine_credential)).json();

      expect((await post(`/api/hosts/${id}/revoke`)).statusCode).toBe(204);
      // Idempotent.
      expect((await post(`/api/hosts/${id}/revoke`)).statusCode).toBe(204);

      const attempts = async () => [
        // current credential, grace-slot credential, bootstrap token (with and without asking for identity)
        (await renew(id, rotated.machine_credential)).statusCode,
        (await renew(id, first.machine_credential)).statusCode,
        (await register({ token, wantsMachineCredential: true })).statusCode,
        (await register({ token, baseUrl: "http://10.2.0.1:4000" })).statusCode,
      ];
      expect(await attempts()).toEqual([401, 401, 401, 401]);

      await app.close();
      app = await buildApp();
      expect(await attempts()).toEqual([401, 401, 401, 401]);
      const row = getHostRow(app, id)!;
      expect(row.machineCredentialEnc).toBeNull();
      expect(row.machineCredentialPrevEnc).toBeNull();
      expect(row.sessionSecretEnc).toBeNull();
    });

    it("does not let the fleet secret take over a revoked row", async () => {
      const enrolled = (
        await register({ token: "fleet-secret", wantsMachineCredential: true })
      ).json();
      await post(`/api/hosts/${enrolled.host_id}/revoke`);
      const before = listHosts(app).length;
      const again = await register({ token: "fleet-secret", wantsMachineCredential: true });
      // A fresh enrollment is a NEW host, never the revoked identity.
      expect(again.statusCode).toBe(200);
      expect(again.json().host_id).not.toBe(enrolled.host_id);
      expect(listHosts(app)).toHaveLength(before + 1);
      expect((await renew(enrolled.host_id, enrolled.machine_credential)).statusCode).toBe(401);
    });
  });

  describe("bootstrap-token rotation", () => {
    it("re-arms a revoked per-host row with the NEW token only; every older secret stays dead", async () => {
      const { id, token: oldToken, first } = await claimedHost("rearmed");
      const rotated = (await renew(id, first.machine_credential)).json();
      await post(`/api/hosts/${id}/revoke`);

      const res = await post(`/api/hosts/${id}/rotate-token`);
      expect(res.statusCode).toBe(200);
      const newToken = res.json().token as string;
      expect(newToken).not.toBe(oldToken);
      expect(listHosts(app).find((h) => h.id === id)?.machineIdentityRevoked).toBe(false);

      // Re-arming restores nothing the revoked identity held.
      expect((await renew(id, rotated.machine_credential)).statusCode).toBe(401);
      expect((await renew(id, first.machine_credential)).statusCode).toBe(401);
      expect((await register({ token: oldToken, wantsMachineCredential: true })).statusCode).toBe(
        401,
      );

      // The new token claims the SAME row and issues a brand-new credential.
      const reclaim = await register({ token: newToken, wantsMachineCredential: true });
      expect(reclaim.statusCode).toBe(200);
      expect(reclaim.json().host_id).toBe(id);
      const fresh = reclaim.json().machine_credential as string;
      expect([first.machine_credential, rotated.machine_credential]).not.toContain(fresh);
      expect((await renew(id, fresh)).statusCode).toBe(200);
    });

    it("does not disturb a live machine identity: the agent keeps renewing, the old token cannot claim", async () => {
      const { id, token: oldToken, first } = await claimedHost("rotating-live");
      const res = await post(`/api/hosts/${id}/rotate-token`);
      const newToken = res.json().token as string;

      expect(
        (await register({ token: oldToken, baseUrl: "http://10.2.0.1:4000" })).statusCode,
      ).toBe(401);
      const renewed = await renew(id, first.machine_credential);
      expect(renewed.statusCode).toBe(200);
      // Re-claiming with the new token is the deliberate re-enroll: the live
      // credential moves to the grace slot rather than stranding the agent.
      const reclaim = await register({ token: newToken, wantsMachineCredential: true });
      expect(reclaim.json().host_id).toBe(id);
      expect((await renew(id, renewed.json().machine_credential)).statusCode).toBe(200);
    });

    it("keeps a re-armed host re-armed across a restart", async () => {
      const { id, first } = await claimedHost("rearmed-restart");
      void first;
      await post(`/api/hosts/${id}/revoke`);
      const newToken = (await post(`/api/hosts/${id}/rotate-token`)).json().token as string;
      await app.close();
      app = await buildApp();
      const reclaim = await register({ token: newToken, wantsMachineCredential: true });
      expect(reclaim.statusCode).toBe(200);
      expect(reclaim.json().host_id).toBe(id);
    });
  });

  it("offers no operator endpoint that rotates a machine credential directly", async () => {
    const { id } = await claimedHost("no-rotate-endpoint");
    for (const suffix of ["rotate-credential", "rotate-machine-credential", "credential"]) {
      const res = await post(`/api/hosts/${id}/${suffix}`);
      expect(res.statusCode, suffix).toBe(404);
    }
  });
});
