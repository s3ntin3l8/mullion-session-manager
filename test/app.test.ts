import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";

// Multi-host support (issue #26) role branch — see src/app.ts and
// src/plugins/env.ts. This PR only wires the role flag, the fail-closed boot
// check, and the DB-less agent plugin/route split; the internal API itself
// (and so any actually-useful agent behavior) lands in a follow-up PR.
describe("buildApp role branch (issue #26)", () => {
  afterEach(async () => {
    delete process.env.TESSERA_ROLE;
    delete process.env.TESSERA_AGENT_TOKEN;
  });

  it("defaults to primary and keeps every existing route registered", async () => {
    const app = await buildApp();
    expect(app.config.TESSERA_ROLE).toBe("primary");
    expect(app.config.TESSERA_AGENT_TOKEN).toBe("");
    expect(app.hasDecorator("db")).toBe(true);
    expect(app.hasDecorator("pty")).toBe(true);

    const res = await app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("refuses to boot as agent with no shared token", async () => {
    process.env.TESSERA_ROLE = "agent";
    delete process.env.TESSERA_AGENT_TOKEN;
    await expect(buildApp()).rejects.toThrow(/TESSERA_AGENT_TOKEN/);
  });

  it("refuses to boot as agent with a whitespace-only token", async () => {
    process.env.TESSERA_ROLE = "agent";
    process.env.TESSERA_AGENT_TOKEN = "   ";
    await expect(buildApp()).rejects.toThrow(/TESSERA_AGENT_TOKEN/);
  });

  it("boots as a DB-less agent when a token is set, skipping DB-backed routes", async () => {
    process.env.TESSERA_ROLE = "agent";
    process.env.TESSERA_AGENT_TOKEN = "test-token";

    const app = await buildApp();
    expect(app.config.TESSERA_ROLE).toBe("agent");
    // No app.db/app.encryption — dbPlugin is never registered for an agent.
    expect(app.hasDecorator("db")).toBe(false);
    expect(app.hasDecorator("encryption")).toBe(false);
    // ptyPlugin still registers — an agent's whole job is running PtyManager
    // locally — but its reconciler (DB-only) never arms; reconfigureReconciler
    // is only decorated on the primary path.
    expect(app.hasDecorator("pty")).toBe(true);
    expect(app.hasDecorator("reconfigureReconciler")).toBe(false);

    // Every DB-backed product route is unregistered on an agent — /health is
    // the one route that survives (it doesn't need the DB), the rest 404.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect(projects.statusCode).toBe(404);
    const terminal = await app.inject({ method: "GET", url: "/ws/terminal?sessionId=1" });
    expect(terminal.statusCode).toBe(404);

    await app.close();
  });
});
