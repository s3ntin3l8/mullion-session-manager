import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  disconnect,
  getIntegration,
  getToken,
  InvalidTokenError,
  setPat,
} from "../../src/services/github-integration.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const tmpDb = path.join(os.tmpdir(), `github-integration-test-${process.pid}.db`);

describe("github-integration service", () => {
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
    // `integrations` is a singleton row per provider (like `settings`), and
    // this file's tests share one tmpDb across `it`s (see beforeAll) — reset
    // it after every test so an earlier test's connected state can't leak
    // into a later one that expects to start disconnected.
    const app = await buildApp();
    disconnect(app);
    await app.close();
  });

  it("reports disconnected with no row", async () => {
    const app = await buildApp();
    expect(getIntegration(app)).toEqual(
      expect.objectContaining({ connected: false, tokenType: null, login: null, scopes: null }),
    );
    await app.close();
  });

  it("validates against GitHub, then round-trips the token through setPat/getToken", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { login: "octocat" }, { "x-oauth-scopes": "repo, read:org" }),
    );
    const app = await buildApp();
    const summary = await setPat(app, "ghp_abc123");
    expect(summary).toEqual(
      expect.objectContaining({
        connected: true,
        tokenType: "pat",
        login: "octocat",
        scopes: ["repo", "read:org"],
      }),
    );
    expect(getToken(app)).toBe("ghp_abc123");
    await app.close();
  });

  it("sends a User-Agent and bearer auth when validating (GitHub 400s requests without one)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await setPat(app, "ghp_abc123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_abc123",
          "User-Agent": expect.any(String),
        }),
      }),
    );
    await app.close();
  });

  it("stores the token opaque to EncryptionService when DB_ENCRYPTION_KEY is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
    const app = await buildApp();
    await setPat(app, "s3cr3t-token");
    expect(getToken(app)).toBe("s3cr3t-token");
    await app.close();
    delete process.env.DB_ENCRYPTION_KEY;
  });

  it("rejects a token GitHub itself rejects, without persisting anything", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));
    const app = await buildApp();
    await expect(setPat(app, "bad-token")).rejects.toThrow(InvalidTokenError);
    expect(getIntegration(app).connected).toBe(false);
    await app.close();
  });

  it("rejects when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const app = await buildApp();
    await expect(setPat(app, "any-token")).rejects.toThrow(InvalidTokenError);
    await app.close();
  });

  it("disconnect clears a stored token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
    const app = await buildApp();
    await setPat(app, "ghp_abc123");
    expect(getIntegration(app).connected).toBe(true);
    disconnect(app);
    expect(getIntegration(app)).toEqual(expect.objectContaining({ connected: false }));
    expect(getToken(app)).toBeNull();
    await app.close();
  });

  it("reconnecting with a new token overwrites the old one (onConflictDoUpdate)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { login: "first" }));
    const app = await buildApp();
    await setPat(app, "token-1");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { login: "second" }));
    const summary = await setPat(app, "token-2");
    expect(summary.login).toBe("second");
    expect(getToken(app)).toBe("token-2");
    await app.close();
  });

  it("deviceFlowAvailable reflects whether GITHUB_OAUTH_CLIENT_ID is configured", async () => {
    // No need to clear GITHUB_OAUTH_CLIENT_ID before the first assertion here
    // — test/setup.ts now clears every schema-defined config var once per
    // test file, so a developer's shell can't leak into the "unconfigured"
    // default this asserts.
    const app = await buildApp();
    expect(getIntegration(app).deviceFlowAvailable).toBe(false);
    await app.close();

    process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.abc123";
    const app2 = await buildApp();
    expect(getIntegration(app2).deviceFlowAvailable).toBe(true);
    await app2.close();
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
  });
});
