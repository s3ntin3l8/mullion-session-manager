import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { eq } from "drizzle-orm";
import { DEFAULT_WORKSPACE_NAME } from "../../src/routes/workspaces.js";
import { workspacePinnedProjects } from "../../src/db/schema.js";

// Workspaces are pure view metadata (a saved dockview layout) — no
// node-pty/dtach bootstrap involved, so unlike test/helpers/sessions-routes.ts this file
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

  // A smoke test, not a race proof: in one process the handler's synchronous
  // better-sqlite3 calls can't interleave anyway. The cross-connection
  // guarantee comes from the `immediate` transaction and isn't exercised here.
  it("returns the same single Default to a burst of parallel GETs (smoke test)", async () => {
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

  it("reads without the write lock when rows exist, and seeds under an immediate transaction", async () => {
    const app = await buildApp();
    const txSpy = vi.spyOn(app.db, "transaction");

    // Empty table: the seed path runs inside an `immediate` transaction,
    // which is what makes check-then-insert atomic across connections.
    await app.inject({ method: "GET", url: "/api/workspaces" });
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith(expect.any(Function), { behavior: "immediate" });

    // Another connection to the same file holds the write lock. A non-empty
    // list must still be served from a plain WAL read — no transaction, no
    // waiting out busy_timeout.
    txSpy.mockClear();
    const other = new Database(freshDb);
    other.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      const res = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(txSpy).not.toHaveBeenCalled();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
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
  describe("pinned projects (#3537)", () => {
    type App = Awaited<ReturnType<typeof buildApp>>;

    async function mkProject(app: App, name: string): Promise<number> {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name, cwd: "/tmp" },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as number;
    }

    async function mkWorkspace(app: App, name = "pins"): Promise<number> {
      const res = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name } });
      expect(res.statusCode).toBe(201);
      expect(res.json().pinnedProjectIds).toEqual([]);
      return res.json().id as number;
    }

    const pin = (app: App, id: number, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/workspaces/${id}`, payload });

    async function listedPins(app: App, id: number): Promise<number[] | undefined> {
      const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
      return (listed.json() as Array<{ id: number; pinnedProjectIds: number[] }>).find(
        (w) => w.id === id,
      )?.pinnedProjectIds;
    }

    it("sets, reorders, de-duplicates and clears the pins; GET returns them in order", async () => {
      const app = await buildApp();
      const [a, b, c] = [
        await mkProject(app, "a"),
        await mkProject(app, "b"),
        await mkProject(app, "c"),
      ];
      const ws = await mkWorkspace(app);

      const set = await pin(app, ws, { pinnedProjectIds: [b, a, b, c] });
      expect(set.statusCode).toBe(200);
      expect(set.json().pinnedProjectIds).toEqual([b, a, c]);
      expect(await listedPins(app, ws)).toEqual([b, a, c]);

      const reordered = await pin(app, ws, { pinnedProjectIds: [c, b] });
      expect(reordered.json().pinnedProjectIds).toEqual([c, b]);
      expect(await listedPins(app, ws)).toEqual([c, b]);

      // Omitting the field leaves the pins as they are.
      const renamed = await pin(app, ws, { name: "renamed" });
      expect(renamed.json()).toMatchObject({ name: "renamed", pinnedProjectIds: [c, b] });

      const cleared = await pin(app, ws, { pinnedProjectIds: [] });
      expect(cleared.json().pinnedProjectIds).toEqual([]);
      expect(await listedPins(app, ws)).toEqual([]);
      await app.close();
    });

    it("a pins-only PATCH leaves the name and layout alone", async () => {
      const app = await buildApp();
      const a = await mkProject(app, "a");
      const ws = await mkWorkspace(app, "keep-me");
      const layout = { grid: { root: { type: "leaf" } } };
      await pin(app, ws, { layout });

      const res = await pin(app, ws, { pinnedProjectIds: [a] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "keep-me", layout, pinnedProjectIds: [a] });
      await app.close();
    });

    it("refuses an unknown project id with a 400 and changes nothing", async () => {
      const app = await buildApp();
      const a = await mkProject(app, "a");
      const ws = await mkWorkspace(app, "before");
      await pin(app, ws, { pinnedProjectIds: [a] });

      const res = await pin(app, ws, { name: "after", pinnedProjectIds: [a, 999999] });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("999999");

      const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
      const row = (listed.json() as Array<{ id: number; name: string }>).find((w) => w.id === ws);
      expect(row).toMatchObject({ name: "before", pinnedProjectIds: [a] });
      await app.close();
    });

    it("rejects a non-integer pin list", async () => {
      const app = await buildApp();
      const ws = await mkWorkspace(app);
      expect((await pin(app, ws, { pinnedProjectIds: ["x"] })).statusCode).toBe(400);
      expect((await pin(app, ws, { pinnedProjectIds: 3 })).statusCode).toBe(400);
      await app.close();
    });

    it("404s a pins-only PATCH of a missing workspace", async () => {
      const app = await buildApp();
      const a = await mkProject(app, "a");
      expect((await pin(app, 999999, { pinnedProjectIds: [a] })).statusCode).toBe(404);
      // A missing workspace wins over an unknown project.
      expect((await pin(app, 999999, { pinnedProjectIds: [888888] })).statusCode).toBe(404);
      await app.close();
    });

    it("deleting the workspace removes its pin rows", async () => {
      const app = await buildApp();
      const a = await mkProject(app, "a");
      const ws = await mkWorkspace(app);
      await pin(app, ws, { pinnedProjectIds: [a] });

      await app.inject({ method: "DELETE", url: `/api/workspaces/${ws}` });
      const rows = app.db
        .select()
        .from(workspacePinnedProjects)
        .where(eq(workspacePinnedProjects.workspaceId, ws))
        .all();
      expect(rows).toEqual([]);
      await app.close();
    });

    it("deleting a project removes its pin rows from every workspace", async () => {
      const app = await buildApp();
      const [a, b] = [await mkProject(app, "a"), await mkProject(app, "b")];
      const [w1, w2] = [await mkWorkspace(app, "w1"), await mkWorkspace(app, "w2")];
      await pin(app, w1, { pinnedProjectIds: [a, b] });
      await pin(app, w2, { pinnedProjectIds: [a] });

      const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${a}` });
      expect(deleted.statusCode).toBeLessThan(300);
      expect(await listedPins(app, w1)).toEqual([b]);
      expect(await listedPins(app, w2)).toEqual([]);
      const rows = app.db
        .select()
        .from(workspacePinnedProjects)
        .where(eq(workspacePinnedProjects.projectId, a))
        .all();
      expect(rows).toEqual([]);
      await app.close();
    });
  });
});
