import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createPairedHost } from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `hosts-tailnet-test-${process.pid}.db`);

describe("hosts route: MULLION_ALLOW_TAILNET_HOSTS", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("accepts a tailnet 100.64.0.0/10 baseUrl on update only with MULLION_ALLOW_TAILNET_HOSTS", async () => {
    const tailnet = "http://100.101.102.103:4000";
    let app = await buildApp();
    const { hostId: id1 } = createPairedHost(app, { hostname: "tailnet-off" });
    const refused = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id1}`,
      payload: { baseUrl: tailnet },
    });
    expect(refused.statusCode).toBe(400);
    await app.close();

    process.env.MULLION_ALLOW_TAILNET_HOSTS = "true";
    try {
      app = await buildApp();
      const { hostId: id2 } = createPairedHost(app, { hostname: "tailnet-on" });
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${id2}`,
        payload: { baseUrl: "http://100.64.0.9:4000" },
      });
      expect(patch.statusCode).toBe(200);
      // IMDS stays blocked with the setting on.
      const imds = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${id2}`,
        payload: { baseUrl: "http://169.254.169.254" },
      });
      expect(imds.statusCode).toBe(400);
      await app.close();
    } finally {
      delete process.env.MULLION_ALLOW_TAILNET_HOSTS;
    }
  });
});
