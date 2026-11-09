import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

import {
  createGroup,
  deleteGroup,
  listGroups,
  updateGroup,
} from "../../src/services/groups-store.js";

const tmpDb = path.join(os.tmpdir(), `groups-store-${process.pid}.db`);

describe("groups-store", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates with and without a colour, lists, updates and deletes", async () => {
    const app = await buildApp();
    try {
      const plain = createGroup(app.db, { name: "A" });
      expect(plain).toMatchObject({ name: "A", color: null, collapsed: false });
      const coloured = createGroup(app.db, { name: "B", color: "red" });
      expect(coloured.color).toBe("red");
      expect(listGroups(app.db).map((g) => g.name)).toEqual(["A", "B"]);

      expect(updateGroup(app.db, plain.id, { collapsed: true, color: null })).toMatchObject({
        name: "A",
        collapsed: true,
        color: null,
      });
      expect(updateGroup(app.db, 999_999, { name: "x" })).toBeUndefined();

      expect(deleteGroup(app.db, plain.id)).toBe(true);
      expect(deleteGroup(app.db, plain.id)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
