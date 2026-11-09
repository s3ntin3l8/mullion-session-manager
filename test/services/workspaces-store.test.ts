import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

import {
  DEFAULT_WORKSPACE_NAME,
  createWorkspace,
  deleteWorkspace,
  listWorkspacesSeeded,
  updateWorkspace,
} from "../../src/services/workspaces-store.js";

const tmpDb = path.join(os.tmpdir(), `workspaces-store-${process.pid}.db`);

describe("workspaces-store", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("seeds exactly one default workspace on an empty table, then leaves it alone", async () => {
    const app = await buildApp();
    try {
      const first = listWorkspacesSeeded(app.db);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ name: DEFAULT_WORKSPACE_NAME, layout: null });
      expect(listWorkspacesSeeded(app.db)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("creates, updates (only the given fields) and deletes", async () => {
    const app = await buildApp();
    try {
      const created = createWorkspace(app.db, "Work");
      expect(created).toMatchObject({ name: "Work", layout: null });

      const updated = updateWorkspace(app.db, created.id, { layout: '{"a":1}', position: 3 });
      expect(updated).toMatchObject({ name: "Work", layout: '{"a":1}', position: 3 });

      expect(updateWorkspace(app.db, 999_999, { name: "x" })).toBeUndefined();

      expect(deleteWorkspace(app.db, created.id)).toBe(true);
      expect(deleteWorkspace(app.db, created.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
