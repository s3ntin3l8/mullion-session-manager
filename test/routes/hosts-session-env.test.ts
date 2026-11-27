import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { seedHostResponse } from "../helpers/hosts.js";

const tmpDb = path.join(os.tmpdir(), `hosts-session-env-test-${process.pid}.db`);

describe("GET /api/hosts sessionEnv (issue #3156)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("is null while unknown and the tracker's reading once read", async () => {
    const app = await buildApp();
    const created = await seedHostResponse(app, {
      name: "env",
      baseUrl: "http://127.0.0.1:4005",
      token: "t",
    });
    const { id } = created.json();
    const list = async () =>
      (
        (await app.inject({ method: "GET", url: "/api/hosts" })).json() as Array<
          Record<string, unknown>
        >
      ).find((h) => h.id === id);
    expect(await list()).toMatchObject({ sessionEnv: null });
    const sessionEnv = {
      shell: "/bin/zsh",
      interactiveResolve: "fallback" as const,
      reason: "timeout" as const,
      path: ["/usr/bin"],
      recoveredKeys: [],
    };
    app.hostAgentTracker?.record(id, {
      agents: ["claude"],
      capabilities: null,
      sessionEnv,
      mullionVersion: "0.3.40",
    });
    expect(await list()).toMatchObject({ sessionEnv });
    await app.close();
  });
});
