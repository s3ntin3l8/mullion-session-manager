import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Must come before any import below that could load "node-pty" or
// "node:child_process" (see test/routes/sessions-palette.test.ts).
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) =>
  mockChildProcessSpawn(await importOriginal<typeof ChildProcess>(), { passthrough: ["git"] }),
);

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const TOKEN = "test-agent-token";
const tmpDb = path.join(os.tmpdir(), `internal-wait-output-render-test-${process.pid}.db`);

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

// #2172 — the agent's wait-output route matches and returns a rendered view of
// the session's output, at the live session size.
describe("POST /internal/sessions/:id/wait-output rendering (agent role)", () => {
  let projectsRoot: string;
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-wait-output-render-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  it("matches and returns the rendered view of a repainted line", async () => {
    const app = await buildApp();
    const before = ptyMock.spawnedPtys.length;
    await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "7101", cwd: projectsRoot, command: "bash", cols: 80, rows: 24 },
    });
    await waitUntil(() => ptyMock.spawnedPtys.length > before);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    const pending = app.inject({
      method: "POST",
      url: "/internal/sessions/7101/wait-output",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { match: "as a single", regex: false, timeoutMs: 5000 },
    });
    await new Promise((r) => setTimeout(r, 50));
    // Written wrongly, then only the changed cell repainted via cursor-forward.
    pty.emitData("Re-print ONLY items 1-4 as a singlx");
    pty.emitData("\r\u001b[34Ce\r\n");
    const res = await pending;
    expect(res.json()).toMatchObject({
      matched: true,
      text: "as a single",
      line: "Re-print ONLY items 1-4 as a single",
    });
    await app.close();
  });
});
