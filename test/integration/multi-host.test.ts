import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Two real buildApp() instances in one process — one "agent" (a remote
// host), one "primary" — proving the whole proxy chain end-to-end: register
// the agent as a host, spawn a session through it, attach through the
// primary's own /ws/terminal and confirm bytes actually flow, then tear the
// agent down and confirm the reconciler skips it instead of mass-killing
// its sessions (issue #26 landmine #1). Faked node-pty/child_process the
// same combined way as test/routes/internal.test.ts, since both roles here
// exercise PtyManager.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
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
      if ((file === "systemctl" && args[1] === "stop") || file === "systemd-run") {
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

const AGENT_TOKEN = "integration-agent-token";
const primaryDb = path.join(
  os.tmpdir(),
  `multi-host-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition never became true");
}

async function buildAndListen(env: Record<string, string>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    process.env[key] = env[key];
  }
  const app = await buildApp();
  for (const key of Object.keys(env)) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

describe("multi-host proxy (issue #26)", () => {
  let agent: Awaited<ReturnType<typeof buildAndListen>>;
  let primary: Awaited<ReturnType<typeof buildAndListen>>;
  let hostId: string;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(primaryDb, { force: true });

    agent = await buildAndListen({
      TESSERA_ROLE: "agent",
      TESSERA_AGENT_TOKEN: AGENT_TOKEN,
      PROJECTS_ROOTS: os.tmpdir(),
    });
    primary = await buildAndListen({ DATABASE_URL: `file:${primaryDb}` });

    const hostRes = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: "integration-agent",
        baseUrl: `http://127.0.0.1:${agent.port}`,
        token: AGENT_TOKEN,
      },
    });
    hostId = hostRes.json().id;

    const projectRes = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote", cwd: "/tmp/remote-project", hostId },
    });
    projectId = projectRes.json().id;
  });

  afterAll(async () => {
    await primary.app.close();
    await agent.app.close();
    fs.rmSync(primaryDb, { force: true });
  });

  it("discovers, spawns, lists as alive, attaches, and streams bytes through the proxy", async () => {
    const before = fakePtyChildren.length;

    const created = await primary.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as number;
    await waitUntil(() => fakePtyChildren.length > before);

    await waitUntil(async () => {
      const list = await primary.app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      return list.json()[0]?.alive === true;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${primary.port}/ws/terminal?sessionId=${sessionId}`);

    // attachSocketToSession forwards pty output as binary Buffer frames
    // (see terminal.ts), which Node's global WebSocket surfaces as a Blob
    // by default. Collected from before "open" rather than a single
    // once-listener set up later: getScrollback() now always sends a
    // backlog frame on attach (even content-less sessions get a screen-mode
    // preamble — see pty-manager.ts, issue #83), and relaying it through two
    // WS hops (agent -> primary -> browser) means it can land anywhere
    // relative to when a test sets up a listener. A once-listener attached
    // after the fact can race and capture that backlog frame instead of the
    // "hello through the proxy" data frame this test cares about.
    const messages: string[] = [];
    ws.addEventListener("message", (event) => {
      if (event.data instanceof Blob) {
        void event.data.text().then((text) => messages.push(text));
      } else {
        messages.push(String(event.data));
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("close", () => reject(new Error("closed instead of opening")), {
        once: true,
      });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });

    const agentPty = fakePtyChildren[fakePtyChildren.length - 1];
    // The client's 'open' event only proves the browser<->primary leg
    // finished; proxyToRemoteAttach's primary<->agent leg (and so its
    // forwarding listeners) may still be mid-handshake. Wait for the
    // agent's own PtyManager to show a live subscriber on this session —
    // i.e. attachSocketToSession has actually run on the agent side —
    // before emitting, so this doesn't race and hang on an unattached
    // FakePty.
    await waitUntil(() => (agent.app.pty.get(String(sessionId))?.subscriberCount ?? 0) > 0);

    agentPty.emitData("hello through the proxy");
    await waitUntil(() => messages.includes("hello through the proxy"));
    expect(messages).toContain("hello through the proxy");

    ws.close();
  });

  it("terminates a remote session through the proxy and marks it killed", async () => {
    const created = await primary.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id as number;

    const deleted = await primary.app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const list = await primary.app.inject({
      method: "GET",
      url: `/api/sessions?projectId=${projectId}`,
    });
    expect(list.json()).toContainEqual(
      expect.objectContaining({ id: sessionId, status: "killed", alive: false }),
    );
  });

  it("discovers this agent's own PROJECTS_ROOTS through the primary's proxy", async () => {
    const res = await primary.app.inject({
      method: "GET",
      url: `/api/projects/discover?hostId=${hostId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("skips reconciling a host once it's gone, instead of flipping its sessions to exited", async () => {
    const { reconcileExitedSessions } = await import("../../src/services/session-reconciler.js");

    const created = await primary.app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "bash" },
    });
    const sessionId = created.json().id as number;

    // Point at a now-dead port (the agent already stopped listening once
    // afterAll's app.close() below would run — simulate the same
    // "unreachable mid-lifetime" case here by hitting a closed local port
    // instead of tearing down the shared `agent` other tests still use).
    const deadPortHost = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "dead", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const deadProject = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dead-project", cwd: "/x", hostId: deadPortHost.json().id },
    });
    const { sessions } = await import("../../src/db/schema.js");
    const [orphan] = primary.app.db
      .insert(sessions)
      .values({ projectId: deadProject.json().id, command: "bash" })
      .returning()
      .all();

    await reconcileExitedSessions(primary.app);

    const list = await primary.app.inject({ method: "GET", url: "/api/sessions" });
    const rows = list.json() as Array<{ id: number; status: string }>;
    // The unreachable host's session is untouched (still active) ...
    expect(rows.find((s) => s.id === orphan.id)?.status).toBe("active");
    // ... while the reachable agent's session from this describe block's
    // earlier test still reconciles normally alongside it in the same
    // reconcileExitedSessions() call.
    expect(rows.find((s) => s.id === sessionId)?.status).toBe("active");
  });
});
