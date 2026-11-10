import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Must come before any import below that could load "node-pty" or
// "node:child_process" (see test/routes/sessions-palette.test.ts).
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

const TOKEN = "test-agent-token";
const tmpDb = path.join(os.tmpdir(), `internal-spawn-palette-test-${process.pid}.db`);
const DARK = { foreground: "#abb2bf", background: "#282c34", cursor: "#528bff" };
const LIGHT = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

// #2528 / #2857 — a session on a remote host is spawned by the primary through
// this agent route, and the agent (which owns the PTY) answers its startup
// color query. The creating dashboard's palette must win over this agent's
// global cache, as it does for a local session.
describe("POST /internal/sessions palette (agent role)", () => {
  let projectsRoot: string;
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-spawn-palette-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });
  afterEach(() => resetTerminalPalette());
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  async function spawnWith(id: string, palette?: unknown) {
    const app = await buildApp();
    setTerminalPalette(DARK);
    const before = ptyMock.spawnedPtys.length;
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id,
        cwd: projectsRoot,
        command: "bash",
        cols: 80,
        rows: 24,
        ...(palette ? { palette } : {}),
      },
    });
    return { app, res, before };
  }

  it("answers the startup color query from the palette the primary forwarded", async () => {
    const { app, res, before } = await spawnWith("7001", LIGHT);
    expect(res.statusCode).toBe(201);
    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    pty.emitData("\x1b]11;?\x07");
    expect(pty.write).toHaveBeenCalledWith("\x1b]11;rgb:f2f2/f2f2/f2f2\x07");
    await app.close();
  });

  it("falls back to this agent's global palette when the primary sent none (older primary)", async () => {
    const { app, res, before } = await spawnWith("7002");
    expect(res.statusCode).toBe(201);
    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    pty.emitData("\x1b]11;?\x07");
    expect(pty.write).toHaveBeenCalledWith("\x1b]11;rgb:2828/2c2c/3434\x07");
    await app.close();
  });

  it("rejects a malformed palette", async () => {
    const { app, res } = await spawnWith("7003", { foreground: "red" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
