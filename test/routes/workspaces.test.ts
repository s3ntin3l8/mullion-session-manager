import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { DEFAULT_WORKSPACE_NAME } from "../../src/routes/workspaces.js";

// Workspaces are pure view metadata (a saved dockview layout) — no
// node-pty/dtach bootstrap involved, so unlike sessions.test.ts this file
// needs no child_process mocking.
const tmpDb = path.join(os.tmpdir(), `workspaces-test-${process.pid}.db`);

describe("workspaces route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates a workspace with a null layout and lists it", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Default" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Default", layout: null });

    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ name: "Default", layout: null })]);

    await app.close();
  });

  it("rejects a workspace missing name", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/workspaces", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("round-trips an opaque layout object through PATCH and GET", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "w" },
    });
    const { id } = created.json();

    const layout = {
      grid: { root: { type: "leaf", data: { views: ["session-1"] } } },
      panels: { "session-1": { id: "session-1", params: { sessionId: 1 } } },
    };
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${id}`,
      payload: { layout },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().layout).toEqual(layout);

    // Rows accumulate across tests in this file (shared DB, no per-test
    // scoping) — assert on this workspace's own row, not the full list.
    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    const row = (listed.json() as Array<{ id: number }>).find((w) => w.id === id);
    expect(row).toEqual(expect.objectContaining({ id, layout }));

    await app.close();
  });

  it("renames a workspace without touching its layout", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "w" },
    });
    const { id } = created.json();
    const layout = { grid: {}, panels: {} };
    await app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, payload: { layout } });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${id}`,
      payload: { name: "renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "renamed", layout });

    await app.close();
  });

  it("assigns and unassigns a group via PATCH groupId (WS-4)", async () => {
    const app = await buildApp();
    const group = await app.inject({ method: "POST", url: "/api/groups", payload: { name: "g" } });
    const groupId = group.json().id;

    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "w" },
    });
    const { id } = created.json();

    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${id}`,
      payload: { groupId, position: 2 },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ groupId, position: 2 });

    const unassigned = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${id}`,
      payload: { groupId: null },
    });
    expect(unassigned.json().groupId).toBeNull();

    await app.close();
  });

  it("404s patching an unknown workspace", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/workspaces/999999",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a PATCH with no recognized fields", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "w" },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("404s deleting an unknown workspace", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/workspaces/999999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("hard-deletes a workspace", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "throwaway" },
    });
    const { id } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/workspaces/${id}` });
    expect(deleted.statusCode).toBe(204);

    // Same accumulation caveat as above — confirm this row specifically is
    // gone rather than asserting the whole list is empty.
    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect((listed.json() as Array<{ id: number }>).find((w) => w.id === id)).toBeUndefined();

    await app.close();
  });
});

// Issue #1618 — GET /api/workspaces seeds a "Default" workspace when the table
// is empty. Each test gets its own brand-new database (the describe above
// shares one and lets rows accumulate, which would mask the empty-table case).
describe("workspaces route — default workspace bootstrap", () => {
  let freshDb: string;
  let counter = 0;

  beforeEach(() => {
    closeDb();
    freshDb = path.join(os.tmpdir(), `workspaces-default-test-${process.pid}-${counter++}.db`);
    fs.rmSync(freshDb, { force: true });
    process.env.DATABASE_URL = `file:${freshDb}`;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(freshDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("lists exactly one Default workspace on a fresh database", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ name: DEFAULT_WORKSPACE_NAME, layout: null }),
    ]);

    // Idempotent: a second GET returns the same row, not a second one.
    const again = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(again.json()).toEqual(res.json());
    await app.close();
  });

  it("still seeds only one Default under parallel GETs", async () => {
    const app = await buildApp();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => app.inject({ method: "GET", url: "/api/workspaces" })),
    );
    for (const res of responses) expect(res.statusCode).toBe(200);
    const ids = new Set(
      responses.flatMap((res) => (res.json() as Array<{ id: number }>).map((w) => w.id)),
    );
    expect(ids.size).toBe(1);

    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.json()).toHaveLength(1);
    await app.close();
  });

  it("does not seed when workspaces already exist", async () => {
    const app = await buildApp();
    await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Mine" } });
    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.json()).toEqual([expect.objectContaining({ name: "Mine" })]);
    await app.close();
  });

  it("recreates a Default after every workspace has been deleted", async () => {
    const app = await buildApp();
    const first = await app.inject({ method: "GET", url: "/api/workspaces" });
    const [{ id }] = first.json() as Array<{ id: number }>;

    const deleted = await app.inject({ method: "DELETE", url: `/api/workspaces/${id}` });
    expect(deleted.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    const rows = listed.json() as Array<{ id: number; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: DEFAULT_WORKSPACE_NAME, layout: null });
    expect(rows[0].id).not.toBe(id);
    await app.close();
  });
});
