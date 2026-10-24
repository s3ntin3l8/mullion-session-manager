// Issue #29 — the Runway integration routes.
//
// The admin key is WRITE-ONLY, the same never-echo-secrets posture the
// GitHub token route and the Hermes key route use: GET returns only
// { hasKey, updatedAt }, and the plaintext never appears in a response
// body or in GET /api/settings.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearRunwayKey, getRunwayKey } from "../../src/services/runway-integration.js";
import { resetRunwayCache } from "../../src/services/runway-client.js";
import { resetRunwayQuarantine } from "../../src/services/runway-quarantine.js";

const tmpDb = path.join(os.tmpdir(), `integrations-runway-test-${process.pid}.db`);

describe("Runway quota integration routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    resetRunwayCache();
    resetRunwayQuarantine();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearRunwayKey(app);
    // The settings persist in the database across tests, so a test that
    // turns polling off has to turn it back on for the next one.
    applySettingsPatch(app, { runway: { apiUrl: "", pollSeconds: 60 } });
    resetRunwayCache();
    resetRunwayQuarantine();
  });

  // Distinct client address per call: these routes are rate-limited per IP.
  let nextAddr = 1;
  const call = (method: "GET" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      remoteAddress: `10.4.0.${nextAddr++}`,
    });

  it("GET reports no key by default", async () => {
    const res = await call("GET", "/api/integrations/runway");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasKey: false, updatedAt: null });
  });

  it("PUT stores the key and never returns it", async () => {
    const res = await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
    expect(res.statusCode).toBe(200);
    expect(res.json().hasKey).toBe(true);
    expect(res.body).not.toContain("runway-admin");
    expect(getRunwayKey(app)).toBe("runway-admin");
  });

  it("the key never appears in GET /api/settings", async () => {
    await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
    applySettingsPatch(app, { runway: { apiUrl: "https://runway.example" } });
    const res = await call("GET", "/api/settings");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("runway-admin");
    expect(res.json().runway.apiUrl).toBe("https://runway.example");
  });

  it("DELETE clears the key", async () => {
    await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
    const res = await call("DELETE", "/api/integrations/runway");
    expect(res.statusCode).toBe(204);
    expect(getRunwayKey(app)).toBeNull();
  });

  it("PUT rejects an empty key", async () => {
    const res = await call("PUT", "/api/integrations/runway/key", { key: "" });
    expect(res.statusCode).toBe(400);
  });

  describe("GET /api/runway/quota", () => {
    it("reports configured:false when the feature is off", async () => {
      const res = await call("GET", "/api/runway/quota");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false, fetchedAt: null, agents: [] });
      // An unconfigured feature must not reach out to Runway at all.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports configured:false when there is no key", async () => {
      applySettingsPatch(app, { runway: { apiUrl: "https://runway.example" } });
      const res = await call("GET", "/api/runway/quota");
      expect(res.json().configured).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports the per-agent quota when Runway answers", async () => {
      applySettingsPatch(app, {
        runway: { apiUrl: "https://runway.example", providerMap: { anthropic: "claude" } },
      });
      await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          limits: [
            {
              provider_id: "anthropic",
              window_type: "weekly",
              pct_used: 87.5,
              reset_at: "2026-10-24T12:00:00Z",
              is_unlimited: false,
              stale: false,
            },
            // A provider the operator has not mapped — never reported.
            { provider_id: "gemini", pct_used: 99 },
          ],
        }),
      });

      const res = await call("GET", "/api/runway/quota");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.fetchedAt).not.toBeNull();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]).toMatchObject({
        agent: "claude",
        providerId: "anthropic",
        pctUsed: 87.5,
        exhausted: false,
      });
      expect(body.agents[0].resetAt).toBe("2026-10-24T12:00:00.000Z");
    });

    it("marks an exhausted provider", async () => {
      applySettingsPatch(app, {
        runway: { apiUrl: "https://runway.example", providerMap: { anthropic: "claude" } },
      });
      await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          limits: [{ provider_id: "anthropic", pct_used: 100 }],
        }),
      });

      const res = await call("GET", "/api/runway/quota");
      expect(res.json().agents[0]).toMatchObject({ agent: "claude", exhausted: true });
    });

    it("reports fetchedAt null when Runway is unreachable — never 'everything is fine'", async () => {
      applySettingsPatch(app, { runway: { apiUrl: "https://runway.example" } });
      await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret
      fetchMock.mockRejectedValue(new Error("network down"));

      const res = await call("GET", "/api/runway/quota");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      // "No quota information" — NOT an empty list that reads as healthy.
      expect(body.fetchedAt).toBeNull();
      expect(body.agents).toEqual([]);
    });

    it("honours pollSeconds: 0 — it does not reach Runway with the admin key", async () => {
      // "Never poll" has to mean it on the READ path too: the badge polls
      // this route, so a fetch per read would hammer Runway with the admin
      // key — and against a 10/min limit.
      applySettingsPatch(app, {
        runway: { apiUrl: "https://runway.example", pollSeconds: 0 },
      });
      await call("PUT", "/api/integrations/runway/key", { key: "runway-admin" }); // pragma: allowlist secret

      const res = await call("GET", "/api/runway/quota");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      // No snapshot was ever taken, so there is nothing to report — and
      // nothing was fetched to get one.
      expect(body.fetchedAt).toBeNull();
      expect(body.agents).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
