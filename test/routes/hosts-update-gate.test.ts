import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `hosts-update-gate-${process.pid}.db`);

// Issue #2569 — the update probe asks the negotiated protocol before it asks
// the host: an agent that never listed "updates" is not updatable from here.
describe("per-host update probe, gated on negotiated support (issue #2569)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("reports updatable: false without asking a host that did not negotiate updates", async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "legacy-protocol-agent", baseUrl, token: "t" },
      });
      const { id } = created.json();
      app.hostAgentTracker?.record(id, {
        agents: null,
        capabilities: null,
        mullionVersion: null,
        protocol: { protocolVersion: 0, legacy: true, operations: ["sessions"], launchOptions: [] },
      });

      const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ updatable: false, status: { phase: "unavailable" } });
      expect(hits).not.toContain("/internal/updates/status");
      await app.close();
    } finally {
      server.close();
    }
  });
});
