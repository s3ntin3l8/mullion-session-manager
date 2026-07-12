import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

// Groups are pure view metadata (like workspaces.ts) — no PtyManager
// involved, so no child_process mocking needed here either.
const tmpDb = path.join(os.tmpdir(), `groups-test-${process.pid}.db`);

describe("groups route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates a group with defaults and lists it", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/groups",
      payload: { name: "Work" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "Work",
      icon: null,
      color: null,
      collapsed: false,
      position: 0,
    });

    const listed = await app.inject({ method: "GET", url: "/api/groups" });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json() as Array<{ id: number }>).find((g) => g.id === created.json().id);
    expect(row).toMatchObject({ name: "Work" });

    await app.close();
  });

  it("rejects a group missing name", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/groups", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("updates name/icon/color/collapsed/position via PATCH", async () => {
    const app = await buildApp();
    const created = await app.inject({ method: "POST", url: "/api/groups", payload: { name: "g" } });
    const { id } = created.json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/groups/${id}`,
      payload: { name: "renamed", icon: "folder", color: "#fff", collapsed: true, position: 3 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: "renamed",
      icon: "folder",
      color: "#fff",
      collapsed: true,
      position: 3,
    });

    await app.close();
  });

  it("404s patching an unknown group", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: "/api/groups/999999", payload: { name: "x" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a PATCH with no recognized fields", async () => {
    const app = await buildApp();
    const created = await app.inject({ method: "POST", url: "/api/groups", payload: { name: "g" } });
    const { id } = created.json();
    const res = await app.inject({ method: "PATCH", url: `/api/groups/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s deleting an unknown group", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/groups/999999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("deleting a group ungroups (not deletes) its member workspaces", async () => {
    const app = await buildApp();
    const group = await app.inject({ method: "POST", url: "/api/groups", payload: { name: "to-delete" } });
    const groupId = group.json().id;

    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "member" },
    });
    const workspaceId = workspace.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      payload: { groupId },
    });

    const deleted = await app.inject({ method: "DELETE", url: `/api/groups/${groupId}` });
    expect(deleted.statusCode).toBe(204);

    const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
    const row = (listed.json() as Array<{ id: number; groupId: number | null }>).find(
      (w) => w.id === workspaceId,
    );
    expect(row?.groupId).toBeNull();

    await app.close();
  });
});
