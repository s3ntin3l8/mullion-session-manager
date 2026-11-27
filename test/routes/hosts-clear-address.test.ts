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
  claimHost,
  createPairedHost,
  getHostRow,
  renewMachineCredential,
  revokeMachineIdentity,
} from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `hosts-clear-address-test-${process.pid}.db`);

// Issue #3091 — an address may be cleared once the host connects out.
describe("hosts route: clearing a host's address (issue #3091)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  const clear = (app: Awaited<ReturnType<typeof buildApp>>, id: string) =>
    app.inject({ method: "PATCH", url: `/api/hosts/${id}`, payload: { baseUrl: null } });

  it("clears the address of a host with a machine identity", async () => {
    const app = await buildApp();
    try {
      const { hostId } = createPairedHost(app, {
        baseUrl: "http://127.0.0.1:4701",
        hostname: "outbound",
      });
      const res = await clear(app, hostId);
      expect(res.statusCode).toBe(200);
      expect(res.json().baseUrl).toBeNull();
      expect(getHostRow(app, hostId)?.baseUrl).toBeNull();
      const listed = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
      expect(listed.find((h: { id: string }) => h.id === hostId).baseUrl).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("refuses a host without a machine identity, naming the reason, and keeps its address", async () => {
    const app = await buildApp();
    try {
      const legacyId = crypto.randomUUID();
      app.db
        .insert(hosts)
        .values({
          id: legacyId,
          name: "legacy",
          baseUrl: "http://127.0.0.1:4702",
          authTokenEnc: app.encryption.encryptString("t"),
          origin: "manual",
          approvedAt: new Date(),
        })
        .run();
      const res = await clear(app, legacyId);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/machine identity/);
      expect(getHostRow(app, legacyId)?.baseUrl).toBe("http://127.0.0.1:4702");
    } finally {
      await app.close();
    }
  });

  it("refuses a host whose identity was revoked", async () => {
    const app = await buildApp();
    try {
      const { hostId } = createPairedHost(app, {
        baseUrl: "http://127.0.0.1:4703",
        hostname: "revoked",
      });
      expect(revokeMachineIdentity(app, hostId)).toBe(true);
      expect((await clear(app, hostId)).statusCode).toBe(400);
      expect(getHostRow(app, hostId)?.baseUrl).toBe("http://127.0.0.1:4703");
    } finally {
      await app.close();
    }
  });

  it("refuses a host whose identity has expired", async () => {
    const app = await buildApp();
    try {
      const { hostId } = createPairedHost(app, {
        baseUrl: "http://127.0.0.1:4706",
        hostname: "expired",
      });
      const live = async () =>
        (await app.inject({ method: "GET", url: "/api/hosts" }))
          .json()
          .find((h: { id: string }) => h.id === hostId).hasLiveMachineIdentity;
      expect(await live()).toBe(true);
      app.db
        .update(hosts)
        .set({ machineCredentialExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(hosts.id, hostId))
        .run();
      expect(await live()).toBe(false);
      const res = await clear(app, hostId);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/live machine identity/);
      expect(getHostRow(app, hostId)?.baseUrl).toBe("http://127.0.0.1:4706");
    } finally {
      await app.close();
    }
  });

  it("404s an unknown host, leaves the local host uneditable, and still rejects an empty string", async () => {
    const app = await buildApp();
    try {
      expect((await clear(app, "no-such-host")).statusCode).toBe(404);
      expect((await clear(app, "local")).statusCode).toBe(400);
      const { hostId } = createPairedHost(app, {
        baseUrl: "http://127.0.0.1:4704",
        hostname: "blank",
      });
      const blank = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${hostId}`,
        payload: { baseUrl: "" },
      });
      expect(blank.statusCode).toBe(400);
      expect(getHostRow(app, hostId)?.baseUrl).toBe("http://127.0.0.1:4704");
    } finally {
      await app.close();
    }
  });

  it("keeps a manual row's cleared address cleared when the agent renews without advertising one", async () => {
    const app = await buildApp();
    try {
      const createdId = crypto.randomUUID();
      app.db
        .insert(hosts)
        .values({
          id: createdId,
          name: "mac",
          baseUrl: "http://127.0.0.1:4705",
          authTokenEnc: app.encryption.encryptString("boot"),
          origin: "manual",
          approvedAt: new Date(),
        })
        .run();
      const claimed = claimHost(app, "boot", {
        baseUrl: "http://127.0.0.1:4705",
        hostname: "mac",
        wantsMachineCredential: true,
      })!;
      expect((await clear(app, createdId)).statusCode).toBe(200);
      renewMachineCredential(app, createdId, claimed.machineCredential!, { hostname: "mac" });
      expect(getHostRow(app, createdId)?.baseUrl).toBeNull();
    } finally {
      await app.close();
    }
  });
});
