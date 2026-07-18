import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";

// The agent's /internal/* API (issue #26) reaches the exact same PtyManager
// spawn/liveness path as the primary's own routes (sessions.ts, terminal.ts)
// and the exact same agent-detect probe as actions.ts/agents.ts — just
// through a token-gated, DB-less surface instead. Faked the same way
// test/routes/terminal.test.ts, test/services/pty-manager.test.ts, and
// test/services/agent-detect.test.ts fake it, combined into one mock since a
// single "agent" role process exercises all three code paths.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  writeSpy = vi.fn();
  resizeSpy = vi.fn();

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write(data: string) {
    this.writeSpy(data);
  }

  resize(cols: number, rows: number) {
    this.resizeSpy(cols, rows);
  }

  kill() {}

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[] = []) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };

      // PtyManager.isMasterAlive: `systemctl --user is-active <unit>.scope`.
      // Always replies "active" — this suite asserts response shape, not
      // session-reconciler-style semantics (already covered elsewhere).
      if (file === "systemctl" && args[1] === "is-active") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit("data", Buffer.from("active\n"));
            ee.emit("close", 0);
          });
        });
        return ee;
      }

      // PtyManager.stopScope (terminate) and bootstrapMaster (systemd-run):
      // both only wait on 'exit'.
      if ((file === "systemctl" && args[1] === "stop") || file === "systemd-run") {
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }

      // Anything else is agent-detect's probe(): `$SHELL -lc "command -v
      // <bin>"`, which waits on 'close' only (never 'exit' — see its own
      // doc comment). No stdout data means "not found"; every probe in this
      // suite reports unavailable, which is fine since nothing here asserts
      // on which specific CLIs are detected, only that the endpoints work.
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");

const TOKEN = "test-agent-token";

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

// The `ws` package's client (needed here, not the global WebSocket, since
// only `ws` supports setting a custom Authorization header on the upgrade
// request — see remote-host-client.ts's planned use of the same package)
// emits 'unexpected-response' (and sometimes 'error') for a rejected
// upgrade, not a DOM-style 'close' event — both are "never opened" outcomes
// for this test's purposes.
function waitForNodeWsOutcome(ws: NodeWebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    ws.once("unexpected-response", () => resolve("close"));
    ws.once("error", () => resolve("close"));
  });
}

describe("internal routes (agent role, issue #26)", () => {
  let projectsRoot: string;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-discover-root-"));
    fs.mkdirSync(path.join(projectsRoot, "git-repo", ".git"), { recursive: true });
    process.env.TESSERA_ROLE = "agent";
    process.env.TESSERA_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.TESSERA_ROLE;
    delete process.env.TESSERA_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  beforeEach(() => {
    clearAgentsCacheForTests();
  });

  async function buildAndListen() {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  it("rejects a request with no Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/agents" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a request with the wrong token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/agents",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("discovers candidates from this agent's own PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: "git-repo", cwd: path.join(projectsRoot, "git-repo"), isGitRepo: true },
    ]);
    await app.close();
  });

  it("requires a cwd query param for actions and dock", async () => {
    const app = await buildApp();
    const actions = await app.inject({
      method: "GET",
      url: "/internal/actions",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: "/internal/dock",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);
    await app.close();
  });

  it("resolves actions and dock for a cwd on this host", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(200);
    expect(Array.isArray(actions.json())).toBe(true);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(200);
    expect(dock.json()).toEqual([]);
    await app.close();
  });

  it("returns this host's detected agents", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/agents",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("spawns a session, reports its live status/liveness, and terminates it", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "internal-spawn-1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["internal-spawn-1", "never-spawned"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.statusCode).toBe(200);
    const live = liveRes.json();
    expect(live["internal-spawn-1"]).toMatchObject({ alive: true, cwd: "/tmp", command: "bash" });
    expect(live["never-spawned"]).toBeNull();

    const livenessRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/liveness",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["internal-spawn-1"] },
    });
    expect(livenessRes.statusCode).toBe(200);
    // The fake systemctl mock above always replies "active".
    expect(livenessRes.json()).toEqual({ "internal-spawn-1": true });

    const terminateRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/internal-spawn-1/terminate",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(204);

    await app.close();
  });

  it("expands a leading ~ in a spawned session's cwd against this host's own home dir", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "internal-tilde-1", cwd: "~", command: "bash", cols: 80, rows: 24 },
    });
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["internal-tilde-1"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.json()["internal-tilde-1"]).toMatchObject({ cwd: os.homedir() });

    await app.close();
  });

  it("rejects a WS attach with no Authorization header before the upgrade completes", async () => {
    const { app, port } = await buildAndListen();

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=x&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
    );
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a WS attach missing required query params, even with a valid token", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/attach?id=x`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("attaches over WS with a valid token, spawning and streaming pty output", async () => {
    const { app, port } = await buildAndListen();
    const before = fakePtyChildren.length;

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=ws-attach-1&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("close", () => reject(new Error("WS closed instead of opening")));
      ws.once("error", reject);
    });
    await waitUntil(() => fakePtyChildren.length > before);
    const pty = fakePtyChildren[fakePtyChildren.length - 1];

    const messagePromise = new Promise<Buffer>((resolve) => {
      ws.once("message", (data) => resolve(data as Buffer));
    });
    pty.emitData("hello from agent pty");
    const message = await messagePromise;
    expect(message.toString("utf8")).toBe("hello from agent pty");

    ws.close();
    await app.close();
  });
});
