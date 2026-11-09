import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

import { sessions } from "../../src/db/schema.js";
import {
  getProjectRow,
  getSessionModels,
  getSessionRow,
  listSessionRows,
  renameSessionRow,
  setProjectDevServerUrlIfUnset,
  touchSessionAttached,
} from "../../src/services/session-store.js";

const tmpDb = path.join(os.tmpdir(), `session-store-${process.pid}.db`);

describe("session-store", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("reads, filters, renames and touches session rows; guards the dev-server URL", async () => {
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "p-store", cwd: "/tmp" },
      });
      const projectId = created.json().id as number;
      const add = (over: Partial<typeof sessions.$inferInsert> = {}) =>
        app.db
          .insert(sessions)
          .values({ projectId, command: "claude", cwd: "/tmp", status: "active", ...over })
          .returning()
          .get();
      const parent = add({ model: "m1", smallModel: "s1" });
      const child = add({ parentSessionId: parent.id, status: "exited" });

      expect(getSessionRow(app.db, parent.id)?.id).toBe(parent.id);
      expect(getSessionRow(app.db, 999_999)).toBeUndefined();
      expect(getProjectRow(app.db, projectId)?.name).toBe("p-store");
      expect(getProjectRow(app.db, 999_999)).toBeUndefined();

      expect(listSessionRows(app.db)).toHaveLength(2);
      expect(listSessionRows(app.db, { parentSessionId: parent.id }).map((r) => r.id)).toEqual([
        child.id,
      ]);
      expect(listSessionRows(app.db, { projectId, status: "active" }).map((r) => r.id)).toEqual([
        parent.id,
      ]);
      expect(listSessionRows(app.db, { projectId: 999_999 })).toEqual([]);

      expect(getSessionModels(app.db, parent.id)).toEqual({ model: "m1", smallModel: "s1" });
      expect(getSessionModels(app.db, 999_999)).toBeUndefined();

      const renamed = renameSessionRow(app.db, parent.id, "renamed");
      expect(renamed).toMatchObject({ name: "renamed", nameLocked: true });
      expect(renameSessionRow(app.db, 999_999, "x")).toBeUndefined();

      expect(getSessionRow(app.db, parent.id)?.lastAttachedAt).toBeNull();
      touchSessionAttached(app.db, parent.id);
      expect(getSessionRow(app.db, parent.id)?.lastAttachedAt).toBeInstanceOf(Date);

      expect(setProjectDevServerUrlIfUnset(app.db, projectId, "http://localhost:1")).toBe(true);
      expect(setProjectDevServerUrlIfUnset(app.db, projectId, "http://localhost:2")).toBe(false);
      expect(getProjectRow(app.db, projectId)?.devServerUrl).toBe("http://localhost:1");
    } finally {
      await app.close();
    }
  });
});
