import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MullionClient } from "../../src/mcp/client.mjs";

// MullionClient's dock methods (#2494: `docks.*` first; a docker-sourced
// control falls back to the legacy full-scope `projects.dock` + `sessions.create`).

function listen(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(socketPath, () => resolve(s));
  });
}

function readLines(socket: net.Socket, onMessage: (msg: unknown) => void): void {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      onMessage(JSON.parse(line));
    }
  });
}

describe("MullionClient dock methods", () => {
  let dir: string;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function startControlServer(
    onRequest: (msg: { id: number; op: string; body: unknown }, socket: net.Socket) => void,
  ) {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-dock-"));
    const socketPath = path.join(dir, "mullion.sock");
    server = await listen(socketPath);
    server.on("connection", (socket) => {
      let handshaked = false;
      readLines(socket, (msg) => {
        if (!handshaked) {
          handshaked = true;
          return;
        }
        onRequest(msg as { id: number; op: string; body: unknown }, socket);
      });
    });
    return socketPath;
  }

  it("stopDockSession sends sessions.kill with the given sessionId", async () => {
    const socketPath = await startControlServer((msg, socket) => {
      expect(msg.op).toBe("sessions.kill");
      expect(msg.body).toEqual({ sessionId: "9" });
      socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200 })}\n`);
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    await client.stopDockSession("9");
  });

  it("startDockSession asks docks.start (own project when projectId is omitted)", async () => {
    const bodies: unknown[] = [];
    const socketPath = await startControlServer((msg, socket) => {
      expect(msg.op).toBe("docks.start");
      bodies.push(msg.body);
      socket.write(
        `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { sessionId: 42 } })}\n`,
      );
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    expect(await client.startDockSession("3", "vite", "feat/x")).toEqual({ sessionId: 42 });
    await client.startDockSession(undefined, "vite");
    expect(bodies).toEqual([
      { projectId: "3", dockControlId: "vite", branch: "feat/x" },
      { dockControlId: "vite" },
    ]);
  });

  it("stopDockSession by control uses docks.stop; listDockControls uses docks.list", async () => {
    const ops: unknown[] = [];
    const socketPath = await startControlServer((msg, socket) => {
      ops.push([msg.op, msg.body]);
      socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    await client.stopDockSession(undefined, { dockControlId: "vite" });
    await client.listDockControls();
    expect(ops).toEqual([
      ["docks.stop", { dockControlId: "vite" }],
      ["docks.list", {}],
    ]);
  });

  it("startDockSession names a docker-sourced control's session by its stable containerName identity, not its title", async () => {
    // Issue #73 follow-up plan (5b) — `control.command` for a docker
    // control is reconstructed fresh from live container labels on every
    // discovery poll and can change text without the service having
    // changed, so naming the session by `control.title` (or matching by
    // command) can silently orphan it. `docker-logs:<containerName>`
    // mirrors dockHelpers.ts's own dockerSessionIdentity on the frontend.
    const socketPath = await startControlServer((msg, socket) => {
      if (msg.op === "docks.start") {
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: false, status: 404, error: "not found" })}\n`,
        );
        return;
      }
      if (msg.op === "projects.dock") {
        socket.write(
          `${JSON.stringify({
            id: msg.id,
            ok: true,
            status: 200,
            result: [
              {
                id: "docker:sanctuary:web",
                command: "docker compose -p sanctuary logs -f web",
                title: "web",
                source: "docker",
                docker: { containerName: "sanctuary-web" },
              },
            ],
          })}\n`,
        );
        return;
      }
      expect(msg.op).toBe("sessions.create");
      expect(msg.body).toEqual({
        projectId: "3",
        command: "docker compose -p sanctuary logs -f web",
        kind: "dock",
        name: "docker-logs:sanctuary-web",
        nameLocked: true,
      });
      socket.write(
        `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 42 } })}\n`,
      );
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    await client.startDockSession("3", "docker:sanctuary:web");
  });

  it("startDockSession throws a clear error when the dock control id doesn't exist", async () => {
    const socketPath = await startControlServer((msg, socket) => {
      if (msg.op === "docks.start") {
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: false, status: 404, error: "not found" })}\n`,
        );
        return;
      }
      socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    await expect(client.startDockSession("3", "missing")).rejects.toThrow(
      "no dock control 'missing' for project 3",
    );
  });

  it("dockLogs / waitForDockOutput / switchDockControl use docks.logs / wait_for_output / switch", async () => {
    const ops: unknown[] = [];
    const socketPath = await startControlServer((msg, socket) => {
      ops.push([msg.op, msg.body]);
      socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: {} })}\n`);
    });
    const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
    await client.dockLogs(undefined, "dev");
    await client.waitForDockOutput({
      projectId: undefined,
      dockControlId: "dev",
      match: "ready",
      regex: true,
      timeoutMs: 1000,
      afterOffset: 3,
    });
    await client.switchDockControl("2", "dev", { branch: "feat/x" });
    expect(ops).toEqual([
      ["docks.logs", { dockControlId: "dev" }],
      [
        "docks.wait_for_output",
        { dockControlId: "dev", match: "ready", regex: true, timeoutMs: 1000, afterOffset: 3 },
      ],
      ["docks.switch", { projectId: "2", dockControlId: "dev", branch: "feat/x" }],
    ]);
  });
});
