import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  createProjectUrl,
  deleteProjectUrl,
  findProjectUrl,
  listProjectUrlIds,
  listProjectUrls,
  reorderProjectUrls,
  updateProjectUrl,
} from "../../src/services/project-urls-store.js";

const tmpDb = path.join(os.tmpdir(), `project-urls-store-test-${process.pid}.db`);

describe("project-urls-store service", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    await app.ready();
    projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "u", cwd: `/tmp/u-${process.pid}` },
      })
    ).json().id;
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates with increasing order, lists ordered, finds scoped to the project", () => {
    const a = createProjectUrl(app.db, projectId, { label: "a", url: "http://a" });
    const b = createProjectUrl(app.db, projectId, { label: "b", url: "http://b", favorite: true });
    expect([a.order, b.order]).toEqual([0, 1]);
    expect(a.favorite).toBe(false);
    expect(b.favorite).toBe(true);
    expect(listProjectUrls(app.db, projectId).map((r) => r.label)).toEqual(["a", "b"]);
    expect(findProjectUrl(app.db, projectId, a.id)?.id).toBe(a.id);
    expect(findProjectUrl(app.db, projectId + 1, a.id)).toBeNull();
  });

  it("updates only the given fields, and returns null for a missing row", () => {
    const [first] = listProjectUrls(app.db, projectId);
    const updated = updateProjectUrl(app.db, first.id, { label: "a2" });
    expect(updated).toMatchObject({ label: "a2", url: "http://a", favorite: false });
    expect(updateProjectUrl(app.db, first.id, { favorite: true })?.favorite).toBe(true);
    expect(updateProjectUrl(app.db, 999999, { label: "x" })).toBeNull();
  });

  it("reorders and deletes", () => {
    const ids = listProjectUrlIds(app.db, projectId);
    reorderProjectUrls(app.db, [...ids].reverse());
    expect(listProjectUrls(app.db, projectId).map((r) => r.id)).toEqual([...ids].reverse());
    deleteProjectUrl(app.db, ids[0]);
    expect(listProjectUrlIds(app.db, projectId)).toEqual([ids[1]]);
  });
});
