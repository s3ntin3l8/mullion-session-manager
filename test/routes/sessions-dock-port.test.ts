import { describe, it, expect, beforeAll, afterAll, vi, type MockedFunction } from "vitest";
// Must precede any import that could load "node-pty"/"node:child_process" —
// see mock-pty.ts's header comment.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type * as ChildProcess from "node:child_process";

// Issue #2069 — POST /api/sessions refuses a dock session whose control's
// port is already bound. Same fakes as sessions.test.ts: no real PTY or
// systemd-run; the port itself is REAL (an ephemeral listener).
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
const childProcessMock = vi.hoisted(() => ({
  spawn: undefined as unknown as MockedFunction<typeof ChildProcess.spawn>,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const mocked = mockChildProcessSpawn(actual, { passthrough: ["git"] });
  childProcessMock.spawn = vi.mocked(mocked.spawn);
  return mocked;
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `sessions-dock-port-${process.pid}.db`);

function listen(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("POST /api/sessions — dock port conflict", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dock-port-"));
  const servers: net.Server[] = [];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    for (const s of servers) s.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  function writeDock(controls: unknown[]) {
    fs.mkdirSync(path.join(cwd, ".crs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crs", "dock.json"), JSON.stringify({ controls }));
  }

  async function projectFor(devServerUrl?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: `p-${Math.random()}`, cwd },
    });
    const id = res.json().id as number;
    if (devServerUrl) {
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl },
      });
      expect(patched.statusCode).toBe(200);
    }
    return id;
  }

  it("409s port_in_use for a control whose port is bound by another process, without spawning", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    writeDock([{ id: "dev", title: "Dev", command: "npm run dev", port }]);
    const projectId = await projectFor();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "port_in_use",
      port,
      message: `Port ${port} is in use by another process`,
    });
    expect(res.json().holderSessionId).toBeUndefined();
    const list = await app.inject({ method: "GET", url: `/api/sessions?projectId=${projectId}` });
    expect(list.json()).toEqual([]);
  });

  it("creates the session once the port is free", async () => {
    const server = await listen();
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r));
    writeDock([{ id: "dev", title: "Dev", command: "npm run dev", port }]);
    const projectId = await projectFor();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("does not probe for a terminal-kind session or a command that is no dock control", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    writeDock([{ id: "dev", title: "Dev", command: "npm run dev", port }]);
    const projectId = await projectFor();

    const terminal = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev" },
    });
    expect(terminal.statusCode).toBe(201);
    const other = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "tail -f log", kind: "dock" },
    });
    expect(other.statusCode).toBe(201);
  });

  it("falls back to a bare-port devServerUrl for the project's only control", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    writeDock([{ id: "dev", title: "Dev", command: "npm run dev" }]);
    const projectId = await projectFor(String(port));

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "port_in_use", port });
  });

  it("does not apply the devServerUrl fallback to a non-dev control among several", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    writeDock([
      { id: "dev", title: "Dev", command: "npm run dev" },
      { id: "logs", title: "Logs", command: "tail -f log" },
    ]);
    const projectId = await projectFor(String(port));

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "tail -f log", kind: "dock" },
    });
    expect(res.statusCode).toBe(201);
  });
});
