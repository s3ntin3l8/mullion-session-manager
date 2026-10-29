import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { projects, tasks } from "../../src/db/schema.js";
import { createHost } from "../../src/services/host-registry.js";
import { localProject, mergeDiscovery, remoteProject } from "../helpers/merge-fixtures.js";

// Issue #2232 — GET /api/projects/duplicates and POST /api/projects/:id/merge.
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => mergeDiscovery.get(hostId) ?? [],
    }),
  };
});

describe("project merge routes", () => {
  let app: FastifyInstance;
  let tmp: string;
  let survivorId: number;
  let dupId: number;
  let macId: string;

  beforeEach(async () => {
    mergeDiscovery.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-merge-route-"));
    app = await buildTestApp();
    await app.ready();
    app.db.delete(projects).run();
    macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
    survivorId = localProject(app, tmp, "app", new Date("2024-01-01T00:00:00Z")).id;
    dupId = remoteProject(app, macId, "app-mac", "/Users/me/app", new Date("2025-01-01")).id;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const merge = (id: number, body: unknown) =>
    app.inject({ method: "POST", url: `/api/projects/${id}/merge`, payload: body as object });

  it("lists duplicate groups", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/duplicates" });
    expect(res.statusCode).toBe(200);
    const { groups } = res.json();
    expect(groups).toHaveLength(1);
    expect(groups[0].survivor.id).toBe(survivorId);
    expect(groups[0].duplicates[0]).toMatchObject({ id: dupId, refusal: null });
  });

  it("merges, returning the survivor with the new mapping and the counts", async () => {
    app.db.insert(tasks).values({ projectId: dupId, title: "t", status: "in_progress" }).run();
    const res = await merge(dupId, { into: survivorId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.survivor.id).toBe(survivorId);
    expect(body.survivor.hostCwds[macId]).toBe("/Users/me/app");
    expect(body.counts).toMatchObject({ tasks: 1, liveTasks: 1 });
    expect(app.db.select().from(projects).where(eq(projects.id, dupId)).get()).toBeUndefined();
  });

  it("rejects a missing or non-integer into", async () => {
    expect((await merge(dupId, { into: "x" })).statusCode).toBe(400);
    expect((await merge(dupId, {})).statusCode).toBe(400);
  });

  it("404s a missing project", async () => {
    expect((await merge(dupId, { into: 99999 })).statusCode).toBe(404);
    expect((await merge(99999, { into: survivorId })).statusCode).toBe(404);
  });

  it("400s a non-numeric id", async () => {
    expect((await merge(Number.NaN, { into: survivorId })).statusCode).toBe(400);
  });

  it("409 NOT_SAME_REPO when the origins differ", async () => {
    const other = localProject(
      app,
      tmp,
      "other",
      new Date("2024-02-01"),
      "git@github.com:acme/other.git",
    );
    const res = await merge(dupId, { into: other.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_SAME_REPO");
  });

  it("409 with a MERGE_ code when the move cannot be expressed", async () => {
    const sameHost = localProject(app, tmp, "app2", new Date("2025-02-01"));
    const res = await merge(sameHost.id, { into: survivorId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MERGE_SAME_HOST");
  });

  it("409 merging a project into itself", async () => {
    const res = await merge(survivorId, { into: survivorId });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MERGE_SAME_PROJECT");
  });
});
