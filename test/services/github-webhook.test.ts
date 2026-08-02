import type { FastifyInstance } from "fastify";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  enableWebhooks,
  disableWebhooks,
  getWebhookSecret,
} from "../../src/services/github-webhook.js";
import { setPat, GITHUB_PROVIDER } from "../../src/services/github-integration.js";
import { projects, integrations } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("../../src/services/git-remote.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseGitRemote: vi.fn().mockReturnValue({ owner: "test-owner", repo: "test-repo" }),
  };
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function emptyResponse(status: number) {
  return new Response(null, { status });
}

const tmpDb = path.join(os.tmpdir(), `github-webhook-test-${process.pid}.db`);

describe("github-webhook service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_WEBHOOK_BASE_URL = "https://hooks.example.com";
    process.env.GITHUB_POLL_INTERVAL_ACTIVE = "15";
    process.env.GITHUB_POLL_INTERVAL_QUIET = "60";
    process.env.GITHUB_POLL_STALE_THRESHOLD = "300";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_WEBHOOK_BASE_URL;
    delete process.env.GITHUB_POLL_INTERVAL_ACTIVE;
    delete process.env.GITHUB_POLL_INTERVAL_QUIET;
    delete process.env.GITHUB_POLL_STALE_THRESHOLD;
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const app = await buildApp();
    // Full reset between tests — disconnect() (github-integration.ts) now
    // deliberately only clears the PAT columns (Hermes review, PR #504:
    // it used to delete the whole row, silently wiping an independently-
    // configured GitHub App), so this suite's own test isolation needs a
    // real row delete instead of relying on that side effect.
    app.db.delete(integrations).where(eq(integrations.provider, GITHUB_PROVIDER)).run();
    app.db.delete(projects).run();
    await app.close();
  });

  async function seedProject(app: FastifyInstance): Promise<void> {
    app.db.insert(projects).values({ name: "test", cwd: "/tmp/test-repo", hostId: "local" }).run();
  }

  describe("enableWebhooks", () => {
    it("throws when no token is configured", async () => {
      const app = await buildApp();
      await expect(enableWebhooks(app)).rejects.toThrow("No GitHub token configured");
      await app.close();
    });

    it("registers hooks for each project repo and stores the secret", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 1 }));

      const result = await enableWebhooks(app);
      expect(result.reposSucceeded).toBe(1);
      expect(result.reposFailed).toBe(0);

      const secret = getWebhookSecret(app);
      expect(secret).toBeTruthy();
      expect(typeof secret).toBe("string");
      expect(secret.length).toBeGreaterThan(0);
      await app.close();
    });

    it("skips existing hooks with matching url", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(
        jsonResponse(200, [
          {
            id: 99,
            active: true,
            config: { url: "https://hooks.example.com/api/webhooks/github" },
          },
        ]),
      );

      const result = await enableWebhooks(app);
      expect(result.reposSucceeded).toBe(1);
      await app.close();
    });

    it("counts failures when registerHook errors", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));

      const result = await enableWebhooks(app);
      expect(result.reposFailed).toBe(1);
      await app.close();
    });
  });

  describe("disableWebhooks", () => {
    it("removes hooks and resets webhookEnabled", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, [
            {
              id: 1,
              active: true,
              config: { url: "https://hooks.example.com/api/webhooks/github" },
            },
          ]),
        )
        .mockResolvedValueOnce(emptyResponse(204));

      await disableWebhooks(app);
      await app.close();
    });

    it("does not throw when there is no token", async () => {
      const app = await buildApp();
      await expect(disableWebhooks(app)).resolves.toBeUndefined();
      await app.close();
    });
  });

  describe("getWebhookSecret", () => {
    it("returns null when no webhook is configured", async () => {
      const app = await buildApp();
      expect(getWebhookSecret(app)).toBeNull();
      await app.close();
    });

    it("returns decrypted secret after enablement", async () => {
      process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValue(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 1 }));

      await enableWebhooks(app);
      const secret = getWebhookSecret(app);
      expect(secret).toBeTruthy();
      expect(typeof secret).toBe("string");
      await app.close();
      delete process.env.DB_ENCRYPTION_KEY;
    });
  });
});
