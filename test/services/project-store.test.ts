import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions, webhookRegistrations } from "../../src/db/schema.js";
import {
  deleteProject,
  dockSessionIdsByProject,
  findOtherProject,
  getProjectById,
  getProjectOrThrow,
  getProjectsByIds,
  getWebhookRegistration,
  insertProject,
  listOtherProjectLocations,
  listProjectCwdsOnHost,
  listProjectIds,
  listProjects,
  listProjectsByName,
  listSessionsForProject,
  updateProject,
} from "../../src/services/project-store.js";

describe("project-store", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
    await app.ready();
    app.db.delete(projects).run();
  });

  afterEach(async () => {
    await app.close();
  });

  const add = (name: string, cwd = `/tmp/${name}`, hostId = "local") =>
    insertProject(app, { name, cwd, hostId });

  it("inserts, reads, updates and deletes a project", () => {
    const created = add("alpha");
    expect(getProjectById(app, created.id)?.name).toBe("alpha");
    expect(getProjectOrThrow(app, created.id).cwd).toBe("/tmp/alpha");
    expect(updateProject(app, created.id, { name: "beta" })?.name).toBe("beta");
    expect(updateProject(app, 999999, { name: "x" })).toBeUndefined();
    expect(deleteProject(app, created.id)).toBe(true);
    expect(deleteProject(app, created.id)).toBe(false);
    expect(getProjectById(app, created.id)).toBeUndefined();
    expect(() => getProjectOrThrow(app, created.id)).toThrow(/not found/);
  });

  it("lists projects, case-insensitively by name, ids, and by host", () => {
    const b = add("banana");
    const a = add("Apple", "/tmp/apple", "other");
    expect(listProjectsByName(app).map((p) => p.name)).toEqual(["Apple", "banana"]);
    expect(listProjects(app)).toHaveLength(2);
    expect(listProjectIds(app).sort()).toEqual([a.id, b.id].sort());
    expect(listProjectCwdsOnHost(app, "other")).toEqual(["/tmp/apple"]);
    expect(getProjectsByIds(app, [a.id, 99999]).map((p) => p.id)).toEqual([a.id]);
    expect(listOtherProjectLocations(app, a.id)).toEqual([
      { id: b.id, cwd: "/tmp/banana", hostId: "local" },
    ]);
  });

  it("findOtherProject skips the excluded id and applies the predicate", () => {
    const a = add("a");
    const b = add("b");
    expect(findOtherProject(app, a.id, () => true)?.id).toBe(b.id);
    expect(findOtherProject(app, a.id, (p) => p.id === a.id)).toBeUndefined();
  });

  it("groups active dock sessions by project and lists a project's sessions", () => {
    const a = add("a");
    const b = add("b");
    const d1 = app.db
      .insert(sessions)
      .values({ projectId: a.id, command: "bash", kind: "dock", status: "active" })
      .returning()
      .get();
    app.db
      .insert(sessions)
      .values({ projectId: a.id, command: "bash", kind: "dock", status: "exited" })
      .run();
    app.db.insert(sessions).values({ projectId: b.id, command: "bash", status: "active" }).run();
    expect(dockSessionIdsByProject(app)).toEqual(new Map([[a.id, [String(d1.id)]]]));
    expect(listSessionsForProject(app, a.id)).toHaveLength(2);
    expect(listSessionsForProject(app, b.id)).toHaveLength(1);
  });

  it("reads a project's webhook registration", () => {
    const a = add("a");
    expect(getWebhookRegistration(app, a.id)).toBeUndefined();
    app.db
      .insert(webhookRegistrations)
      .values({ projectId: a.id, owner: "acme", repo: "app", hookId: 7 })
      .run();
    expect(getWebhookRegistration(app, a.id)).toEqual({ owner: "acme", repo: "app", hookId: 7 });
  });
});
