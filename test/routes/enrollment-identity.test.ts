import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { createHost, getHostRow, listHosts } from "../../src/services/host-registry.js";
import { getRemoteHostClient } from "../../src/services/remote-host-client.js";
import { HostUnreachableError } from "../../src/services/remote-host-errors.js";

// Issue #2568 — persistent machine identity and renewable machine credentials.
const tmpDb = path.join(os.tmpdir(), `enrollment-identity-test-${process.pid}.db`);

describe("machine identity (issue #2568)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret"; // pragma: allowlist secret
  });

  // A fresh app per test: the register route is rate limited to 20/min per
  // client, which a shared app would trip.
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

  const enrolledRows = () =>
    app.db
      .select()
      .from(hosts)
      .all()
      .filter((h) => h.origin === "enrolled");

  const register = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { baseUrl: "http://10.1.0.1:4000", hostname: "box", ...payload },
    });

  const enroll = (payload: Record<string, unknown> = {}) =>
    register({ token: "fleet-secret", wantsMachineCredential: true, ...payload });

  it("issues a credential once on enrollment and stores it on the host row", async () => {
    const res = await enroll({ baseUrl: "http://10.1.0.10:4000" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machine_credential).toMatch(/^[0-9a-f]{64}$/);
    const row = getHostRow(app, body.host_id)!;
    expect(row.machineCredentialEnc).toBeTruthy();
    expect(app.encryption.decryptString(row.machineCredentialEnc!)).toBe(body.machine_credential);
    expect(listHosts(app).find((h) => h.id === body.host_id)?.hasMachineIdentity).toBe(true);
  });

  it("keeps one host row across repeated registration with the identity", async () => {
    const first = (await enroll({ baseUrl: "http://10.1.0.20:4000" })).json();
    const before = enrolledRows().length;
    let credential = first.machine_credential as string;
    for (let i = 0; i < 3; i++) {
      const res = await register({
        hostId: first.host_id,
        machineCredential: credential,
        baseUrl: "http://10.1.0.20:4000",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.host_id).toBe(first.host_id);
      expect(body.machine_credential).not.toBe(credential);
      credential = body.machine_credential;
    }
    expect(enrolledRows().length).toBe(before);
  });

  it("gives two agents with the same advertised URL distinct identities", async () => {
    const a = (await enroll({ baseUrl: "http://shared.example:4000", hostname: "clone" })).json();
    const b = (await enroll({ baseUrl: "http://shared.example:4000", hostname: "clone" })).json();
    expect(a.host_id).not.toBe(b.host_id);
    expect(a.machine_credential).not.toBe(b.machine_credential);
    // A's credential does not authenticate B's row.
    const cross = await register({ hostId: b.host_id, machineCredential: a.machine_credential });
    expect(cross.statusCode).toBe(401);
  });

  it("accepts the previous credential after a lost renewal response", async () => {
    const first = (await enroll({ baseUrl: "http://10.1.0.30:4000" })).json();
    // Renewal whose response the agent never receives.
    const lost = (
      await register({ hostId: first.host_id, machineCredential: first.machine_credential })
    ).json();
    // The agent retries with the credential it still holds.
    const retry = await register({
      hostId: first.host_id,
      machineCredential: first.machine_credential,
    });
    expect(retry.statusCode).toBe(200);
    // It converges on the credential already issued rather than rotating again.
    expect(retry.json().machine_credential).toBe(lost.machine_credential);
    // And that credential works.
    const next = await register({
      hostId: first.host_id,
      machineCredential: retry.json().machine_credential,
    });
    expect(next.statusCode).toBe(200);
  });

  it("drops the previous credential once the grace period has passed", async () => {
    const first = (await enroll({ baseUrl: "http://10.1.0.31:4000" })).json();
    await register({ hostId: first.host_id, machineCredential: first.machine_credential });
    const { eq } = await import("drizzle-orm");
    app.db
      .update(hosts)
      .set({ machineCredentialRotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(hosts.id, first.host_id))
      .run();
    const res = await register({
      hostId: first.host_id,
      machineCredential: first.machine_credential,
    });
    expect(res.statusCode).toBe(401);
  });

  it("treats revocation as final", async () => {
    const created = createHost(app, {
      name: "claimable",
      baseUrl: "http://placeholder:0",
      token: "claim-token", // pragma: allowlist secret
    });
    const first = (
      await register({
        token: "claim-token",
        wantsMachineCredential: true,
        baseUrl: "http://10.1.0.40:4000",
      })
    ).json();
    expect(first.host_id).toBe(created.id);

    const revoke = await app.inject({ method: "POST", url: `/api/hosts/${created.id}/revoke` });
    expect(revoke.statusCode).toBe(204);

    const renew = await register({
      hostId: created.id,
      machineCredential: first.machine_credential,
    });
    expect(renew.statusCode).toBe(401);
    // The bootstrap token does not win the identity back.
    const reclaim = await register({
      token: "claim-token",
      wantsMachineCredential: true,
      baseUrl: "http://10.1.0.40:4000",
    });
    expect(reclaim.statusCode).toBe(401);
    expect(listHosts(app).find((h) => h.id === created.id)?.machineIdentityRevoked).toBe(true);
  });

  it("404s revoking an unknown host and refuses the local host", async () => {
    const unknown = await app.inject({ method: "POST", url: "/api/hosts/nope/revoke" });
    expect(unknown.statusCode).toBe(404);
    const local = await app.inject({ method: "POST", url: "/api/hosts/local/revoke" });
    expect(local.statusCode).toBe(400);
  });

  it("401s an unknown host id or a wrong credential", async () => {
    const first = (await enroll({ baseUrl: "http://10.1.0.50:4000" })).json();
    expect(
      (await register({ hostId: "ghost", machineCredential: first.machine_credential })).statusCode,
    ).toBe(401);
    expect(
      (await register({ hostId: first.host_id, machineCredential: "0".repeat(64) })).statusCode,
    ).toBe(401);
  });

  it("400s a registration with neither token nor credential", async () => {
    expect((await register({})).statusCode).toBe(400);
    expect((await register({ machineCredential: "x" })).statusCode).toBe(400);
  });

  it("leaves a legacy agent unchanged: no credential, baseUrl dedupe kept", async () => {
    const one = (
      await register({ token: "fleet-secret", baseUrl: "http://10.1.0.60:4000" })
    ).json();
    const two = (
      await register({ token: "fleet-secret", baseUrl: "http://10.1.0.60:4000" })
    ).json();
    expect(one.machine_credential).toBeUndefined();
    expect(two.host_id).toBe(one.host_id);
    expect(getHostRow(app, one.host_id)!.machineCredentialEnc).toBeNull();
  });

  it("does not let a legacy agent take over an identity-bearing row by URL", async () => {
    const identity = (await enroll({ baseUrl: "http://10.1.0.70:4000" })).json();
    const legacy = (
      await register({ token: "fleet-secret", baseUrl: "http://10.1.0.70:4000" })
    ).json();
    expect(legacy.host_id).not.toBe(identity.host_id);
  });

  // Issue #2572 — an outbound-capable agent advertises no address.
  describe("registration without an advertised URL (issue #2572)", () => {
    const registerNoUrl = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { hostname: "laptop", ...payload },
      });

    it("enrolls a host with no baseUrl and keeps it addressable as a remote host", async () => {
      const res = await registerNoUrl({ token: "fleet-secret", wantsMachineCredential: true });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const row = getHostRow(app, body.host_id)!;
      expect(row.baseUrl).toBeNull();
      expect(row.origin).toBe("enrolled");
      expect(listHosts(app).find((h) => h.id === body.host_id)?.hasMachineIdentity).toBe(true);
      // Reached over its channel, so a client exists; an inbound-only call is
      // refused as unreachable instead of dialing nothing.
      const client = getRemoteHostClient(app, body.host_id);
      await expect(client.getDevServerStatus(1, "http")).rejects.toBeInstanceOf(
        HostUnreachableError,
      );
      expect(await client.ping()).toBe(false);
    });

    it("gives two url-less agents their own rows (identity, not address)", async () => {
      const a = (
        await registerNoUrl({ token: "fleet-secret", wantsMachineCredential: true })
      ).json();
      const b = (
        await registerNoUrl({ token: "fleet-secret", wantsMachineCredential: true })
      ).json();
      expect(a.host_id).not.toBe(b.host_id);
    });

    it("keeps identity on a rerun: renewal without a URL reuses the row and clears a stale URL", async () => {
      const first = (await enroll({ baseUrl: "http://10.1.0.90:4000" })).json();
      const res = await registerNoUrl({
        hostId: first.host_id,
        machineCredential: first.machine_credential,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().host_id).toBe(first.host_id);
      expect(getHostRow(app, first.host_id)!.baseUrl).toBeNull();
    });

    it("refuses a legacy registration (no machine identity) without a URL", async () => {
      const res = await registerNoUrl({ token: "fleet-secret" });
      expect(res.statusCode).toBe(400);
    });

    it("lets a claimed manual host keep its admin-set URL when the agent advertises none", async () => {
      const manual = createHost(app, {
        name: "manual",
        baseUrl: "http://10.1.0.99:4000",
        token: "manual-token", // pragma: allowlist secret
      });
      const res = await registerNoUrl({ token: "manual-token", wantsMachineCredential: true });
      expect(res.statusCode).toBe(200);
      expect(res.json().host_id).toBe(manual.id);
      const row = getHostRow(app, manual.id)!;
      expect(row.baseUrl).toBe("http://10.1.0.99:4000");
      // And a later url-less renewal leaves it too (manual rows are the admin's).
      await registerNoUrl({
        hostId: manual.id,
        machineCredential: res.json().machine_credential,
      });
      expect(getHostRow(app, manual.id)!.baseUrl).toBe("http://10.1.0.99:4000");
    });
  });
});
