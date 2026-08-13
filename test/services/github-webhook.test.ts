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
  registerProjectWebhook,
} from "../../src/services/github-webhook.js";
import { setPat, getIntegration, GITHUB_PROVIDER } from "../../src/services/github-integration.js";
import { projects, integrations, webhookRegistrations } from "../../src/db/schema.js";
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

    // #490b — a registration row is what makes webhookRegisteredCount real
    // (previously hardcoded 0) and what the reconciler diffs against.
    it("persists a webhook_registrations row on successful registration", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 42 }));

      await enableWebhooks(app);

      const [row] = app.db.select().from(webhookRegistrations).all();
      expect(row).toMatchObject({
        owner: "test-owner",
        repo: "test-repo",
        hookId: 42,
        lastError: null,
      });
      expect(row.registeredAt).not.toBeNull();
      expect(getIntegration(app).webhookRegisteredCount).toBe(1);
      await app.close();
    });

    // #667 — a newly-created hook subscribes to issue_dependencies
    // alongside the pre-#667 event list, and the persisted row is stamped
    // with the current WEBHOOK_EVENTS_VERSION — the value
    // webhook-reconciler.ts's own staleness gate compares against.
    it("#667 — subscribes a fresh hook to issue_dependencies and stamps eventsVersion", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 7 }));

      await enableWebhooks(app);

      const createCall = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse((createCall![1] as RequestInit).body as string) as {
        events: string[];
      };
      expect(body.events).toEqual(
        expect.arrayContaining(["issues", "pull_request", "issue_dependencies"]),
      );

      const [row] = app.db.select().from(webhookRegistrations).all();
      expect(row.eventsVersion).toBeGreaterThan(0);
      await app.close();
    });

    // #667 — an already-registered hook is PATCHed with the current events
    // list on every (re-)registration, not just its first creation — the
    // fix for the event-list-frozen-at-creation gap: without sending
    // `events` on the PATCH, an event added after a hook already existed
    // would never reach it, since PATCHing without `events` leaves GitHub's
    // own stored subscription untouched.
    it("#667 — PATCHes an existing hook's events too, not just active/config", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return Promise.resolve(jsonResponse(200, { id: 5 }));
        return Promise.resolve(
          jsonResponse(200, [
            {
              id: 5,
              active: true,
              config: { url: "https://hooks.example.com/api/webhooks/github" },
            },
          ]),
        );
      });

      await enableWebhooks(app);

      const patchCall = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string) as {
        events?: string[];
      };
      expect(body.events).toEqual(expect.arrayContaining(["issue_dependencies"]));
      await app.close();
    });

    // #490b — PATCHes (not skips) an already-existing Mullion hook, so a
    // second enable rotates the hook's own secret to match whatever this
    // call just persisted — the fix for the secret-divergence bug where a
    // fresh MULLION_WEBHOOK_SECRET-less enable minted a new local secret
    // while GitHub's hook kept signing with the old one.
    it("PATCHes an existing hook with matching url instead of skipping it", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") return Promise.resolve(jsonResponse(200, { id: 99 }));
        return Promise.resolve(
          jsonResponse(200, [
            {
              id: 99,
              active: true,
              config: { url: "https://hooks.example.com/api/webhooks/github" },
            },
          ]),
        );
      });

      const result = await enableWebhooks(app);
      expect(result.reposSucceeded).toBe(1);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/hooks/99"),
        expect.objectContaining({ method: "PATCH" }),
      );

      const [row] = app.db.select().from(webhookRegistrations).all();
      expect(row.hookId).toBe(99);
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

    // #490b — a stale registration record surviving disable would both
    // misreport webhookRegisteredCount and let a later reconcile pass
    // believe the project is still covered, skipping it.
    it("clears webhook_registrations records so webhookRegisteredCount reflects reality", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 7 }));
      await enableWebhooks(app);
      expect(getIntegration(app).webhookRegisteredCount).toBe(1);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, [
            {
              id: 7,
              active: true,
              config: { url: "https://hooks.example.com/api/webhooks/github" },
            },
          ]),
        )
        .mockResolvedValueOnce(emptyResponse(204));
      await disableWebhooks(app);

      expect(getIntegration(app).webhookRegisteredCount).toBe(0);
      const [row] = app.db.select().from(webhookRegistrations).all();
      expect(row.hookId).toBeNull();
      expect(row.registeredAt).toBeNull();
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

    // #490b — the gap that let a delivery verify against a hook GitHub no
    // longer has (or one that was force-disabled without unregistering).
    it("returns null once disabled, even though a secret is still stored", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { login: "octocat" }));
      const app = await buildApp();
      await setPat(app, "ghp_token");
      seedProject(app);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
      await enableWebhooks(app);
      expect(getWebhookSecret(app)).toBeTruthy();

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(200, []));
      await disableWebhooks(app);

      expect(getWebhookSecret(app)).toBeNull();
      await app.close();
    });
  });

  describe("registerProjectWebhook (#490b)", () => {
    it("returns 'skipped' and writes no registration row for an unresolvable repo", async () => {
      const { parseGitRemote } = await import("../../src/services/git-remote.js");
      vi.mocked(parseGitRemote).mockReturnValueOnce(null);
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "no-repo", cwd: "/tmp/no-repo", hostId: "local" })
        .returning()
        .all();

      const outcome = await registerProjectWebhook(
        app,
        project,
        "ghp_token",
        "https://hooks.example.com/api/webhooks/github",
        "sekret",
      );

      expect(outcome).toBe("skipped");
      const rows = app.db.select().from(webhookRegistrations).all();
      expect(rows).toHaveLength(0);
      await app.close();
    });

    it("records lastError on a failed registration without clearing a prior success", async () => {
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "flaky", cwd: "/tmp/flaky", hostId: "local" })
        .returning()
        .all();
      const webhookUrl = "https://hooks.example.com/api/webhooks/github";

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 55 }));
      await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");
      const [afterSuccess] = app.db.select().from(webhookRegistrations).all();
      expect(afterSuccess.hookId).toBe(55);

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(500, { message: "boom" }));
      const outcome = await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");

      expect(outcome).toBe("failed");
      const [afterFailure] = app.db.select().from(webhookRegistrations).all();
      // hookId/registeredAt from the earlier success are left untouched —
      // only lastError is recorded.
      expect(afterFailure.hookId).toBe(55);
      expect(afterFailure.lastError).toContain("boom");
      await app.close();
    });

    // Hermes review, PR #511 — a failed registration attempt for a repo
    // that DIFFERS from the last successful one used to keep the old
    // hookId around under the new owner/repo, misreporting the row as
    // "registered" for a repo that never actually got a hook.
    it("clears hookId on a failed registration when the repo changed since the last success", async () => {
      const { parseGitRemote } = await import("../../src/services/git-remote.js");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "moved", cwd: "/tmp/moved", hostId: "local" })
        .returning()
        .all();
      const webhookUrl = "https://hooks.example.com/api/webhooks/github";

      // First registration succeeds against the default-mocked test-owner/test-repo.
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 77 }));
      await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");
      const [afterSuccess] = app.db.select().from(webhookRegistrations).all();
      expect(afterSuccess.hookId).toBe(77);
      expect(afterSuccess.owner).toBe("test-owner");
      expect(afterSuccess.repo).toBe("test-repo");

      // The project's cwd now resolves to a different repo, and this
      // attempt fails.
      vi.mocked(parseGitRemote).mockReturnValueOnce({ owner: "other-owner", repo: "other-repo" });
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(500, { message: "boom" }));
      const outcome = await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");

      expect(outcome).toBe("failed");
      const [afterFailure] = app.db.select().from(webhookRegistrations).all();
      expect(afterFailure.owner).toBe("other-owner");
      expect(afterFailure.repo).toBe("other-repo");
      // The stale hookId (test-owner/test-repo's hook 77) must NOT survive
      // under the new repo — it doesn't correspond to a hook that actually
      // exists on other-owner/other-repo.
      expect(afterFailure.hookId).toBeNull();
      expect(afterFailure.registeredAt).toBeNull();
      expect(afterFailure.lastError).toContain("boom");
      await app.close();
    });

    // Same scenario, but the repo is unchanged — the pre-existing
    // "don't clear a good hookId on a transient failure" behavior must
    // still hold (covered above by "records lastError on a failed
    // registration without clearing a prior success", repeated here only
    // to make the owner/repo-unchanged branch explicit).
    it("does not clear hookId on a failed registration for the same repo", async () => {
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "same-repo", cwd: "/tmp/same-repo", hostId: "local" })
        .returning()
        .all();
      const webhookUrl = "https://hooks.example.com/api/webhooks/github";

      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, []))
        .mockResolvedValueOnce(jsonResponse(201, { id: 88 }));
      await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");

      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(500, { message: "still broken" }));
      await registerProjectWebhook(app, project, "ghp_token", webhookUrl, "sekret");

      const [row] = app.db.select().from(webhookRegistrations).all();
      expect(row.hookId).toBe(88);
      expect(row.lastError).toContain("still broken");
      await app.close();
    });
  });
});
