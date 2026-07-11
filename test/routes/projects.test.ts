import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `projects-test-${process.pid}.db`);

describe("projects route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates and lists projects", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "home", cwd: "/home/bjoern" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "home", cwd: "/home/bjoern" });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    await app.close();
  });

  it("rejects a project missing cwd", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "no-cwd" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s deleting an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("deletes a project with no sessions", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "throwaway", cwd: "/tmp" },
    });
    const { id } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(deleted.statusCode).toBe(204);

    await app.close();
  });
});
