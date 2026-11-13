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

// #2998 — GET /api/tasks/:id/blocking-alerts, through the real route with
// `fetch` mocked at the GitHub boundary. Own file: tasks.test.ts is at its
// size ceiling.

vi.mock("node-pty", () => plainNodePtyMock());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { closeDb } = await import("../../src/db/client.js");
const { tasks, integrations } = await import("../../src/db/schema.js");
const { resetCodeScanningCache } = await import("../../src/services/code-scanning.js");

const tmpDb = path.join(os.tmpdir(), `tasks-blocking-alerts-test-${process.pid}.db`);

type App = Awaited<ReturnType<typeof buildTestApp>>;

function alertJson(n: number, over: Record<string, unknown> = {}) {
  return {
    number: n,
    state: "open",
    html_url: `https://github.com/o/r/security/code-scanning/${n}`,
    rule: {
      id: "js/path-injection",
      description: "Uncontrolled data used in path expression",
      severity: "error",
      security_severity_level: "high",
      tags: ["x"],
    },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      commit_sha: "abc123",
      message: { text: "This path depends on a user-provided value." },
      location: { path: "src/routes/fs.ts", start_line: 10, end_line: 11 },
    },
    ...over,
  };
}

function dismissed(n: number, rule: string, p: string, login = "s3ntin3l8") {
  return alertJson(n, {
    state: "dismissed",
    rule: { id: rule },
    dismissed_by: { login },
    dismissed_reason: "false positive",
    dismissed_comment: `c${n}`,
    most_recent_instance: { location: { path: p, start_line: 1, end_line: 1 } },
  });
}

const FILE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe("GET /api/tasks/:id/blocking-alerts", () => {
  let app: App;
  let projectId: number;
  const calls: { url: string; method: string; auth: string }[] = [];
  let handler: (url: string) => Response;

  function addTask(over: Record<string, unknown> = {}) {
    const threads = [{ author: "github-advanced-security[bot]", alert: { number: 7, url: null } }];
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        title: "t",
        status: "done",
        needsHumanReason: "blocked-threads",
        mergeBlockedThreads: JSON.stringify({ total: 1, threads }),
        ...over,
      } as typeof tasks.$inferInsert)
      .returning()
      .all();
    return row.id;
  }

  function connect(scopes: string | null, tokenType: "pat" | "oauth" = "oauth") {
    app.db.delete(integrations).run();
    app.db
      .insert(integrations)
      .values({
        provider: "github",
        authTokenEnc: app.encryption.encryptString("human-token"),
        tokenType,
        login: "me",
        scopes,
        connectedAt: new Date(),
      })
      .run();
  }

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    app = await buildTestApp();
    const cwd = createTaskGitRepo("blocking-alerts-repo-");
    git(cwd, ["remote", "add", "origin", "https://github.com/o/r.git"]);
    projectId = await createTaskProject(app, cwd, `blocking-alerts-p-${Math.random()}`);
    calls.length = 0;
    resetCodeScanningCache();
    connect("repo");
    handler = (url) => {
      if (url.includes("/code-scanning/alerts/7")) return res(200, alertJson(7));
      if (url.includes("/code-scanning/alerts?")) {
        return res(200, [
          dismissed(1, "js/path-injection", "src/other.ts"),
          dismissed(2, "js/other-rule", "src/routes/fs.ts"),
          dismissed(3, "js/path-injection", "src/routes/fs.ts"),
        ]);
      }
      if (url.includes("/contents/src/routes/fs.ts")) {
        return res(200, {
          type: "file",
          encoding: "base64",
          content: Buffer.from(FILE).toString("base64"),
        });
      }
      return res(404, {});
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({ url, method: init?.method ?? "GET", auth: headers?.Authorization ?? "" });
        return handler(url);
      }),
    );
  });

  it("returns trimmed alert, sliced snippet, ordered priors and canDismiss ok", async () => {
    const id = addTask();
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(r.statusCode).toBe(200);
    const [e] = r.json().alerts;
    expect(e.alert).toEqual({
      rule: {
        id: "js/path-injection",
        description: "Uncontrolled data used in path expression",
        severity: "error",
        securitySeverity: "high",
      },
      location: { path: "src/routes/fs.ts", startLine: 10, endLine: 11 },
      message: "This path depends on a user-provided value.",
      commitSha: "abc123",
      state: "open",
      htmlUrl: "https://github.com/o/r/security/code-scanning/7",
    });
    // 3 lines of context each side of 10-11.
    expect(e.snippet.map((l: { number: number }) => l.number)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(
      e.snippet
        .filter((l: { flagged: boolean }) => l.flagged)
        .map((l: { number: number }) => l.number),
    ).toEqual([10, 11]);
    expect(e.snippet[3].text).toBe("line 10");
    // Same rule only; same path first.
    expect(e.priorDismissals.dismissals.map((d: { number: number }) => d.number)).toEqual([3, 1]);
    expect(e.priorDismissals.dismissals[0]).toEqual({
      number: 3,
      path: "src/routes/fs.ts",
      reason: "false positive",
      comment: "c3",
      dismissedBy: "s3ntin3l8",
      url: "https://github.com/o/r/security/code-scanning/3",
    });
    expect(e.canDismiss).toEqual({ ok: true });
    // Snippet is read at the alert's commit; read-only, human token only.
    expect(calls.some((c) => c.url.includes("ref=abc123"))).toBe(true);
    expect(calls.every((c) => c.method === "GET" && c.auth === "Bearer human-token")).toBe(true);
  });

  it("caps priors at 5 and counts the rest; caps the snippet at 30 lines", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      dismissed(100 + i, "js/path-injection", "src/a.ts"),
    );
    handler = ((prev) => (url: string) =>
      url.includes("/code-scanning/alerts?")
        ? res(200, many)
        : url.includes("/alerts/7")
          ? res(
              200,
              alertJson(7, {
                most_recent_instance: {
                  commit_sha: "abc123",
                  location: { path: "src/routes/fs.ts", start_line: 2, end_line: 38 },
                },
              }),
            )
          : prev(url))(handler);
    const id = addTask();
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    const [e] = r.json().alerts;
    expect(e.priorDismissals.dismissals).toHaveLength(5);
    expect(e.priorDismissals.otherPathCount).toBe(3);
    expect(e.snippet).toHaveLength(30);
  });

  it("404s a task that is not blocked-threads, or has no alert number", async () => {
    const a = addTask({ needsHumanReason: "rebase-exhausted" });
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${a}/blocking-alerts` })).statusCode,
    ).toBe(404);
    const b = addTask({
      mergeBlockedThreads: JSON.stringify({
        total: 1,
        threads: [{ author: "someone", alert: null }],
      }),
    });
    expect(
      (await app.inject({ method: "GET", url: `/api/tasks/${b}/blocking-alerts` })).statusCode,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("only fetches alert numbers stored on the task", async () => {
    const id = addTask();
    await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts?n=99` });
    expect(calls.some((c) => /alerts\/99/.test(c.url))).toBe(false);
    expect(calls.some((c) => /alerts\/7\b/.test(c.url))).toBe(true);
  });

  it("degrades only the failing entry", async () => {
    const id = addTask({
      mergeBlockedThreads: JSON.stringify({
        total: 2,
        threads: [
          { author: "github-advanced-security[bot]", alert: { number: 7, url: null } },
          { author: "github-advanced-security[bot]", alert: { number: 8, url: null } },
        ],
      }),
    });
    const prev = handler;
    handler = (url) => (url.includes("/alerts/8") ? res(500, {}) : prev(url));
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(r.statusCode).toBe(200);
    const [a, b] = r.json().alerts;
    expect(a.alert.rule.id).toBe("js/path-injection");
    expect(b.number).toBe(8);
    expect(b.error).toBeTruthy();
    expect(b.alert).toBeUndefined();
  });

  it("canDismiss: no account token", async () => {
    app.db.delete(integrations).run();
    const id = addTask();
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(r.json().alerts[0].canDismiss).toEqual({
      ok: false,
      reason: "Connect a GitHub account in Settings to dismiss alerts.",
    });
    expect(calls).toHaveLength(0);
  });

  it("canDismiss: classic scopes lacking repo/security_events", async () => {
    connect("read:user,gist");
    const id = addTask();
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    const c = r.json().alerts[0].canDismiss;
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("security_events");
  });

  it("canDismiss: security_events alone is enough; empty scopes (fine-grained PAT) is unknown → ok", async () => {
    connect("security_events");
    const id = addTask();
    let r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(r.json().alerts[0].canDismiss).toEqual({ ok: true });
    connect(null, "pat");
    r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    expect(r.json().alerts[0].canDismiss).toEqual({ ok: true });
  });

  it("canDismiss: the alert GET being forbidden", async () => {
    const id = addTask();
    handler = () => res(403, { message: "Resource not accessible" });
    const r = await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    const [e] = r.json().alerts;
    expect(e.error).toBeTruthy();
    expect(e.canDismiss).toEqual({
      ok: false,
      reason:
        "The connected token can't read code scanning alerts (needs Code scanning alerts: read and write).",
    });
  });

  it("leaves the row untouched", async () => {
    const id = addTask();
    await app.inject({ method: "GET", url: `/api/tasks/${id}/blocking-alerts` });
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, id)).all();
    expect(row.needsHumanReason).toBe("blocked-threads");
  });
});
