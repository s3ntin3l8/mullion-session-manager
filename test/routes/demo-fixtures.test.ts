import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

// MULLION_DEMO registers the demo-only fixture routes; without it they must
// not exist at all (src/routes/demo-fixtures.ts).

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "demo-fixtures-"));
});
afterEach(() => {
  delete process.env.MULLION_DEMO;
  rmSync(cwd, { recursive: true, force: true });
});

async function project(app: Awaited<ReturnType<typeof buildApp>>): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "demo-fixture-project", cwd },
  });
  return res.json().id;
}

describe("demo fixture routes", () => {
  it("do not exist without MULLION_DEMO", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/demo/fixtures/tasks",
      payload: { projectId: 1, tasks: [{ title: "x", status: "failed" }] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("insert tasks in states the REST API refuses, with timestamps as dates", async () => {
    process.env.MULLION_DEMO = "true";
    const app = await buildApp();
    const projectId = await project(app);
    const startedAt = "2026-01-02T03:04:05.000Z";

    const res = await app.inject({
      method: "POST",
      url: "/api/demo/fixtures/tasks",
      payload: {
        projectId,
        tasks: [
          { title: "Running", status: "in_progress", issueNumber: 10, prNumber: 12, startedAt },
          {
            title: "Awaiting approval",
            status: "reviewing",
            prNumber: 14,
            lastReviewVerdict: "approved",
            reviewRunId: "r1",
            reviewRunIngestedId: "r1",
          },
          { title: "Failed", status: "failed", failureReason: "out of budget" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tasks).toHaveLength(3);

    // Through the real board route, so derived fields come out too.
    const board = (await app.inject({ method: "GET", url: "/api/tasks" })).json();
    const byTitle = Object.fromEntries(board.map((t: { title: string }) => [t.title, t]));
    expect(byTitle["Running"]).toMatchObject({ status: "in_progress", prNumber: 12 });
    expect(new Date(byTitle["Running"].startedAt).toISOString()).toBe(startedAt);
    expect(byTitle["Failed"]).toMatchObject({ status: "failed", failureReason: "out of budget" });
    expect(byTitle["Awaiting approval"].approvalState).toBe("awaiting-human");
    await app.close();
  });

  it("rejects a malformed timestamp and a bad needsHumanReason", async () => {
    process.env.MULLION_DEMO = "true";
    const app = await buildApp();
    const projectId = await project(app);
    const post = (task: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/demo/fixtures/tasks",
        payload: { projectId, tasks: [{ title: "x", status: "ready", ...task }] },
      });
    expect((await post({ startedAt: "not-a-date" })).statusCode).toBe(400);
    expect((await post({ needsHumanReason: "typo" })).statusCode).toBe(400);
    expect((await post({ startedAt: "2026-01-02T03:04:05Z" })).statusCode).toBe(201);
    await app.close();
  });

  it("is all or nothing: a duplicate issue number rolls the whole batch back", async () => {
    process.env.MULLION_DEMO = "true";
    const app = await buildApp();
    const projectId = await project(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/demo/fixtures/tasks",
      payload: {
        projectId,
        tasks: [
          { title: "first", status: "ready", issueNumber: 5 },
          { title: "dup", status: "ready", issueNumber: 5 },
        ],
      },
    });
    expect(res.statusCode).toBe(500);
    const after = (await app.inject({ method: "GET", url: "/api/tasks" })).json();
    expect(after.map((t: { title: string }) => t.title)).not.toContain("first");
    await app.close();
  });

  it("rejects an unknown project and status, and drops a column outside the allow-list", async () => {
    process.env.MULLION_DEMO = "true";
    const app = await buildApp();
    const projectId = await project(app);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/demo/fixtures/tasks", payload });

    expect(
      (await post({ projectId: 9999, tasks: [{ title: "x", status: "ready" }] })).statusCode,
    ).toBe(404);
    expect((await post({ projectId, tasks: [{ title: "x", status: "bogus" }] })).statusCode).toBe(
      400,
    );
    // Fastify's ajv strips unknown properties rather than failing, so a column
    // outside the allow-list is dropped, never written.
    const dropped = await post({
      projectId,
      tasks: [{ title: "x", status: "ready", sessionId: 1 }],
    });
    expect(dropped.statusCode).toBe(201);
    expect(dropped.json().tasks[0].sessionId).toBeNull();
    await app.close();
  });
});
