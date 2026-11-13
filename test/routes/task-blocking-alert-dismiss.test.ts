import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { buildTestApp } from "../helpers/app.js";
import { createTaskGitRepo, createTaskProject, git } from "../helpers/task-retry-fixture.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";

// #2999 — POST /api/tasks/:id/blocking-alerts/:alertNumber/dismiss, through
// the real route with `fetch` mocked at the GitHub boundary.

vi.mock("node-pty", () => plainNodePtyMock());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { closeDb } = await import("../../src/db/client.js");
const { tasks, integrations, codeScanningDismissals } = await import("../../src/db/schema.js");
const { resetCodeScanningCache } = await import("../../src/services/code-scanning.js");

const tmpDb = path.join(os.tmpdir(), `task-alert-dismiss-test-${process.pid}.db`);
type App = Awaited<ReturnType<typeof buildTestApp>>;

const alertUrl = (n: number) => `https://github.com/o/r/security/code-scanning/${n}`;
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function alertJson(n: number, state = "open") {
  return {
    number: n,
    state,
    html_url: alertUrl(n),
    rule: { id: "js/path-injection", description: "d", severity: "error" },
    most_recent_instance: {
      commit_sha: "abc",
      location: { path: "src/routes/fs.ts", start_line: 10, end_line: 10 },
    },
  };
}

function thread(id: string, alertNumber: number, over: Record<string, unknown> = {}) {
  return {
    id,
    isResolved: false,
    comments: {
      totalCount: 1,
      nodes: [
        {
          author: { login: "github-advanced-security" },
          createdAt: "2026-01-01T00:00:00Z",
          path: "src/routes/fs.ts",
          line: 10,
          body: `Path injection\n${alertUrl(alertNumber)}`,
          url: null,
          pullRequestReview: null,
        },
      ],
    },
    ...over,
  };
}

describe("POST /api/tasks/:id/blocking-alerts/:alertNumber/dismiss", () => {
  let app: App;
  let projectId: number;
  const calls: { url: string; method: string; auth: string; body: string }[] = [];
  let threads: unknown[];
  let alertState: string;
  let patchStatus: number;
  let replyFails: boolean;
  let resolveFails: boolean;

  function addTask(over: Record<string, unknown> = {}) {
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "done",
        prNumber: 5,
        needsHumanReason: "blocked-threads",
        mergeError: "Blocked on 1 unresolved review conversation",
        mergeBlockedThreads: JSON.stringify({
          total: 1,
          threads: [{ author: "x", alert: { number: 7, url: null } }],
        }),
        ...over,
      } as typeof tasks.$inferInsert)
      .returning()
      .all();
    return row.id;
  }

  const dismiss = (id: number, alert: number | string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/tasks/${id}/blocking-alerts/${alert}/dismiss`,
      payload: body,
    });
  const ok = { reason: "false positive", comment: "  Validated upstream.  " };
  const patches = () => calls.filter((c) => c.method === "PATCH");

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  beforeEach(async () => {
    app = await buildTestApp();
    const cwd = createTaskGitRepo("alert-dismiss-repo-");
    git(cwd, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    projectId = await createTaskProject(app, cwd, `alert-dismiss-p-${Math.random()}`);
    calls.length = 0;
    app.db.delete(codeScanningDismissals).run();
    resetCodeScanningCache();
    app.db.delete(integrations).run();
    app.db
      .insert(integrations)
      .values({
        provider: "github",
        authTokenEnc: app.encryption.encryptString("human-token"),
        tokenType: "oauth",
        login: "me",
        scopes: "repo",
        connectedAt: new Date(),
      })
      .run();
    threads = [thread("T7", 7), thread("T8", 8)];
    alertState = "open";
    patchStatus = 200;
    replyFails = false;
    resolveFails = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        const body = typeof init?.body === "string" ? init.body : "";
        const method = init?.method ?? "GET";
        calls.push({ url, method, auth: headers?.Authorization ?? "", body });
        if (url.endsWith("/graphql")) {
          if (body.includes("addPullRequestReviewThreadReply")) {
            return replyFails
              ? res(200, { errors: [{ message: "boom" }] })
              : res(200, {
                  data: {
                    addPullRequestReviewThreadReply: {
                      comment: { author: null, bodyHTML: "", createdAt: "", url: "" },
                    },
                  },
                });
          }
          if (body.includes("mutation") && body.includes("resolveReviewThread")) {
            return resolveFails
              ? res(200, { errors: [{ message: "boom" }] })
              : res(200, { data: { resolveReviewThread: { thread: { id: "T7" } } } });
          }
          return res(200, {
            data: {
              viewer: { login: "me" },
              repository: {
                pullRequest: { reviewThreads: { totalCount: threads.length, nodes: threads } },
              },
            },
          });
        }
        const m = /\/code-scanning\/alerts\/(\d+)$/.exec(url);
        if (m && method === "GET") return res(200, alertJson(Number(m[1]), alertState));
        if (m && method === "PATCH") return res(patchStatus, {});
        return res(404, {});
      }),
    );
  });

  it("dismisses only the named alert, replies, resolves, audits and reopens the merge", async () => {
    const id = addTask();
    const r = await dismiss(id, 7, ok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      dismissed: true,
      threadResolved: true,
      dismissal: { alertNumber: 7, reason: "false positive", dismissedBy: "me" },
    });
    // One PATCH, on #7 only, with the human token and the trimmed comment.
    expect(patches()).toHaveLength(1);
    expect(patches()[0].url).toMatch(/\/code-scanning\/alerts\/7$/);
    expect(patches()[0].auth).toBe("Bearer human-token");
    expect(JSON.parse(patches()[0].body)).toEqual({
      state: "dismissed",
      dismissed_reason: "false positive",
      dismissed_comment: "Validated upstream.",
    });
    expect(calls.every((c) => c.auth === "Bearer human-token")).toBe(true);
    const reply = calls.find((c) => c.body.includes("addPullRequestReviewThreadReply"))!;
    expect(JSON.parse(reply.body).variables).toEqual({
      id: "T7",
      body: "Dismissed code-scanning alert #7 as false positive: Validated upstream.",
    });

    const row = app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    expect(row.mergeRequestedAt).toBeInstanceOf(Date);
    expect(row.needsHumanReason).toBeNull();
    expect(row.mergeError).toBeNull();
    const audit = app.db.select().from(codeScanningDismissals).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      taskId: id,
      repo: "o/r",
      prNumber: 5,
      alertNumber: 7,
      ruleId: "js/path-injection",
      path: "src/routes/fs.ts",
      reason: "false positive",
      comment: "Validated upstream.",
      dismissedBy: "me",
      threadResolved: true,
    });

    // The audit line survives a reload, and is prior art for the same rule.
    const get = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(get.statusCode).toBe(200);
    expect(get.json().dismissals).toHaveLength(1);
    expect(get.json().dismissals[0]).toMatchObject({ alertNumber: 7, dismissedBy: "me" });
  });

  it("409s alert-not-blocking for a same-rule alert that is not in a foreign open thread", async () => {
    const id = addTask();
    const r = await dismiss(id, 9, ok);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("alert-not-blocking");
    expect(patches()).toHaveLength(0);
    expect(app.db.select().from(codeScanningDismissals).all()).toHaveLength(0);
  });

  it("409s when the alert's thread is already resolved or only Mullion's own", async () => {
    threads = [thread("T7", 7, { isResolved: true })];
    const id = addTask();
    expect((await dismiss(id, 7, ok)).statusCode).toBe(409);
    threads = [
      thread("T7", 7, {
        comments: {
          totalCount: 1,
          nodes: [
            {
              author: { login: "me" },
              createdAt: "",
              path: null,
              line: null,
              body: alertUrl(7),
              url: null,
              pullRequestReview: null,
            },
          ],
        },
      }),
    ];
    expect((await dismiss(id, 7, ok)).statusCode).toBe(409);
    expect(patches()).toHaveLength(0);
  });

  it("409s without a PATCH when the alert itself is no longer open", async () => {
    alertState = "dismissed";
    const id = addTask();
    const r = await dismiss(id, 7, ok);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("alert-not-blocking");
    expect(patches()).toHaveLength(0);
  });

  it("maps a PATCH 403 to the permission message and records nothing", async () => {
    patchStatus = 403;
    const id = addTask();
    const r = await dismiss(id, 7, ok);
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/lacks write access/);
    expect(app.db.select().from(codeScanningDismissals).all()).toHaveLength(0);
    const row = app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    expect(row.needsHumanReason).toBe("blocked-threads");
    expect(row.mergeRequestedAt).toBeNull();
  });

  it.each([
    ["reply", () => (replyFails = true)],
    ["resolve", () => (resolveFails = true)],
  ])("a failed thread %s still audits with threadResolved false", async (_n, fail) => {
    fail();
    const id = addTask();
    const r = await dismiss(id, 7, ok);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ dismissed: true, threadResolved: false });
    expect(r.json().warning).toMatch(/resolve it on GitHub/);
    const audit = app.db.select().from(codeScanningDismissals).all();
    expect(audit).toHaveLength(1);
    expect(audit[0].threadResolved).toBe(false);
    const row = app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
    expect(row.mergeRequestedAt).toBeInstanceOf(Date);
    // A failed reply must not resolve the thread silently.
    if (replyFails) {
      expect(
        calls.some((c) => c.body.includes("mutation") && c.body.includes("resolveReviewThread")),
      ).toBe(false);
    }
  });

  it("validates the body: empty, over-long, bad reason, missing", async () => {
    const id = addTask();
    expect((await dismiss(id, 7, { reason: "false positive", comment: "   " })).statusCode).toBe(
      400,
    );
    expect(
      (await dismiss(id, 7, { reason: "false positive", comment: "x".repeat(281) })).statusCode,
    ).toBe(400);
    expect(
      (await dismiss(id, 7, { reason: "false positive", comment: "x".repeat(280) })).statusCode,
    ).toBe(200);
    expect((await dismiss(id, 7, { reason: "nope", comment: "c" })).statusCode).toBe(400);
    expect((await dismiss(id, 7, { reason: "won't fix" })).statusCode).toBe(400);
    expect((await dismiss(id, "abc", ok)).statusCode).toBe(400);
  });

  it("refuses unless the task is done, has a PR, and is blocked-threads", async () => {
    expect((await dismiss(addTask({ status: "reviewing" }), 7, ok)).statusCode).toBe(409);
    expect((await dismiss(addTask({ prNumber: null }), 7, ok)).statusCode).toBe(409);
    expect((await dismiss(addTask({ needsHumanReason: null }), 7, ok)).statusCode).toBe(409);
    expect((await dismiss(99999, 7, ok)).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses with no human account connected (no App fallback) and when Task Master is off", async () => {
    const id = addTask();
    app.db.delete(integrations).run();
    expect((await dismiss(id, 7, ok)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    process.env.MULLION_TASK_MASTER_ENABLED = "false";
    try {
      expect((await dismiss(id, 7, ok)).statusCode).toBe(403);
    } finally {
      process.env.MULLION_TASK_MASTER_ENABLED = "true";
    }
  });

  it("is human-only: no op, MCP tool or CLI command references blocking-alerts", () => {
    const roots = ["src/plugins/control-socket-ops.ts", "src/mcp", "src/cli"];
    const files: string[] = [];
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((f) => walk(path.join(p, f)));
      else files.push(p);
    };
    roots.forEach((r) => walk(path.resolve(r)));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/blocking-alerts|blockingAlerts/);
    }
  });
});
