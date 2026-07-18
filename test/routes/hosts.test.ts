import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `hosts-test-${process.pid}.db`);

describe("hosts route (issue #26)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("lists the seeded local host, with no token ever exposed", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/hosts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "local", isLocal: true, baseUrl: null, hasToken: false }),
    ]);
    // The raw response body must never contain a token field at all.
    expect(res.body).not.toMatch(/authToken/i);
    await app.close();
  });

  it("creates a remote host and never returns its token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-1", baseUrl: "http://127.0.0.1:4001", token: "super-secret" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: "box-1",
      baseUrl: "http://127.0.0.1:4001",
      isLocal: false,
      hasToken: true,
    });
    expect(res.body).not.toMatch(/super-secret/);
    expect(typeof body.id).toBe("string");
    await app.close();
  });

  it("rejects a non-http(s) baseUrl", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "bad", baseUrl: "not-a-url", token: "t" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a baseUrl pointed at cloud instance metadata / link-local (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    for (const baseUrl of ["http://169.254.169.254", "http://100.64.0.1:8080"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ssrf", baseUrl, token: "t" },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("still allows a loopback baseUrl (admin-trust boundary, not a link-local block)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "loopback", baseUrl: "http://127.0.0.1:4001", token: "t" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("404s patching an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hosts/does-not-exist",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses to edit the local host", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hosts/local",
      payload: { name: "renamed" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rotates a host's name/baseUrl/token via PATCH", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-2", baseUrl: "http://127.0.0.1:4002", token: "old-token" },
    });
    const { id } = created.json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { name: "box-2-renamed", token: "new-token" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "box-2-renamed", hasToken: true });
    await app.close();
  });

  it("refuses to delete the local host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/hosts/local" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses to cascade-delete the local host, without touching its projects (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "local-project", cwd: "/tmp/local-project" },
    });
    const projectId = created.json().id as number;

    const res = await app.inject({ method: "DELETE", url: "/api/hosts/local?cascade=true" });
    expect(res.statusCode).toBe(400);

    // The guard must run before any cascade side effect — the local
    // project must still exist afterward, not have been swept up by the
    // cascade block ahead of deleteHost's own (too-late) local-host check.
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect((projects.json() as Array<{ id: number }>).some((p) => p.id === projectId)).toBe(true);

    await app.close();
  });

  it("404s deleting an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/hosts/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409s deleting a host that still has projects, without cascade", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-3", baseUrl: "http://127.0.0.1:4003", token: "t" },
    });
    const { id } = created.json();
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "on-box-3", cwd: "/remote/path", hostId: id },
    });

    const res = await app.inject({ method: "DELETE", url: `/api/hosts/${id}` });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("cascade-deletes a host, its projects, and their sessions (best-effort, host unreachable)", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      // Deliberately not listening — cascade termination must be best-effort
      // and not block the delete when the agent is unreachable.
      payload: { name: "box-4", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id: hostId } = created.json();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "on-box-4", cwd: "/remote/path", hostId },
    });
    const projectId = project.json().id as number;

    const res = await app.inject({ method: "DELETE", url: `/api/hosts/${hostId}?cascade=true` });
    expect(res.statusCode).toBe(204);

    const hosts = await app.inject({ method: "GET", url: "/api/hosts" });
    expect((hosts.json() as Array<{ id: string }>).some((h) => h.id === hostId)).toBe(false);

    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect((projects.json() as Array<{ id: number }>).some((p) => p.id === projectId)).toBe(false);

    await app.close();
  });

  it("local host always pings online", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/hosts/local/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: true });
    await app.close();
  });

  it("404s pinging an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/hosts/does-not-exist/ping" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("reports offline for an unreachable remote host", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-5", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/ping` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: false });

    await app.close();
  });
});
