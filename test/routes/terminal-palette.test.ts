import { describe, it, expect, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  getTerminalPalette,
  resetTerminalPalette,
} from "../../src/services/terminal-query-reply.js";

const tmpDb = path.join(os.tmpdir(), `terminal-palette-test-${process.pid}.db`);

describe("PUT /api/terminal/palette", () => {
  afterEach(() => resetTerminalPalette());
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
  });

  async function app() {
    process.env.DATABASE_URL = `file:${tmpDb}`;
    return buildApp();
  }

  it("caches the reported palette for the backend's startup query replies", async () => {
    const a = await app();
    const res = await a.inject({
      method: "PUT",
      url: "/api/terminal/palette",
      payload: { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" },
    });
    expect(res.statusCode).toBe(204);
    expect(getTerminalPalette()).toEqual({
      foreground: "#1d1d1d",
      background: "#f2f2f2",
      cursor: "#1d1d1d",
    });
    await a.close();
  });

  it("rejects anything that is not a #rrggbb colour", async () => {
    const a = await app();
    const res = await a.inject({
      method: "PUT",
      url: "/api/terminal/palette",
      payload: { foreground: "red", background: "#f2f2f2", cursor: "#1d1d1d" },
    });
    expect(res.statusCode).toBe(400);
    expect(getTerminalPalette()).toBeNull();
    await a.close();
  });
});
