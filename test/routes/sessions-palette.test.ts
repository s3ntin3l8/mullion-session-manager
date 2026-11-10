import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Must come before any import below that could load "node-pty" or
// "node:child_process" (see test/routes/sessions.test.ts, which this mirrors).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import {
  resetTerminalPalette,
  setTerminalPalette,
} from "../../src/services/terminal-query-reply.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockChildProcessSpawn(await importOriginal<typeof ChildProcess>(), { passthrough: ["git"] }),
);

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `sessions-palette-test-${process.pid}.db`);
const DARK = { foreground: "#abb2bf", background: "#282c34", cursor: "#528bff" };
const LIGHT = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

// #2528 — two dashboards on different schemes (`theme: "system"` resolves per
// browser): the one that creates a session decides its startup color answer,
// not whichever PUT /api/terminal/palette landed last.
describe("POST /api/sessions palette", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterEach(() => resetTerminalPalette());
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  async function spawnWith(palette: unknown) {
    const app = await buildApp();
    const projectId = await createProject(app);
    setTerminalPalette(DARK);
    const before = ptyMock.spawnedPtys.length;
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash", ...(palette ? { palette } : {}) },
    });
    return { app, res, before };
  }

  it("answers the startup color query from the creating dashboard's palette", async () => {
    const { app, res, before } = await spawnWith(LIGHT);
    expect(res.statusCode).toBe(201);
    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    pty.emitData("\x1b]11;?\x07");
    expect(pty.write).toHaveBeenCalledWith("\x1b]11;rgb:f2f2/f2f2/f2f2\x07");
    await app.close();
  });

  it("falls back to the process-wide palette when the request carries none", async () => {
    const { app, res, before } = await spawnWith(undefined);
    expect(res.statusCode).toBe(201);
    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    pty.emitData("\x1b]11;?\x07");
    expect(pty.write).toHaveBeenCalledWith("\x1b]11;rgb:2828/2c2c/3434\x07");
    await app.close();
  });

  it("rejects a malformed palette", async () => {
    const { app, res } = await spawnWith({ foreground: "red" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
