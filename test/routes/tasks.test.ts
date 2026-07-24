import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { tasks } from "../../src/db/schema.js";

const tmpDb = path.join(os.tmpdir(), `tasks-route-test-${process.pid}.db`);

describe("tasks route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns [] when no tasks exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("lists tasks joined with their project name", async () => {
    const app = await buildApp();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "demo", cwd: "/tmp/demo" },
    });
    const projectId = project.json().id;

    app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 7,
        title: "Add feature",
        body: "some body",
        htmlUrl: "https://github.com/o/r/issues/7",
      })
      .run();

    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      projectId,
      projectName: "demo",
      issueNumber: 7,
      title: "Add feature",
      body: "some body",
      htmlUrl: "https://github.com/o/r/issues/7",
      status: "pending",
      sessionId: null,
    });

    await app.close();
  });
});
