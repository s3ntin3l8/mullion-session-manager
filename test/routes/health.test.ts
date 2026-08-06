import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "healthy" });
    await app.close();
  });
});

describe("GET /ready", () => {
  it("returns ready when the database is reachable", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      sessions: { tracked: 0, alive: 0 },
    });
    await app.close();
  });

  // Regression for issue #246's /ready fix — the agent role never registers
  // dbPlugin (src/app.ts's agent branch), so app.db is undefined there. This
  // route unconditionally probed it before, 503ing every agent-role process
  // (see health.ts's `if (app.db)` guard).
  it("returns ready on the agent role, which has no app.db", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "health-test-agent-token";
    process.env.PROJECTS_ROOTS = "/tmp";
    try {
      const app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ready",
        sessions: { tracked: 0, alive: 0 },
      });
      await app.close();
    } finally {
      delete process.env.MULLION_ROLE;
      delete process.env.MULLION_AGENT_TOKEN;
      delete process.env.PROJECTS_ROOTS;
    }
  });
});
