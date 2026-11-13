import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

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

  it("accepts a tailnet 100.64.0.0/10 baseUrl on create and update only with MULLION_ALLOW_TAILNET_HOSTS", async () => {
    const tailnet = "http://100.101.102.103:4000";
    let app = await buildApp();
    let res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "tailnet-off", baseUrl: tailnet, token: "t" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();

    process.env.MULLION_ALLOW_TAILNET_HOSTS = "true";
    try {
      app = await buildApp();
      res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "tailnet-on", baseUrl: tailnet, token: "t" },
      });
      expect(res.statusCode).toBe(201);
      const id = (res.json() as { id: string }).id;
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${id}`,
        payload: { baseUrl: "http://100.64.0.9:4000" },
      });
      expect(patch.statusCode).toBe(200);
      // IMDS stays blocked with the setting on.
      const imds = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "imds", baseUrl: "http://169.254.169.254", token: "t" },
      });
      expect(imds.statusCode).toBe(400);
      await app.close();
    } finally {
      delete process.env.MULLION_ALLOW_TAILNET_HOSTS;
    }
  });
});
