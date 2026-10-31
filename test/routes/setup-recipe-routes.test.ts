import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sessions } from "../../src/db/schema.js";

// Issue #2245 — the primary-side surface: the project PATCH field and the
// session setup-log read.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `setup-recipe-routes-${process.pid}.db`);

describe("setup recipe routes", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("PATCH /api/projects/:id stores, returns, caps and clears setupRecipe", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "recipe-p", cwd: "/tmp" },
    });
    const id = created.json().id as number;
    expect(created.json().setupRecipe ?? null).toBeNull();

    const set = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { setupRecipe: "  npm ci  " },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().setupRecipe).toBe("npm ci");

    const tooLong = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { setupRecipe: "x".repeat(4097) },
    });
    expect(tooLong.statusCode).toBe(400);

    const blank = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { setupRecipe: "   " },
    });
    expect(blank.json().setupRecipe).toBeNull();

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { setupRecipe: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().setupRecipe).toBeNull();
    await app.close();
  });

  it("GET /api/sessions/:id/setup-log serves the log, 404s without one", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "recipe-log", cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    const [row] = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", setupStatus: "failed" })
      .returning()
      .all();
    expect(
      (await app.inject({ method: "GET", url: `/api/sessions/${row.id}/setup-log` })).statusCode,
    ).toBe(404);
    fs.writeFileSync(path.join(app.config.SESSIONS_DIR, `${row.id}.setup.log`), "npm ERR! boom");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${row.id}/setup-log` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: "npm ERR! boom", truncated: false });
    expect(
      (await app.inject({ method: "GET", url: "/api/sessions/abc/setup-log" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/sessions/99999/setup-log" })).statusCode,
    ).toBe(404);
    await app.close();
  });
});
