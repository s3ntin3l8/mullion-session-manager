import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { eq, and } from "drizzle-orm";
import { integrations, projects, tasks } from "../../src/db/schema.js";
import { GITHUB_PROVIDER } from "../../src/services/github-integration.js";
import { gitEnv } from "../../src/services/git-env.js";

const tmpDb = path.join(os.tmpdir(), `webhooks-route-test-${process.pid}.db`);
const TEST_SECRET = "test-webhook-secret-123"; // pragma: allowlist secret

function signPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

// #490 — a real git repo with an `origin` remote matching the payload's
// `owner/repo`, so `resolveRepoRef` (parseGitRemote under the hood) finds
// this project as a match, the same way task-watcher's own tests do.
function createMatchingGitRepo(owner: string, repo: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webhooks-route-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

describe("webhook routes", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_WEBHOOK_BASE_URL = "https://hooks.example.com";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_WEBHOOK_BASE_URL;
  });

  beforeEach(async () => {
    // Seed the integrations row with a known webhook secret.
    const app = await buildApp();
    const secretEnc = app.encryption.encryptString(TEST_SECRET);
    app.db
      .insert(integrations)
      .values({
        provider: GITHUB_PROVIDER,
        webhookEnabled: true,
        webhookSecretEnc: secretEnc,
      })
      .onConflictDoUpdate({
        target: integrations.provider,
        set: { webhookEnabled: true, webhookSecretEnc: secretEnc },
      })
      .run();
    await app.close();
  });

  it("rejects requests without x-hub-signature-256 header", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "content-type": "application/json" },
      payload: { action: "opened" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "missing signature" });
    await app.close();
  });

  it("rejects requests with an invalid signature", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened" });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid signature" });
    await app.close();
  });

  it("accepts requests with a valid signature and returns 200", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened", pull_request: { id: 1 } });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("accepts known GitHub event types (x-github-event header)", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ action: "synchronize" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "pull_request",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts unknown event types gracefully", async () => {
    const app = await buildApp();
    const payload = JSON.stringify({ zen: "anything" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": "ping",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 401 when no webhook secret is configured", async () => {
    // Overwrite the DB row to have no secret.
    const seedApp = await buildApp();
    seedApp.db
      .update(integrations)
      .set({ webhookSecretEnc: null })
      .where(eq(integrations.provider, GITHUB_PROVIDER))
      .run();
    await seedApp.close();

    const app = await buildApp();
    const payload = JSON.stringify({ action: "opened" });
    const sig = signPayload(payload, TEST_SECRET);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "webhook not configured" });
    await app.close();
  });

  describe("task ingest (#490)", () => {
    beforeAll(() => {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    });

    afterAll(() => {
      delete process.env.MULLION_TASK_MASTER_ENABLED;
    });

    function issuesPayload(overrides: Record<string, unknown>) {
      return JSON.stringify({
        action: "labeled",
        repository: { full_name: "acme/widgets", open_issues_count: 1 },
        issue: {
          number: 42,
          title: "Fix the thing",
          body: "some details",
          html_url: "https://github.com/acme/widgets/issues/42",
          labels: [{ name: "mullion-task" }],
        },
        ...overrides,
      });
    }

    it("ingests a labeled issue carrying the task label into a ready task", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p", cwd })
        .returning()
        .all();

      const payload = issuesPayload({});
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const [task] = app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 42)))
        .all();
      expect(task).toBeDefined();
      expect(task.status).toBe("ready");
      expect(task.title).toBe("Fix the thing");

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("ignores a labeled event whose label doesn't match MULLION_TASK_LABEL", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-wronglabel");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p2", cwd })
        .returning()
        .all();

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-wronglabel", open_issues_count: 1 },
        issue: {
          number: 43,
          title: "Not a task",
          body: null,
          html_url: "https://github.com/acme/widgets-wronglabel/issues/43",
          labels: [{ name: "bug" }],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const found = app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 43)))
        .all();
      expect(found).toHaveLength(0);

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does not ingest when Task Master is disabled", async () => {
      delete process.env.MULLION_TASK_MASTER_ENABLED;
      const cwd = createMatchingGitRepo("acme", "widgets-disabled");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p3", cwd })
        .returning()
        .all();

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-disabled", open_issues_count: 1 },
        issue: {
          number: 44,
          title: "Should not ingest",
          body: null,
          html_url: "https://github.com/acme/widgets-disabled/issues/44",
          labels: [{ name: "mullion-task" }],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const found = app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 44)))
        .all();
      expect(found).toHaveLength(0);

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    });

    it("returns 200 with no matching project (no-op)", async () => {
      const app = await buildApp();
      const payload = issuesPayload({
        repository: { full_name: "nobody/nothing", open_issues_count: 1 },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("syncs a tracked task to done when its issue closes", async () => {
      // Hermes review, PR #503: a stubbed token + a per-test spy on
      // getIssueState (not a module-level mock) so this asserts the actual
      // end-to-end status flip at the route layer, not just "reached
      // syncClosedIssueToLocal without throwing."
      const cwd = createMatchingGitRepo("acme", "widgets-close");
      const app = await buildApp();

      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const { setPat } = await import("../../src/services/github-integration.js");
      await setPat(app, "ghp_test_token");
      global.fetch = originalFetch;

      const githubWrite = await import("../../src/services/github-write.js");
      const getIssueStateSpy = vi
        .spyOn(githubWrite, "getIssueState")
        .mockResolvedValue("closed");

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p4", cwd })
        .returning()
        .all();
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 45,
          title: "Reviewing task",
          status: "reviewing",
        })
        .run();

      const payload = JSON.stringify({
        action: "closed",
        repository: { full_name: "acme/widgets-close", open_issues_count: 0 },
        issue: {
          number: 45,
          title: "Reviewing task",
          body: null,
          html_url: "https://github.com/acme/widgets-close/issues/45",
          labels: [],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const [updated] = app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 45)))
        .all();
      expect(updated.status).toBe("done");
      expect(getIssueStateSpy).toHaveBeenCalledWith(
        "ghp_test_token",
        "acme",
        "widgets-close",
        45,
      );

      getIssueStateSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("ingests an issue that already carries the task label at creation (action: opened)", async () => {
      // Hermes review, PR #503: a label picker at creation time (or the
      // create-with-labels API) fires "opened", not "labeled" — this must
      // ingest just as eagerly as a genuinely-labeled event.
      const cwd = createMatchingGitRepo("acme", "widgets-open");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p5", cwd })
        .returning()
        .all();

      const payload = issuesPayload({
        action: "opened",
        repository: { full_name: "acme/widgets-open", open_issues_count: 1 },
        issue: {
          number: 46,
          title: "Created with the label already on it",
          body: null,
          html_url: "https://github.com/acme/widgets-open/issues/46",
          labels: [{ name: "mullion-task" }],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const [task] = app.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 46)))
        .all();
      expect(task).toBeDefined();
      expect(task.status).toBe("ready");

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });
});
