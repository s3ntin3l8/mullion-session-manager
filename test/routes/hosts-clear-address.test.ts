import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  claimHost,
  createHost,
  enrollHost,
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
      const { hostId } = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4701",
        hostname: "outbound",
        wantsMachineCredential: true,
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
      const legacy = createHost(app, {
        name: "legacy",
        baseUrl: "http://127.0.0.1:4702",
        token: "t",
      });
      const res = await clear(app, legacy.id);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/machine identity/);
      expect(getHostRow(app, legacy.id)?.baseUrl).toBe("http://127.0.0.1:4702");
    } finally {
      await app.close();
    }
  });

  it("refuses a host whose identity was revoked", async () => {
    const app = await buildApp();
    try {
      const { hostId } = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4703",
        hostname: "revoked",
        wantsMachineCredential: true,
      });
      expect(revokeMachineIdentity(app, hostId)).toBe(true);
      expect((await clear(app, hostId)).statusCode).toBe(400);
      expect(getHostRow(app, hostId)?.baseUrl).toBe("http://127.0.0.1:4703");
    } finally {
      await app.close();
    }
  });

  it("404s an unknown host, leaves the local host uneditable, and still rejects an empty string", async () => {
    const app = await buildApp();
    try {
      expect((await clear(app, "no-such-host")).statusCode).toBe(404);
      expect((await clear(app, "local")).statusCode).toBe(400);
      const { hostId } = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4704",
        hostname: "blank",
        wantsMachineCredential: true,
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
      const created = createHost(app, {
        name: "mac",
        baseUrl: "http://127.0.0.1:4705",
        token: "boot",
      });
      const claimed = claimHost(app, "boot", {
        baseUrl: "http://127.0.0.1:4705",
        hostname: "mac",
        wantsMachineCredential: true,
      })!;
      expect((await clear(app, created.id)).statusCode).toBe(200);
      renewMachineCredential(app, created.id, claimed.machineCredential!, { hostname: "mac" });
      expect(getHostRow(app, created.id)?.baseUrl).toBeNull();
    } finally {
      await app.close();
    }
  });
});
