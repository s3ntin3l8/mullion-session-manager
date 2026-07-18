import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { disconnect } from "../../src/services/github-integration.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tmpDb = path.join(os.tmpdir(), `integrations-route-test-${process.pid}.db`);

describe("integrations route (issue #27)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Singleton row shared across this file's tests (see beforeAll) — reset
    // it so an earlier test's connected state never leaks into the next.
    const app = await buildApp();
    disconnect(app);
    await app.close();
  });

  it("GET reports disconnected with no integration configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/integrations/github" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ connected: false, login: null, tokenType: null }),
    );
    await app.close();
  });

  it("PUT validates and stores a PAT, never returning the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "ghp_super_secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({ connected: true, tokenType: "pat", login: "octocat" }),
    );
    expect(res.body).not.toMatch(/ghp_super_secret/);
    await app.close();
  });

  it("PUT 400s when GitHub rejects the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "bad-token" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PUT 400s an empty token body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("DELETE disconnects and GET reflects it afterward", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await app.inject({
      method: "PUT",
      url: "/api/integrations/github/token",
      payload: { token: "ghp_abc" },
    });

    const del = await app.inject({ method: "DELETE", url: "/api/integrations/github" });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({ method: "GET", url: "/api/integrations/github" });
    expect(get.json()).toEqual(expect.objectContaining({ connected: false }));
    await app.close();
  });
});
