import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch, mergeSettings } from "../../src/services/settings.js";
import {
  clearHermesKey,
  getHermesKey,
  setHermesKey,
} from "../../src/services/hermes-integration.js";

const tmpDb = path.join(os.tmpdir(), `integrations-hermes-test-${process.pid}.db`);

describe("Hermes review relay integration routes", () => {
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
    applySettingsPatch(app, { reviewRelay: { apiUrl: "" } });
  });

  // Distinct client address per call: these routes are rate-limited per IP.
  let nextAddr = 1;
  const call = (method: "GET" | "PUT" | "DELETE" | "POST", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      remoteAddress: `10.3.0.${nextAddr++}`,
    });

  it("GET reports no key by default", async () => {
    const res = await call("GET", "/api/integrations/hermes");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hasKey: false, updatedAt: null });
  });

  it("PUT stores the key and never returns it", async () => {
    const res = await call("PUT", "/api/integrations/hermes/key", { key: "sekret-key" }); // pragma: allowlist secret
    expect(res.statusCode).toBe(200);
    expect(res.json().hasKey).toBe(true);
    expect(res.body).not.toContain("sekret-key");
    expect(getHermesKey(app)).toBe("sekret-key"); // pragma: allowlist secret

    const got = await call("GET", "/api/integrations/hermes");
    expect(got.json().hasKey).toBe(true);
    expect(got.body).not.toContain("sekret-key");
  });

  it("the key never appears in GET /api/settings", async () => {
    await call("PUT", "/api/integrations/hermes/key", { key: "sekret-key" }); // pragma: allowlist secret
    applySettingsPatch(app, { reviewRelay: { apiUrl: "http://192.168.2.6:8643" } });
    const res = await call("GET", "/api/settings");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sekret-key");
    expect(res.json().reviewRelay.apiUrl).toBe("http://192.168.2.6:8643");
  });

  it("PUT rejects an empty or missing key", async () => {
    expect((await call("PUT", "/api/integrations/hermes/key", { key: "" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/integrations/hermes/key", {})).statusCode).toBe(400);
  });

  it("DELETE clears the key", async () => {
    await call("PUT", "/api/integrations/hermes/key", { key: "sekret-key" }); // pragma: allowlist secret
    const res = await call("DELETE", "/api/integrations/hermes");
    expect(res.statusCode).toBe(204);
    expect(getHermesKey(app)).toBeNull();
    expect((await call("GET", "/api/integrations/hermes")).json().hasKey).toBe(false);
  });

  describe("POST /api/integrations/hermes/test", () => {
    it("400s when no API URL is configured", async () => {
      const res = await call("POST", "/api/integrations/hermes/test");
      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports ok when /health answers", async () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: "http://192.168.2.6:8643" } });
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      const res = await call("POST", "/api/integrations/hermes/test");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fetchMock.mock.calls[0][0]).toBe("http://192.168.2.6:8643/health");
    });

    it("502s when the server is unreachable", async () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: "http://192.168.2.6:8643" } });
      fetchMock.mockRejectedValue(new Error("connect timed out"));
      const res = await call("POST", "/api/integrations/hermes/test");
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain("unreachable");
    });
  });

  describe("GET /api/integrations/hermes/model-options (#1775)", () => {
    const URL = "/api/integrations/hermes/model-options";
    const configure = () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: "http://192.168.2.6:8642/p/review-bot" } });
      setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    };
    const options = (providers: unknown[]) =>
      new Response(JSON.stringify({ providers, model: "x", provider: "y" }), { status: 200 });

    it("reports not-configured with no URL or no key, without calling Hermes", async () => {
      expect((await call("GET", URL)).json()).toEqual({
        available: false,
        reason: "not-configured",
      });
      applySettingsPatch(app, { reviewRelay: { apiUrl: "http://192.168.2.6:8642" } });
      expect((await call("GET", URL)).json()).toEqual({
        available: false,
        reason: "not-configured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lists the usable providers with the stored key, never the unconfigured ones", async () => {
      configure();
      fetchMock.mockResolvedValue(
        options([
          {
            slug: "anthropic",
            name: "Anthropic",
            models: ["claude-sonnet-5-5", "claude-sonnet-5-5"],
          },
          { slug: "openrouter", name: "OpenRouter", models: ["x/y:free"], authenticated: true },
          { slug: "nous", name: "Nous", models: [], authenticated: true },
          { slug: "gemini", name: "Gemini", models: ["g"], authenticated: false },
          { name: "no slug", models: ["z"] },
        ]),
      );
      const res = await call("GET", URL);
      expect(res.json()).toEqual({
        available: true,
        providers: [
          { provider: "anthropic", name: "Anthropic", models: ["claude-sonnet-5-5"] },
          { provider: "openrouter", name: "OpenRouter", models: ["x/y:free"] },
        ],
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "http://192.168.2.6:8642/p/review-bot/api/model/options?include_unconfigured=0",
      );
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sekret-key");
      expect(res.body).not.toContain("sekret-key");
    });

    it("caps one provider's models so the dropdown stays usable", async () => {
      configure();
      const many = Array.from({ length: 1000 }, (_, i) => `m${i}`);
      fetchMock.mockResolvedValue(options([{ slug: "openrouter", name: "OR", models: many }]));
      const res = await call("GET", URL);
      expect(res.json().providers[0].models).toHaveLength(300);
    });

    it("answers an available, empty list when no provider has anything to offer", async () => {
      configure();
      fetchMock.mockResolvedValue(
        options([
          { slug: "gemini", name: "Gemini", models: ["g"], authenticated: false },
          { slug: "nous", name: "Nous", models: [] },
        ]),
      );
      expect((await call("GET", URL)).json()).toEqual({ available: true, providers: [] });
    });

    it("shares the cap between providers, so many of them stay a usable list", async () => {
      configure();
      const many = Array.from({ length: 300 }, (_, i) => `m${i}`);
      fetchMock.mockResolvedValue(
        options(
          Array.from({ length: 10 }, (_, i) => ({ slug: `p${i}`, name: `P${i}`, models: many })),
        ),
      );
      const providers = (await call("GET", URL)).json().providers as Array<{ models: string[] }>;
      expect(providers).toHaveLength(10);
      expect(providers.every((p) => p.models.length === 60)).toBe(true);
    });

    it("reports unauthorized on a 401 so the UI can say the key is wrong", async () => {
      configure();
      fetchMock.mockResolvedValue(new Response("no", { status: 401 }));
      expect((await call("GET", URL)).json()).toEqual({ available: false, reason: "unauthorized" });
    });

    it("reports unreachable, with a 200, when Hermes is down or answers nonsense", async () => {
      configure();
      fetchMock.mockRejectedValueOnce(new Error("connect timed out"));
      const down = await call("GET", URL);
      expect(down.statusCode).toBe(200);
      expect(down.json()).toEqual({ available: false, reason: "unreachable" });
      fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
      expect((await call("GET", URL)).json()).toEqual({ available: false, reason: "unreachable" });
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      expect((await call("GET", URL)).json()).toEqual({ available: false, reason: "unreachable" });
    });
  });

  describe("settings.reviewRelay sanitizing", () => {
    it("treats relay settings saved before `provider` existed as Hermes", () => {
      const merged = mergeSettings({ reviewRelay: { apiUrl: "http://h:8643" } });
      expect(merged.reviewRelay.provider).toBe("hermes");
      expect(mergeSettings({ reviewRelay: { apiUrl: "" } }).reviewRelay.provider).toBe("none");
      expect(
        mergeSettings({ reviewRelay: { provider: "none", apiUrl: "http://h:8643" } }).reviewRelay
          .provider,
      ).toBe("none");
    });

    it("has safe defaults (feature off)", async () => {
      const res = await call("GET", "/api/settings");
      expect(res.json().reviewRelay).toEqual({
        provider: "none",
        apiUrl: "",
        model: "hermes-agent",
        modelProvider: "",
        promptRepo: "",
        promptPath: "hermes-review-prompt.md",
        triagePromptRepo: "",
        triagePromptPath: "hermes-triage-prompt.md",
        cooldownMinutes: 10,
        reviewerBotLogin: "s3ntin3l8-hermes[bot]",
      });
    });

    it("trims strings and falls back on an out-of-range cooldown", async () => {
      const next = applySettingsPatch(app, {
        reviewRelay: { apiUrl: "  http://h:8643  ", cooldownMinutes: -5 },
      });
      expect(next.reviewRelay.apiUrl).toBe("http://h:8643");
      expect(next.reviewRelay.cooldownMinutes).toBe(10);
      expect(
        applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } }).reviewRelay,
      ).toMatchObject({ cooldownMinutes: 0 });
    });

    it("normalises the reviewer bot login to the form a bot's reviews carry", async () => {
      // A bot's review is authored by "<app-slug>[bot]", and the shared
      // workflow derives the same login from its `mention-trigger` input. A
      // value without the suffix would match nothing, and the base rule it
      // guards would quietly stop applying.
      expect(
        applySettingsPatch(app, { reviewRelay: { reviewerBotLogin: "s3ntin3l8-hermes" } })
          .reviewRelay.reviewerBotLogin,
      ).toBe("s3ntin3l8-hermes[bot]");
      expect(
        applySettingsPatch(app, { reviewRelay: { reviewerBotLogin: "s3ntin3l8-hermes[bot]" } })
          .reviewRelay.reviewerBotLogin,
      ).toBe("s3ntin3l8-hermes[bot]");
      // Empty keeps "any bot's review counts".
      expect(
        applySettingsPatch(app, { reviewRelay: { reviewerBotLogin: "" } }).reviewRelay
          .reviewerBotLogin,
      ).toBe("");
    });
  });
});
