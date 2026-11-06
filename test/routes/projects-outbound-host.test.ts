import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { closeDb } from "../../src/db/client.js";

// Issue #2636 — an outbound-only host (machine identity, no baseUrl) is a valid
// project host exactly when the project modal offers it; a manual host that has
// no URL and no identity yet is still waiting for its agent.
const tmpDb = path.join(os.tmpdir(), `projects-outbound-host-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

const { buildApp } = await import("../../src/app.js");
const { enrollHost } = await import("../../src/services/host-registry.js");

describe("project creation on an outbound-only host (#2636)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
  });

  it("accepts the host for hostId and hostCwds, and still rejects a pending manual host", async () => {
    const app = await buildApp();
    const { hostId } = enrollHost(app, { hostname: "outbound-box", wantsMachineCredential: true });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "ob-project", cwd: "/srv/ob", hostId, hostCwds: { [hostId]: "/srv/ob" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().hostId).toBe(hostId);

    const pending = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "pending-box" },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "pend", cwd: "/srv/p", hostId: pending.json().id },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toMatch(/hasn't registered yet/i);
    await app.close();
  });
});
