import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { eq, and } from "drizzle-orm";
import { integrations, projects, tasks } from "../../src/db/schema.js";
import { GITHUB_PROVIDER } from "../../src/services/github-integration.js";
import { gitEnv } from "../../src/services/git-env.js";
import {
  subscribeToTaskEvents,
  clearTaskEventSubscribersForTests,
} from "../../src/services/task-events.js";

// #490a (Hermes review, PR #510) — the closed/unlabeled task sync is
// deliberately fire-and-forget in the route handler (see webhooks.ts's own
// comment on why: avoiding GitHub's ~10s webhook delivery timeout), so
// `app.inject()` resolving no longer guarantees the sync has finished. This
// polls the assertion instead of checking it immediately, the same
// "wait, don't assume synchronous completion" shape ws-tasks.test.ts's own
// waitUntil uses for its live-event assertions.
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!check()) throw new Error("condition never became true within timeout");
}

// #490a — a minimal fake WS socket for asserting a live /ws/tasks frame was
// broadcast during a webhook delivery, same shape as task-events.test.ts's
// own fakeSocket.
function fakeTaskEventSocket(): WebSocket & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => messages.push(JSON.parse(data)),
    on: () => {},
    messages,
  } as unknown as WebSocket & { messages: unknown[] };
}

// #490a — shared by the "closed" and "unlabeled" tests, both of which need
// a real connected PAT for resolveGitHubToken to hand a token to the
// GitHub write client (spied on per-test, never a real network call).
async function connectPat(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const { setPat } = await import("../../src/services/github-integration.js");
  await setPat(app, token);
  global.fetch = originalFetch;
}

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

  // Finding AS6 — the HMAC must be verified over the exact bytes GitHub
  // signed, not a JSON.stringify(JSON.parse(...)) reconstruction of them.
  // Deliberately pretty-printed with extra whitespace and a unicode escape
  // in a string value: JSON.parse then JSON.stringify would collapse the
  // whitespace and normalize "café" to a literal "café", producing
  // different bytes than what was actually signed — the old
  // reconstruct-from-parsed-body code would have 401'd this even though the
  // signature below is computed correctly over the exact wire bytes.
  it("verifies the HMAC over the exact raw bytes, not a re-serialized reconstruction", async () => {
    const app = await buildApp();
    const payload = '{\n  "action": "opened",\n  "note": "caf\\u00e9"\n}';
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

  // Finding AS6 — an empty body used to make request.body undefined, and
  // JSON.stringify(undefined) is the *value* undefined, not a string, so
  // crypto.createHmac(...).update(undefined) threw a 500 instead of the
  // intended 401. A genuinely empty body can never carry a valid signature
  // (the caller doesn't know the secret), so this must 401, not 500.
  it("returns 401 (not 500) for an empty POST body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=not-a-real-signature",
      },
      payload: "",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid signature" });
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

  // #490b — a stale secret surviving a disable (or a hook that was
  // force-disabled without a matching unregister) must not keep verifying
  // deliveries; getWebhookSecret now returns null once webhookEnabled is
  // false, even with a secret still stored.
  it("returns 401 once webhooks are disabled, even though a secret is still stored", async () => {
    const seedApp = await buildApp();
    seedApp.db
      .update(integrations)
      .set({ webhookEnabled: false })
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

  // Issue #523 — with in-app auth (MULLION_AUTH_TOKEN/MULLION_SESSION_SECRET)
  // enabled, authPlugin's onRequest hook used to 401 every delivery before it
  // ever reached this route's own HMAC check (GitHub can't send a session
  // cookie or bearer header). This file's own beforeEach/afterAll only manage
  // DATABASE_URL/MULLION_WEBHOOK_BASE_URL, so this describe block sets and
  // clears the auth env itself, in its own beforeEach/afterEach — the wider
  // authPlugin path-predicate coverage (including the exact-match-vs-prefix
  // reasoning, and the neighboring /api/integrations/github/webhooks/status
  // route staying gated) lives in test/plugins/auth.test.ts; this file only
  // proves the HMAC ladder itself still runs, since it's the one place with
  // a real seeded secret and signPayload already available.
  describe("with in-app auth enabled (issue #523)", () => {
    beforeEach(() => {
      process.env.MULLION_AUTH_TOKEN = "test-auth-token-0123456789"; // pragma: allowlist secret
      process.env.MULLION_SESSION_SECRET = "test-session-secret-0123456789"; // pragma: allowlist secret
    });

    afterEach(() => {
      delete process.env.MULLION_AUTH_TOKEN;
      delete process.env.MULLION_SESSION_SECRET;
    });

    it("accepts a correctly-signed payload with no session/bearer credential", async () => {
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

    it("still rejects a bad signature — the exemption didn't disable HMAC verification", async () => {
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

    // A "labeled" delivery can land on an issue that is already closed
    // (closing an issue doesn't strip its other labels, and a stray
    // relabel can fire on a closed issue too) — must not ingest a brand
    // new task for a dead issue, and must not let upsertIssueTask's
    // relabel-resurrection check (task-watcher.ts) spring a previously
    // label-lost `failed` task on THIS issue back to `ready`.
    it("ignores a labeled event on an already-closed issue", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-closed");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-closed", cwd })
        .returning()
        .all();

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-closed", open_issues_count: 0 },
        issue: {
          number: 45,
          title: "Already closed",
          body: null,
          html_url: "https://github.com/acme/widgets-closed/issues/45",
          state: "closed",
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
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 45)))
        .all();
      expect(found).toHaveLength(0);

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    // Relabel-resurrection (upsertIssueTask, task-watcher.ts) driven
    // through the webhook path — the same "labeled" delivery this
    // describe block's first test uses for fresh ingest also re-sights an
    // EXISTING task, and that's what resurrects a label-lost `failed` one.
    it("resurrects a label-lost failed task to ready via a 'labeled' delivery", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-relabel");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-relabel-p1", cwd })
        .returning()
        .all();
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 46,
          title: "Comes back",
          status: "failed",
          failureReason: "GitHub issue lost its tracking label",
          completedAt: new Date(),
        })
        .run();

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-relabel", open_issues_count: 1 },
        issue: {
          number: 46,
          title: "Comes back",
          body: null,
          html_url: "https://github.com/acme/widgets-relabel/issues/46",
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
      expect(task.status).toBe("ready");
      expect(task.failureReason).toBeNull();

      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    // The `issue.state !== "closed"` guard added alongside the resurrection
    // check must ALSO cover this case: a "labeled" delivery on an issue
    // that's meanwhile closed must not spring a previously label-lost
    // `failed` task back to `ready`.
    it("does not resurrect a label-lost failed task when the 'labeled' delivery's issue is closed", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-relabel-closed");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-relabel-p2", cwd })
        .returning()
        .all();
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 47,
          title: "Stays dead",
          status: "failed",
          failureReason: "GitHub issue lost its tracking label",
          completedAt: new Date(),
        })
        .run();

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-relabel-closed", open_issues_count: 0 },
        issue: {
          number: 47,
          title: "Stays dead",
          body: null,
          html_url: "https://github.com/acme/widgets-relabel-closed/issues/47",
          state: "closed",
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
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 47)))
        .all();
      expect(task.status).toBe("failed");

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
        .mockResolvedValue({ state: "closed", labels: [] });

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-p4", cwd })
        .returning()
        .all();
      // #775 — a reviewing task always has a live worker session and
      // usually a review session too; assert both actually get killed by
      // this path, the exact gap a fresh-review finding caught pre-#772.
      const worker = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.id, command: "bash" },
      });
      const reviewer = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.id, command: "bash" },
      });
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 45,
          title: "Reviewing task",
          status: "reviewing",
          sessionId: worker.json().id,
          reviewSessionId: reviewer.json().id,
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
      const getRow = () =>
        app.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 45)))
          .all()[0];
      // The sync is fire-and-forget (see webhooks.ts's own comment) — wait
      // for it rather than asserting immediately.
      await waitUntil(() => getRow().status === "done");
      expect(getIssueStateSpy).toHaveBeenCalledWith("ghp_test_token", "acme", "widgets-close", 45);

      const { sessions } = await import("../../src/db/schema.js");
      await waitUntil(() => {
        const [w] = app.db.select().from(sessions).where(eq(sessions.id, worker.json().id)).all();
        const [r] = app.db.select().from(sessions).where(eq(sessions.id, reviewer.json().id)).all();
        return w.status === "killed" && r.status === "killed";
      });

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

    it("broadcasts a live /ws/tasks 'ingested' frame for a genuinely new task", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-live");
      const app = await buildApp();
      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-ingest-live", cwd })
        .returning()
        .all();

      clearTaskEventSubscribersForTests();
      const socket = fakeTaskEventSocket();
      subscribeToTaskEvents(socket);

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-live", open_issues_count: 1 },
        issue: {
          number: 50,
          title: "Live ingest",
          body: null,
          html_url: "https://github.com/acme/widgets-live/issues/50",
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
        .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 50)))
        .all();
      expect(socket.messages).toContainEqual(
        expect.objectContaining({ taskId: task.id, projectId: project.id, kind: "ingested" }),
      );

      clearTaskEventSubscribersForTests();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does not broadcast 'ingested' again for a re-sighting update of an already-tracked issue", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-resight");
      const app = await buildApp();
      app.db.insert(projects).values({ name: "webhook-ingest-resight", cwd }).returning().all();

      const firstPayload = issuesPayload({
        repository: { full_name: "acme/widgets-resight", open_issues_count: 1 },
        issue: {
          number: 51,
          title: "Original title",
          body: null,
          html_url: "https://github.com/acme/widgets-resight/issues/51",
          labels: [{ name: "mullion-task" }],
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(firstPayload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload: firstPayload,
      });

      clearTaskEventSubscribersForTests();
      const socket = fakeTaskEventSocket();
      subscribeToTaskEvents(socket);

      // A real change (retitled), still just a re-sighting update, not a
      // new task — no "ingested" event should fire a second time.
      const secondPayload = issuesPayload({
        repository: { full_name: "acme/widgets-resight", open_issues_count: 1 },
        issue: {
          number: 51,
          title: "Retitled",
          body: null,
          html_url: "https://github.com/acme/widgets-resight/issues/51",
          labels: [{ name: "mullion-task" }],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(secondPayload, TEST_SECRET),
          "x-github-event": "issues",
        },
        payload: secondPayload,
      });

      expect(res.statusCode).toBe(200);
      expect(socket.messages).toHaveLength(0);

      clearTaskEventSubscribersForTests();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("survives a DB throw during ingest and still returns 200 (hardening)", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-dbthrow");
      const app = await buildApp();
      app.db.insert(projects).values({ name: "webhook-ingest-dbthrow", cwd }).returning().all();

      const insertSpy = vi.spyOn(app.db, "insert").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });

      const payload = issuesPayload({
        repository: { full_name: "acme/widgets-dbthrow", open_issues_count: 1 },
        issue: {
          number: 52,
          title: "Should not 500",
          body: null,
          html_url: "https://github.com/acme/widgets-dbthrow/issues/52",
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

      insertSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    describe("unlabeled (#490a)", () => {
      it("fails a ready task when the removed label is the task label", async () => {
        const cwd = createMatchingGitRepo("acme", "widgets-unlabel");
        const app = await buildApp();
        await connectPat(app, "ghp_unlabel_token");
        const githubWrite = await import("../../src/services/github-write.js");
        const removeLabelSpy = vi.spyOn(githubWrite, "removeLabel").mockResolvedValue(undefined);
        const createCommentSpy = vi
          .spyOn(githubWrite, "createComment")
          .mockResolvedValue({ id: 1, htmlUrl: "" });

        const [project] = app.db
          .insert(projects)
          .values({ name: "webhook-unlabel-p1", cwd })
          .returning()
          .all();
        app.db
          .insert(tasks)
          .values({ projectId: project.id, issueNumber: 60, title: "Ready task", status: "ready" })
          .run();

        const payload = JSON.stringify({
          action: "unlabeled",
          repository: { full_name: "acme/widgets-unlabel", open_issues_count: 1 },
          label: { name: "mullion-task" },
          issue: {
            number: 60,
            title: "Ready task",
            body: null,
            html_url: "https://github.com/acme/widgets-unlabel/issues/60",
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
        const getRow = () =>
          app.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 60)))
            .all()[0];
        await waitUntil(() => getRow().status === "failed");
        expect(getRow().failureReason).toBe("GitHub issue lost its tracking label");

        removeLabelSpy.mockRestore();
        createCommentSpy.mockRestore();
        await app.close();
        fs.rmSync(cwd, { recursive: true, force: true });
      });

      it("leaves an in_progress task untouched — it has real work behind it", async () => {
        const cwd = createMatchingGitRepo("acme", "widgets-unlabel2");
        const app = await buildApp();
        await connectPat(app, "ghp_unlabel_token2");
        const githubWrite = await import("../../src/services/github-write.js");
        const createCommentSpy = vi.spyOn(githubWrite, "createComment");

        const [project] = app.db
          .insert(projects)
          .values({ name: "webhook-unlabel-p2", cwd })
          .returning()
          .all();
        app.db
          .insert(tasks)
          .values({
            projectId: project.id,
            issueNumber: 61,
            title: "In-flight task",
            status: "in_progress",
          })
          .run();

        const payload = JSON.stringify({
          action: "unlabeled",
          repository: { full_name: "acme/widgets-unlabel2", open_issues_count: 1 },
          label: { name: "mullion-task" },
          issue: {
            number: 61,
            title: "In-flight task",
            body: null,
            html_url: "https://github.com/acme/widgets-unlabel2/issues/61",
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
        // Asserting a negative (nothing changed) — the early-return path
        // for a non-backlog/ready status has no await before it, but a
        // few event-loop ticks still lets the fire-and-forget promise
        // settle deterministically rather than racing it.
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
        const [updated] = app.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 61)))
          .all();
        expect(updated.status).toBe("in_progress");
        expect(createCommentSpy).not.toHaveBeenCalled();

        createCommentSpy.mockRestore();
        await app.close();
        fs.rmSync(cwd, { recursive: true, force: true });
      });

      it("ignores an unlabeled event for a label that isn't the task label", async () => {
        const cwd = createMatchingGitRepo("acme", "widgets-unlabel3");
        const app = await buildApp();
        const [project] = app.db
          .insert(projects)
          .values({ name: "webhook-unlabel-p3", cwd })
          .returning()
          .all();
        app.db
          .insert(tasks)
          .values({ projectId: project.id, issueNumber: 62, title: "Ready task", status: "ready" })
          .run();

        const payload = JSON.stringify({
          action: "unlabeled",
          repository: { full_name: "acme/widgets-unlabel3", open_issues_count: 1 },
          label: { name: "bug" },
          issue: {
            number: 62,
            title: "Ready task",
            body: null,
            html_url: "https://github.com/acme/widgets-unlabel3/issues/62",
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
        const [updated] = app.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.projectId, project.id), eq(tasks.issueNumber, 62)))
          .all();
        expect(updated.status).toBe("ready");

        await app.close();
        fs.rmSync(cwd, { recursive: true, force: true });
      });
    });
  });

  describe("dependency-aware claiming (#667)", () => {
    beforeAll(() => {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    });

    afterAll(() => {
      delete process.env.MULLION_TASK_MASTER_ENABLED;
    });

    it("an issue_dependencies/blocked_by_added delivery refreshes the matching task's blockers", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-depedge");
      const app = await buildApp();
      await connectPat(app, "ghp_test_token");

      const githubWrite = await import("../../src/services/github-write.js");
      const listBlockedByIssuesSpy = vi
        .spyOn(githubWrite, "listBlockedByIssues")
        .mockResolvedValue([
          {
            owner: "acme",
            repo: "widgets-depedge",
            number: 71,
            title: "The new blocker",
            htmlUrl: "https://github.com/acme/widgets-depedge/issues/71",
            state: "open",
          },
        ]);

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-depedge-p", cwd })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 70,
          title: "Newly blocked task",
          status: "ready",
          dependencyCount: 0,
          blockedBy: null,
        })
        .returning()
        .all();

      const payload = JSON.stringify({
        action: "blocked_by_added",
        repository: { full_name: "acme/widgets-depedge", open_issues_count: 1 },
        blocked_issue: { number: 70 },
        blocking_issue: { number: 71 },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issue_dependencies",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const getRow = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
      // Fire-and-forget, same as the closed/unlabeled sync above.
      await waitUntil(() => getRow().blockedBy !== null);
      expect(listBlockedByIssuesSpy).toHaveBeenCalledWith(
        "ghp_test_token",
        "acme",
        "widgets-depedge",
        70,
      );
      const row = getRow();
      expect(JSON.parse(row.blockedBy!)).toMatchObject([{ number: 71 }]);
      // Regression guard for the dependencyCount-staleness fix
      // (task-dependencies.ts's refreshTaskBlockers doc comment) — without
      // it this would stay 0 (the value at insert time) and
      // dependencyGate would short-circuit to "clear" despite the real
      // blocker just stored above.
      expect(row.dependencyCount).toBe(1);

      listBlockedByIssuesSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    // Hermes review, PR #670 — this is exactly the direction where the
    // stored dependencyCount is stale in a way that used to trip the
    // defensive shortfall check: GitHub's own total_blocked_by summary can
    // still report the pre-removal count even on an immediate re-fetch
    // (verified live), so passing the raw stored count straight through
    // would manufacture a "1 blocker(s) not visible to this token" false
    // positive on the single-blocker case this test exercises. The route
    // decrements the known count by the one blocker this delivery itself
    // proves was just removed, instead.
    it("an issue_dependencies/blocked_by_removed delivery does not manufacture a false shortfall on the known removal", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-depedge-removed");
      const app = await buildApp();
      await connectPat(app, "ghp_test_token");

      const githubWrite = await import("../../src/services/github-write.js");
      // The task's only blocker was just removed — GitHub's list endpoint
      // already reflects that (empty), even though its own summary field
      // may not have caught up yet.
      const listBlockedByIssuesSpy = vi
        .spyOn(githubWrite, "listBlockedByIssues")
        .mockResolvedValue([]);

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-depedge-removed-p", cwd })
        .returning()
        .all();
      const [task] = app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 70,
          title: "Was blocked, edge just removed",
          status: "ready",
          dependencyCount: 1,
          blockedBy: JSON.stringify([
            {
              owner: "acme",
              repo: "widgets-depedge-removed",
              number: 71,
              title: "old blocker",
              htmlUrl: "https://x/71",
            },
          ]),
        })
        .returning()
        .all();

      const payload = JSON.stringify({
        action: "blocked_by_removed",
        repository: { full_name: "acme/widgets-depedge-removed", open_issues_count: 1 },
        blocked_issue: { number: 70 },
        blocking_issue: { number: 71 },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload, TEST_SECRET),
          "x-github-event": "issue_dependencies",
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const getRow = () => app.db.select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
      await waitUntil(() => getRow().blockedBy === "[]");
      const row = getRow();
      // No synthetic "not visible to this token" entry, and the re-check
      // TTL was stamped (a clean, non-shortfall result).
      expect(JSON.parse(row.blockedBy!)).toEqual([]);
      expect(row.dependencyCount).toBe(0);
      expect(row.blockedByCheckedAt).not.toBeNull();

      listBlockedByIssuesSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("an issues/closed delivery for an issue with dependents refreshes them via listBlockingIssues", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-blockerclose");
      const app = await buildApp();
      await connectPat(app, "ghp_test_token");

      const githubWrite = await import("../../src/services/github-write.js");
      const listBlockingIssuesSpy = vi.spyOn(githubWrite, "listBlockingIssues").mockResolvedValue([
        {
          owner: "acme",
          repo: "widgets-blockerclose",
          number: 90,
          title: "The dependent",
          htmlUrl: "https://github.com/acme/widgets-blockerclose/issues/90",
          state: "open",
        },
      ]);
      // The dependent's own blockers, resolved once the blocker-close push
      // refreshes it. GitHub's blocked_by list still includes #80 itself
      // — closing an issue doesn't remove the dependency edge, only flips
      // its `state` — so this returns it as `closed`, not an empty array;
      // that's what makes the dependent's own blockedBy resolve to "[]".
      const listBlockedByIssuesSpy = vi
        .spyOn(githubWrite, "listBlockedByIssues")
        .mockResolvedValue([
          {
            owner: "acme",
            repo: "widgets-blockerclose",
            number: 80,
            title: "The blocker",
            htmlUrl: "https://github.com/acme/widgets-blockerclose/issues/80",
            state: "closed",
          },
        ]);

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-blockerclose-p", cwd })
        .returning()
        .all();
      const [dependent] = app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 90,
          title: "Dependent task",
          status: "ready",
          dependencyCount: 1,
          blockedBy: JSON.stringify([
            {
              owner: "acme",
              repo: "widgets-blockerclose",
              number: 80,
              title: "old",
              htmlUrl: null,
            },
          ]),
        })
        .returning()
        .all();

      const payload = JSON.stringify({
        action: "closed",
        repository: { full_name: "acme/widgets-blockerclose", open_issues_count: 0 },
        issue: {
          number: 80,
          title: "The blocker",
          body: null,
          html_url: "https://github.com/acme/widgets-blockerclose/issues/80",
          labels: [],
          issue_dependencies_summary: { blocking: 1 },
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
      const getRow = () => app.db.select().from(tasks).where(eq(tasks.id, dependent.id)).all()[0];
      await waitUntil(() => getRow().blockedBy === "[]");
      expect(listBlockingIssuesSpy).toHaveBeenCalledWith(
        "ghp_test_token",
        "acme",
        "widgets-blockerclose",
        80,
      );
      expect(listBlockedByIssuesSpy).toHaveBeenCalledWith(
        "ghp_test_token",
        "acme",
        "widgets-blockerclose",
        90,
      );

      listBlockingIssuesSpy.mockRestore();
      listBlockedByIssuesSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("a zero-dependents issues/closed delivery makes no listBlockingIssues call", async () => {
      const cwd = createMatchingGitRepo("acme", "widgets-noclose-deps");
      const app = await buildApp();
      await connectPat(app, "ghp_test_token");

      const githubWrite = await import("../../src/services/github-write.js");
      const listBlockingIssuesSpy = vi.spyOn(githubWrite, "listBlockingIssues");

      const [project] = app.db
        .insert(projects)
        .values({ name: "webhook-noclose-deps-p", cwd })
        .returning()
        .all();
      app.db
        .insert(tasks)
        .values({
          projectId: project.id,
          issueNumber: 95,
          title: "No dependents",
          status: "reviewing",
        })
        .run();

      const payload = JSON.stringify({
        action: "closed",
        repository: { full_name: "acme/widgets-noclose-deps", open_issues_count: 0 },
        issue: {
          number: 95,
          title: "No dependents",
          body: null,
          html_url: "https://github.com/acme/widgets-noclose-deps/issues/95",
          labels: [],
          issue_dependencies_summary: { blocking: 0 },
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
      // Give the fire-and-forget close-sync path a tick to have run, same
      // as every other test in this file that can't assert "instantly".
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(listBlockingIssuesSpy).not.toHaveBeenCalled();

      listBlockingIssuesSpy.mockRestore();
      await app.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });
});
