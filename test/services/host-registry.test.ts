import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import {
  LOCAL_HOST_ID,
  claimHost,
  createHost,
  decryptToken,
  deleteHost,
  enrollHost,
  getHostRow,
  HostHasProjectsError,
  listHosts,
  rotateSession,
  UnknownHostError,
  updateHost,
} from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `host-registry-test-${process.pid}.db`);

describe("host-registry", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("seeds exactly the local host on a fresh DB", async () => {
    const app = await buildApp();
    expect(listHosts(app)).toEqual([
      expect.objectContaining({ id: LOCAL_HOST_ID, isLocal: true, hasToken: false }),
    ]);
    await app.close();
  });

  it("round-trips a token through createHost/decryptToken", async () => {
    const app = await buildApp();
    const summary = createHost(app, { name: "a", baseUrl: "http://a:1", token: "s3cr3t" });
    const row = getHostRow(app, summary.id);
    expect(row).toBeDefined();
    expect(decryptToken(app, row!)).toBe("s3cr3t");
    await app.close();
  });

  it("stores the token opaque to EncryptionService (encrypted when DB_ENCRYPTION_KEY is set)", async () => {
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    const app = await buildApp();
    const summary = createHost(app, { name: "enc", baseUrl: "http://enc:1", token: "s3cr3t" });
    const row = getHostRow(app, summary.id)!;
    expect(row.authTokenEnc).not.toBe("s3cr3t");
    expect(decryptToken(app, row)).toBe("s3cr3t");
    await app.close();
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("updateHost rotates the token and re-encrypts it", async () => {
    const app = await buildApp();
    const summary = createHost(app, { name: "b", baseUrl: "http://b:1", token: "first" });
    updateHost(app, summary.id, { token: "second" });
    const row = getHostRow(app, summary.id)!;
    expect(decryptToken(app, row)).toBe("second");
    await app.close();
  });

  it("updateHost returns undefined for an unknown id", async () => {
    const app = await buildApp();
    expect(updateHost(app, "nope", { name: "x" })).toBeUndefined();
    await app.close();
  });

  it("deleteHost refuses to delete the local host", async () => {
    const app = await buildApp();
    expect(() => deleteHost(app, LOCAL_HOST_ID)).toThrow(/local host/);
    await app.close();
  });

  it("deleteHost throws UnknownHostError for a missing id", async () => {
    const app = await buildApp();
    expect(() => deleteHost(app, "does-not-exist")).toThrow(UnknownHostError);
    await app.close();
  });

  it("deleteHost throws HostHasProjectsError when a remote host still owns projects", async () => {
    const app = await buildApp();
    const summary = createHost(app, { name: "c", baseUrl: "http://c:1", token: "t" });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/x", hostId: summary.id },
    });
    expect(() => deleteHost(app, summary.id)).toThrow(HostHasProjectsError);
    await app.close();
  });

  it("deleteHost succeeds for a remote host with no projects", async () => {
    const app = await buildApp();
    const summary = createHost(app, { name: "d", baseUrl: "http://d:1", token: "t" });
    expect(() => deleteHost(app, summary.id)).not.toThrow();
    expect(getHostRow(app, summary.id)).toBeUndefined();
    await app.close();
  });

  it("createHost sets origin: manual, and local reports origin: manual too", async () => {
    const app = await buildApp();
    const summary = createHost(app, { name: "e", baseUrl: "http://e:1", token: "t" });
    expect(summary.origin).toBe("manual");
    expect(listHosts(app)).toContainEqual(
      expect.objectContaining({ id: LOCAL_HOST_ID, origin: "manual" }),
    );
    await app.close();
  });

  // Issue #245 / roadmap 7.1 — agent-initiated registration & rotation.
  describe("claimHost / enrollHost / rotateSession", () => {
    it("claimHost matches an existing host's own token, fills baseUrl/metadata, and issues a session", async () => {
      const app = await buildApp();
      const created = createHost(app, {
        name: "pre-provisioned",
        baseUrl: "http://placeholder:0",
        token: "shared-secret",
      });

      const result = claimHost(app, "shared-secret", {
        baseUrl: "http://192.168.1.50:4000",
        hostname: "box-50",
        capabilities: { foo: true },
      });

      expect(result).not.toBeNull();
      expect(result!.hostId).toBe(created.id);
      expect(result!.sessionId).toHaveLength(64); // 32 bytes hex
      expect(result!.sessionSecret).toHaveLength(64);
      expect(result!.sessionId).not.toBe(result!.sessionSecret);

      const row = getHostRow(app, created.id)!;
      expect(row.baseUrl).toBe("http://192.168.1.50:4000");
      expect(row.origin).toBe("manual");
      expect(JSON.parse(row.agentMetadata!)).toEqual({
        hostname: "box-50",
        capabilities: { foo: true },
      });
      expect(row.sessionIdEnc).not.toBeNull();
      expect(decryptToken(app, row)).toBe("shared-secret"); // manual token untouched

      await app.close();
    });

    it("claimHost returns null when no row's token matches", async () => {
      const app = await buildApp();
      createHost(app, { name: "f", baseUrl: "http://f:1", token: "real-token" });
      const result = claimHost(app, "wrong-token", { baseUrl: "http://x:1", hostname: "x" });
      expect(result).toBeNull();
      await app.close();
    });

    it("claimHost never matches the local host (no authTokenEnc to compare against)", async () => {
      const app = await buildApp();
      const result = claimHost(app, "", { baseUrl: "http://x:1", hostname: "x" });
      expect(result).toBeNull();
      await app.close();
    });

    it("enrollHost creates a brand-new host row with origin: enrolled and no manual token", async () => {
      const app = await buildApp();
      const result = enrollHost(app, {
        baseUrl: "http://192.168.1.99:4000",
        hostname: "fresh-box",
        capabilities: { browser: true },
      });

      const row = getHostRow(app, result.hostId)!;
      expect(row).toBeDefined();
      expect(row.name).toBe("fresh-box"); // falls back to hostname when no `name` given
      expect(row.baseUrl).toBe("http://192.168.1.99:4000");
      expect(row.origin).toBe("enrolled");
      expect(row.authTokenEnc).toBeNull();
      expect(decryptToken(app, row)).toBe("");
      expect(row.sessionIdEnc).not.toBeNull();
      expect(JSON.parse(row.agentMetadata!)).toEqual({
        hostname: "fresh-box",
        capabilities: { browser: true },
      });

      const summary = listHosts(app).find((h) => h.id === result.hostId);
      expect(summary).toMatchObject({ origin: "enrolled", hasToken: false });

      await app.close();
    });

    it("enrollHost prefers an explicit name over the hostname fallback", async () => {
      const app = await buildApp();
      const result = enrollHost(app, {
        baseUrl: "http://x:1",
        hostname: "raw-hostname",
        name: "Home Server",
      });
      expect(getHostRow(app, result.hostId)!.name).toBe("Home Server");
      await app.close();
    });

    // Hermes review (PR #528): a lost registration response must not turn
    // an agent's retry into a duplicate host row for the same box.
    it("enrollHost reuses an existing enrolled row with the same baseUrl instead of duplicating it", async () => {
      const app = await buildApp();
      const first = enrollHost(app, { baseUrl: "http://10.0.0.5:4000", hostname: "box-5" });
      const second = enrollHost(app, {
        baseUrl: "http://10.0.0.5:4000",
        hostname: "box-5",
        name: "Renamed",
      });

      expect(second.hostId).toBe(first.hostId);
      expect(second.sessionId).not.toBe(first.sessionId); // still a fresh session
      // Filtered by this test's own baseUrl, not just origin — this file
      // shares one DB across its whole describe block, so other tests'
      // enrolled rows (different baseUrls) are also present here.
      expect(
        app.db.select().from(hosts).where(eq(hosts.baseUrl, "http://10.0.0.5:4000")).all(),
      ).toHaveLength(1);
      expect(getHostRow(app, second.hostId)!.name).toBe("Renamed");

      await app.close();
    });

    it("enrollHost does not reuse a manually-created row that happens to share a baseUrl", async () => {
      const app = await buildApp();
      const manual = createHost(app, {
        name: "manual",
        baseUrl: "http://10.0.0.6:4000",
        token: "t",
      });
      const enrolled = enrollHost(app, { baseUrl: "http://10.0.0.6:4000", hostname: "box-6" });

      expect(enrolled.hostId).not.toBe(manual.id);
      expect(getHostRow(app, manual.id)!.origin).toBe("manual");
      expect(getHostRow(app, enrolled.hostId)!.origin).toBe("enrolled");

      await app.close();
    });

    it("rotateSession issues a fresh session when the presented session id matches", async () => {
      const app = await buildApp();
      const registered = enrollHost(app, { baseUrl: "http://x:1", hostname: "x" });

      const renewed = rotateSession(app, registered.hostId, registered.sessionId);
      expect(renewed).not.toBeNull();
      expect(renewed!.hostId).toBe(registered.hostId);
      // A genuinely fresh credential, not the same one echoed back.
      expect(renewed!.sessionId).not.toBe(registered.sessionId);
      expect(renewed!.sessionSecret).not.toBe(registered.sessionSecret);

      // The OLD session id no longer works — issueSession overwrote it.
      expect(rotateSession(app, registered.hostId, registered.sessionId)).toBeNull();
      // The NEW one does.
      const renewedAgain = rotateSession(app, registered.hostId, renewed!.sessionId);
      expect(renewedAgain).not.toBeNull();

      await app.close();
    });

    it("rotateSession returns null for a wrong session id", async () => {
      const app = await buildApp();
      const registered = enrollHost(app, { baseUrl: "http://x:1", hostname: "x" });
      expect(rotateSession(app, registered.hostId, "not-the-right-session-id")).toBeNull();
      await app.close();
    });

    // Hermes review (PR #528): a correctly-matched session id that has
    // already passed its TTL must NOT renew — otherwise the 24h TTL is
    // purely advisory and never actually bounds a leaked credential.
    it("rotateSession returns null for a session id that matches but has already expired", async () => {
      const app = await buildApp();
      const registered = enrollHost(app, { baseUrl: "http://x:1", hostname: "x" });
      app.db
        .update(hosts)
        .set({ sessionExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(hosts.id, registered.hostId))
        .run();
      expect(rotateSession(app, registered.hostId, registered.sessionId)).toBeNull();
      await app.close();
    });

    it("rotateSession returns null for an unknown hostId", async () => {
      const app = await buildApp();
      expect(rotateSession(app, "does-not-exist", "anything")).toBeNull();
      await app.close();
    });

    it("rotateSession returns null for a host that was never registered (no session yet)", async () => {
      const app = await buildApp();
      const created = createHost(app, { name: "g", baseUrl: "http://g:1", token: "t" });
      expect(rotateSession(app, created.id, "anything")).toBeNull();
      await app.close();
    });
  });
});
