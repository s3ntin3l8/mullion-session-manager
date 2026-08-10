import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  buildCanonicalString,
  hashBody,
  sign,
} from "../../src/services/request-signature.js";

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

// Perf audit finding B8(2) — PtyManager.isMasterAliveBatch replies with
// `systemctl --user list-units ... crs-session-*.scope`, one call for the
// whole batch, instead of one `is-active` spawn per id. Tracked here (same
// approach as test/routes/internal.test.ts's own mock) by recording every
// unit name a fake `systemd-run -u <unit>` spawn below "activates", so
// list-units' fake reply matches whichever sessions this file has actually
// spawned so far — this file's own `reconcileExitedSessions` calls need a
// real per-unit answer, not the `is-active` branch's blanket "always
// active" shortcut (which has no equivalent for list-units: an empty/
// generic reply would report every id as not-alive and mass-flip this
// file's real local sessions to "exited").
const activeScopeUnits = new Set<string>();

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
      if (file === "systemctl" && args[1] === "list-units") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = [...activeScopeUnits]
              .map((unit) => `${unit} loaded active running ${unit}`)
              .join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemd-run") {
        // args: ["--user", "--scope", "--collect", "-u", unitName, "--", ...]
        const unitIndex = args.indexOf("-u");
        if (unitIndex !== -1 && args[unitIndex + 1]) {
          activeScopeUnits.add(`${args[unitIndex + 1]}.scope`);
        }
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      if (file === "systemctl" && args[1] === "stop") {
        const unit = args[2];
        if (unit) activeScopeUnits.delete(unit);
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

async function buildAndListen(env: Record<string, string>, port = 0) {
  // Every call builds a genuinely separate, real buildApp() instance — two
  // (or more) of them would otherwise default to the SAME SESSIONS_DIR
  // (test/setup.ts sets it once per file), so their hooksPlugin listeners
  // (registered for both primary and agent roles) would collide on the same
  // hooks.sock path. A fresh scratch dir per call, ahead of the caller's own
  // env so an explicit override still wins, keeps every instance isolated
  // regardless of how many this file ends up building.
  const withSessionsDir = {
    SESSIONS_DIR: path.join(
      os.tmpdir(),
      `multi-host-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    ),
    ...env,
  };
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(withSessionsDir)) {
    prev[key] = process.env[key];
    process.env[key] = withSessionsDir[key];
  }
  const app = await buildApp();
  for (const key of Object.keys(withSessionsDir)) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
  await app.listen({ port, host: "127.0.0.1" });
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
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: AGENT_TOKEN,
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

  // Issue #247 / roadmap 7.4 — the whole point of this being pull-based is
  // that it works identically for this static-token host today and, once
  // #245 lands, a self-registered one; nothing here is registration-mode
  // specific.
  it("pulls this agent's own effective config through the primary's proxy", async () => {
    const res = await primary.app.inject({
      method: "GET",
      url: `/api/hosts/${hostId}/config`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      role: "agent",
      projectsRoots: [os.tmpdir()],
    });
    expect(typeof res.json().version).toBe("string");
  });

  it("resolves the local host's own config directly, with no proxying", async () => {
    const res = await primary.app.inject({
      method: "GET",
      url: "/api/hosts/local/config",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "primary" });
  });

  // Issue #522 — these five routes always 500'd on the agent (no app.db
  // there), so every assertion below (even the 404/400 ones) is real proof:
  // before the fix, every one of these calls never got past the crash.
  describe("browser-cookies and dev-server-status for a remote-hosted project (issue #522)", () => {
    it("list runs locally against the primary's own DB, not proxied to the (DB-less) agent", async () => {
      const res = await primary.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/browser-cookies`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("delete runs locally — 404 for an unknown profile id, not a 500 from the dead agent route", async () => {
      const res = await primary.app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/browser-cookies/999999`,
      });
      expect(res.statusCode).toBe(404);
    });

    it("import 400s for a remote-hosted project, pointing at Upload instead of proxying to the agent", async () => {
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: {
          browser: "chrome",
          profilePath: "/home/x/.config/google-chrome/Default",
          label: "l",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/use Upload instead/);
    });

    it("upload runs locally — a malformed cookie DB 400s from the local parse, not a 500 from the agent", async () => {
      const res = await primary.app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/upload`,
        payload: {
          browser: "chrome",
          fileBase64: Buffer.from("not a sqlite database").toString("base64"),
          label: "l",
        },
      });
      // Proves the local readBrowserCookiesFromBuffer path actually ran
      // (it rejects anything without a SQLite header) rather than the old
      // RemoteHostClient proxy call landing on the agent's dead route.
      expect(res.statusCode).toBe(400);
    });

    it("dev-server-status resolves without a devServerUrl configured, without proxying to the agent", async () => {
      const res = await primary.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/dev-server-status`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ online: false });
    });

    it("agent's own /internal/dev-server-status probes its own loopback by port+scheme, with no project lookup", async () => {
      const net = await import("node:net");
      // pingDevServer (for http:) waits for a response starting "HTTP/"
      // before it resolves true — a bare TCP accept-and-close isn't enough.
      const server = net.createServer((socket) => {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }
      try {
        // Hits the agent directly (not through the primary) — primary and
        // agent share this test process, so a passing result seen only
        // through the primary wouldn't prove the agent did the probing.
        const res = await agent.app.inject({
          method: "GET",
          url: `/internal/dev-server-status?port=${address.port}&scheme=http`,
          headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ online: true });
      } finally {
        server.close();
      }
    });

    // Hermes review, PR #533 — the tests above never actually drove the
    // primary -> agent dev-server-status wiring end to end (the no-
    // devServerUrl case short-circuits locally, and the direct-agent-hit
    // case bypasses the primary's own resolveDevServerTarget + dispatch
    // entirely). These three set a real devServerUrl on the remote project
    // and go through the primary's own route, proving the whole chain: the
    // primary resolves port(+scheme) from devServerUrl, dispatches to the
    // agent, and the agent's probe result comes back unchanged.
    describe("dev-server-status through the primary, with a real devServerUrl set on the remote project", () => {
      async function withScratchServer<T>(
        respond: (socket: Socket) => void,
        run: (port: number) => Promise<T>,
      ): Promise<T> {
        const net = await import("node:net");
        const server = net.createServer(respond);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected a real bound address");
        }
        try {
          return await run(address.port);
        } finally {
          server.close();
        }
      }

      afterEach(async () => {
        // Leaves the shared `projectId` project's devServerUrl unset again,
        // so it doesn't bleed into later tests in the parent describe block
        // that assume no devServerUrl is configured.
        await primary.app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { devServerUrl: null },
        });
      });

      it("a full http:// devServerUrl resolves to port+scheme and dispatches to the agent's real loopback probe", async () => {
        await withScratchServer(
          (socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
          async (port) => {
            await primary.app.inject({
              method: "PATCH",
              url: `/api/projects/${projectId}`,
              payload: { devServerUrl: `http://127.0.0.1:${port}` },
            });
            const res = await primary.app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/dev-server-status`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ online: true });
          },
        );
      });

      it("a bare-port devServerUrl (the common case) resolves the same way as a full URL", async () => {
        await withScratchServer(
          (socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
          async (port) => {
            await primary.app.inject({
              method: "PATCH",
              url: `/api/projects/${projectId}`,
              payload: { devServerUrl: String(port) },
            });
            const res = await primary.app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/dev-server-status`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ online: true });
          },
        );
      });

      it("an https:// devServerUrl forwards the scheme, so the agent takes the TCP-only probe path", async () => {
        // pingDevServer's https: branch resolves true on a bare TCP accept
        // (no HTTP response needed — see pingDevServer's own comment on why
        // TLS makes an inline request unworkable). A server that never
        // responds with "HTTP/" would fail this test under the http: path,
        // which is exactly what proves the scheme was actually forwarded and
        // not silently dropped to http.
        await withScratchServer(
          () => {},
          async (port) => {
            await primary.app.inject({
              method: "PATCH",
              url: `/api/projects/${projectId}`,
              payload: { devServerUrl: `https://127.0.0.1:${port}` },
            });
            const res = await primary.app.inject({
              method: "GET",
              url: `/api/projects/${projectId}/dev-server-status`,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ online: true });
          },
        );
      });

      it("an unreachable agent-side dev server port reports offline rather than 500ing the primary's route", async () => {
        await primary.app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          // Port 1 is privileged/unbound in this test environment — nothing
          // is listening, so the agent's own pingDevServer resolves false.
          payload: { devServerUrl: "http://127.0.0.1:1" },
        });
        const res = await primary.app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/dev-server-status`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ online: false });
      });

      it("an unreachable AGENT (not just its dev server) reports offline, not a 500 — proves the new try/catch", async () => {
        // A dead-port host, same construction as this file's own "skips
        // reconciling a host once it's gone" test below — this is the one
        // case that actually exercises the try/catch added around the
        // remote dispatch (RemoteHostClient throws HostUnreachableError
        // before any HTTP response comes back at all, unlike the sibling
        // test above where the agent responds fine and its own probe just
        // resolves false).
        const deadPortHost = await primary.app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: {
            name: "dev-server-status-dead-host",
            baseUrl: "http://127.0.0.1:1",
            token: "t",
          },
        });
        const deadProject = await primary.app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            name: "dev-server-status-dead-project",
            cwd: "/x",
            hostId: deadPortHost.json().id,
          },
        });
        const deadProjectId = deadProject.json().id as number;
        // POST /api/projects doesn't persist devServerUrl even though its
        // own schema accepts it (a create-time no-op — PATCH is the only
        // write path today) — set it the same way the earlier tests in this
        // describe block do.
        await primary.app.inject({
          method: "PATCH",
          url: `/api/projects/${deadProjectId}`,
          payload: { devServerUrl: "5173" },
        });
        const res = await primary.app.inject({
          method: "GET",
          url: `/api/projects/${deadProjectId}/dev-server-status`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ online: false });
      });
    });
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

// Issue #245 / roadmap 7.1 — agent-initiated registration, end-to-end
// against two real listening apps (same harness as the describe block
// above). A separate describe block since these builds need
// MULLION_PRIMARY_URL/MULLION_ENROLLMENT_TOKEN configured, which the static-
// token describe block above deliberately never sets (proving, just by not
// crashing/behaving any differently there, that agentEnrollmentPlugin is a
// true no-op for a manual-token-only agent).
describe("agent-initiated registration (issue #245 / roadmap 7.1)", () => {
  const enrollmentPrimaryDb = path.join(
    os.tmpdir(),
    `multi-host-enrollment-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
  );

  // Reserves a real, currently-free port and immediately releases it, so
  // the caller can pass the SAME number as both this agent's actual listen
  // port and its MULLION_AGENT_ADVERTISE_URL — buildAndListen always binds
  // to an OS-assigned port (0), which isn't known until *after* buildApp()
  // has already read env into app.config, so the two can't otherwise be
  // made to agree. Same small unavoidable reserve-then-rebind race any test
  // needing a *known* port ahead of time accepts.
  async function reserveFreePort(): Promise<number> {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        srv.close(() => {
          if (address === null || typeof address === "string") {
            reject(new Error("expected a real bound address"));
          } else {
            resolve(address.port);
          }
        });
      });
    });
  }

  let primary: Awaited<ReturnType<typeof buildAndListen>>;

  beforeAll(async () => {
    fs.rmSync(enrollmentPrimaryDb, { force: true });
    primary = await buildAndListen({
      DATABASE_URL: `file:${enrollmentPrimaryDb}`,
      MULLION_ENROLLMENT_SECRET: "fleet-wide-secret", // pragma: allowlist secret
    });
  });

  afterAll(async () => {
    await primary.app.close();
    fs.rmSync(enrollmentPrimaryDb, { force: true });
  });

  it("an agent with MULLION_PRIMARY_URL + MULLION_ENROLLMENT_TOKEN self-registers on boot, with zero manual steps", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    try {
      await waitUntil(async () => {
        const res = await primary.app.inject({ method: "GET", url: "/api/hosts" });
        const hosts = res.json() as Array<{ origin: string; baseUrl: string | null }>;
        return hosts.some(
          (h) => h.origin === "enrolled" && h.baseUrl === `http://127.0.0.1:${agentPort}`,
        );
      });

      // No manual token was ever configured — the enrolled host's ONLY
      // credential is the session the primary just issued it. Proxying a
      // real call through confirms the whole loop actually works, not just
      // that a row appeared.
      const hostsRes = await primary.app.inject({ method: "GET", url: "/api/hosts" });
      const enrolled = (hostsRes.json() as Array<{ id: string; origin: string }>).find(
        (h) => h.origin === "enrolled",
      )!;
      const discoverRes = await primary.app.inject({
        method: "GET",
        url: `/api/projects/discover?hostId=${enrolled.id}`,
      });
      expect(discoverRes.statusCode).toBe(200);
    } finally {
      await agent.app.close();
    }
  });

  // The credential-separation invariant (D1 in the plan): a leaked
  // MULLION_ENROLLMENT_TOKEN must not become a skeleton key for the
  // fleet's /internal/* APIs. Must be a test, not a convention.
  it("rejects MULLION_ENROLLMENT_TOKEN itself as an inbound /internal/* bearer token", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    try {
      // Race-free regardless of whether this agent has already completed
      // its own registration in the background: the enrollment token was
      // never a valid inbound credential at any point in that process, only
      // an outbound bootstrap one.
      const res = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: { authorization: "Bearer fleet-wide-secret" }, // pragma: allowlist secret
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await agent.app.close();
    }
  });

  it("an agent's own current session id IS accepted as an inbound /internal/* bearer token once registered — but ONLY when properly signed (issue #249 / roadmap 7.5)", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    try {
      await waitUntil(() => agent.app.agentSession !== undefined);
      const { sessionId, sessionSecret } = agent.app.agentSession!;

      // The discriminating case (Hermes/advisor's own framing): a session id
      // presented as a bare bearer token, with NO signature headers at all,
      // must be rejected — this is what actually separates "signature
      // required whenever a session credential matched" from a
      // presence-driven check a leaked session id could just omit.
      const unsigned = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: { authorization: `Bearer ${sessionId}` },
      });
      expect(unsigned.statusCode).toBe(401);

      // Correctly signed, it IS accepted — proving the session id is a
      // genuinely valid credential, not that the route is unreachable.
      const timestamp = String(Date.now());
      const nonce = "test-nonce-1";
      const canonicalString = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/discover",
        timestamp,
        nonce,
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      const signed = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${sessionId}`,
          [SIGNATURE_HEADER]: sign(sessionSecret, canonicalString),
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      expect(signed.statusCode).toBe(200);

      // The SAME nonce replayed must be rejected, even though the signature
      // itself is still valid.
      const replayed = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${sessionId}`,
          [SIGNATURE_HEADER]: sign(sessionSecret, canonicalString),
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      expect(replayed.statusCode).toBe(401);

      // A structurally-valid-looking but wrong-secret signature must be
      // rejected too — not just obviously-garbage input.
      const forgedCanonical = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/discover",
        timestamp: String(Date.now()),
        nonce: "test-nonce-forged",
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      const forged = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${sessionId}`,
          [SIGNATURE_HEADER]: sign("wrong-secret-entirely", forgedCanonical),
          [TIMESTAMP_HEADER]: String(Date.now()),
          [NONCE_HEADER]: "test-nonce-forged",
        },
      });
      expect(forged.statusCode).toBe(401);

      // A stale timestamp, correctly signed for THAT stale timestamp, must
      // still be rejected — the drift window is enforced regardless of
      // signature validity.
      const staleTimestamp = String(Date.now() - 60_000);
      const staleNonce = "test-nonce-stale";
      const staleCanonical = buildCanonicalString({
        method: "GET",
        requestTarget: "/internal/discover",
        timestamp: staleTimestamp,
        nonce: staleNonce,
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      const stale = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${sessionId}`,
          [SIGNATURE_HEADER]: sign(sessionSecret, staleCanonical),
          [TIMESTAMP_HEADER]: staleTimestamp,
          [NONCE_HEADER]: staleNonce,
        },
      });
      expect(stale.statusCode).toBe(401);
    } finally {
      await agent.app.close();
    }
  });

  it("a manually-registered static-token host is completely unaffected by any of this (regression)", async () => {
    // No MULLION_PRIMARY_URL/MULLION_ENROLLMENT_TOKEN at all — the exact
    // shape of "a manual host today," proving agentEnrollmentPlugin's early
    // return leaves this path byte-for-byte unchanged.
    const agent = await buildAndListen({
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: "manual-static-token",
      PROJECTS_ROOTS: os.tmpdir(),
    });
    try {
      const created = await primary.app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "manual-regression",
          baseUrl: `http://127.0.0.1:${agent.port}`,
          token: "manual-static-token",
        },
      });
      expect(created.statusCode).toBe(201);
      const hostId = created.json().id as string;

      const res = await primary.app.inject({
        method: "GET",
        url: `/api/projects/discover?hostId=${hostId}`,
      });
      expect(res.statusCode).toBe(200);

      // No session was ever established for this one.
      const rejectedRes = await agent.app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(rejectedRes.statusCode).toBe(401);
    } finally {
      await agent.app.close();
    }
  });

  // Issue #249 / roadmap 7.5 — the highest-complexity part of this feature
  // per the phase plan: 3 of the 5 non-request() signing sites are WS
  // upgrades, where only the `ws` package's client (not the browser
  // WebSocket) can carry a signature header, and the signature can only
  // ever cover the upgrade request itself. This proves the real thing end
  // to end: RemoteHostClient.openAttach()'s signature is actually accepted
  // by internal.ts's real onRequest/preValidation verification, through an
  // actual WS handshake over the primary's own /ws/terminal proxy — not
  // just that each side's logic is independently correct in isolation.
  it("a session-credentialed host's WS terminal attach succeeds through the primary's own /ws/terminal proxy (signed WS upgrade, end to end)", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    try {
      await waitUntil(() => agent.app.agentSession !== undefined);
      const hostsRes = await primary.app.inject({ method: "GET", url: "/api/hosts" });
      const hostId = (hostsRes.json() as Array<{ id: string; baseUrl: string | null }>).find(
        (h) => h.baseUrl === `http://127.0.0.1:${agentPort}`,
      )!.id;

      const projectRes = await primary.app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "ws-attach-session-host", cwd: "/tmp/remote-ws-project", hostId },
      });
      expect(projectRes.statusCode).toBe(201);
      const projectId = projectRes.json().id as number;

      const before = fakePtyChildren.length;
      const created = await primary.app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().id as number;
      await waitUntil(() => fakePtyChildren.length > before);

      const ws = new WebSocket(`ws://127.0.0.1:${primary.port}/ws/terminal?sessionId=${sessionId}`);
      const outcome = await new Promise<"open" | "close">((resolve) => {
        ws.addEventListener("open", () => resolve("open"), { once: true });
        ws.addEventListener("close", () => resolve("close"), { once: true });
        ws.addEventListener("error", () => resolve("close"), { once: true });
      });
      // A forged/unsigned/wrong signature would have this upgrade rejected
      // (internal.ts's onRequest fires before the upgrade completes) —
      // "open" here specifically proves the agent accepted the signature
      // RemoteHostClient.openAttach() actually sent.
      expect(outcome).toBe("open");
      ws.close();
    } finally {
      await agent.app.close();
    }
  });

  // Independent review, PR #531: the positive WS-attach test above only
  // proves a CORRECTLY signed upgrade is accepted; it doesn't prove a
  // forged/missing one is rejected before attachSocketToSession ever spawns
  // a session. /internal/ws/attach runs `${SHELL} -lc "<command>"` for any
  // request bearing a valid credential (docs/multi-host.md) — a bypass here
  // specifically is arbitrary command execution, so this connects directly
  // to the agent's own WS endpoint (bypassing RemoteHostClient, which
  // always signs correctly) to prove a bad signature closes the connection
  // before any PTY is spawned.
  it("a session-credentialed agent rejects /internal/ws/attach with a missing or forged signature, without spawning a session", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    try {
      await waitUntil(() => agent.app.agentSession !== undefined);
      const { sessionId } = agent.app.agentSession!;
      const before = fakePtyChildren.length;

      const query = "id=s-forged&cwd=%2Ftmp&command=bash&cols=80&rows=24";
      const requestTarget = `/internal/ws/attach?${query}`;

      // No signature headers at all — the discriminating case for a WS
      // upgrade, same as the plain-GET one already covered for HTTP.
      const unsigned = new NodeWebSocket(`ws://127.0.0.1:${agentPort}${requestTarget}`, {
        headers: { authorization: `Bearer ${sessionId}` },
      });
      const unsignedOutcome = await new Promise<"open" | "close">((resolve) => {
        unsigned.once("open", () => resolve("open"));
        unsigned.once("close", () => resolve("close"));
        unsigned.once("unexpected-response", () => resolve("close"));
        unsigned.once("error", () => resolve("close"));
      });
      expect(unsignedOutcome).toBe("close");

      // Structurally valid but wrong-secret signature.
      const timestamp = String(Date.now());
      const nonce = "forged-ws-nonce";
      const canonicalString = buildCanonicalString({
        method: "GET",
        requestTarget,
        timestamp,
        nonce,
        bodyHashed: true,
        bodyHash: hashBody(""),
      });
      const forged = new NodeWebSocket(`ws://127.0.0.1:${agentPort}${requestTarget}`, {
        headers: {
          authorization: `Bearer ${sessionId}`,
          [SIGNATURE_HEADER]: sign("wrong-secret-entirely", canonicalString),
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      const forgedOutcome = await new Promise<"open" | "close">((resolve) => {
        forged.once("open", () => resolve("open"));
        forged.once("close", () => resolve("close"));
        forged.once("unexpected-response", () => resolve("close"));
        forged.once("error", () => resolve("close"));
      });
      expect(forgedOutcome).toBe("close");

      // Neither attempt reached attachSocketToSession's getOrCreate — no
      // new PTY was ever spawned.
      expect(fakePtyChildren.length).toBe(before);
    } finally {
      await agent.app.close();
    }
  });
});

describe("graceful agent deregistration (issue #248 / roadmap 7.3)", () => {
  const deregisterPrimaryDb = path.join(
    os.tmpdir(),
    `multi-host-deregister-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
  );

  async function reserveFreePort(): Promise<number> {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        srv.close(() => {
          if (address === null || typeof address === "string") {
            reject(new Error("expected a real bound address"));
          } else {
            resolve(address.port);
          }
        });
      });
    });
  }

  let primary: Awaited<ReturnType<typeof buildAndListen>>;

  beforeAll(async () => {
    fs.rmSync(deregisterPrimaryDb, { force: true });
    primary = await buildAndListen({
      DATABASE_URL: `file:${deregisterPrimaryDb}`,
      MULLION_ENROLLMENT_SECRET: "fleet-wide-secret", // pragma: allowlist secret
    });
  });

  afterAll(async () => {
    await primary.app.close();
    fs.rmSync(deregisterPrimaryDb, { force: true });
  });

  it("a self-registered agent's SIGTERM-equivalent shutdown (app.close()) reflects as offline without waiting on the heartbeat sweep", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    await waitUntil(() => agent.app.agentSession !== undefined);
    const hostId = agent.app.agentSession!.hostId;

    // server.ts's real shutdown path is `await app.close()` — this
    // exercises the exact same onClose hook chain, including the awaitable
    // deregister call.
    await agent.app.close();

    await waitUntil(async () => {
      const res = await primary.app.inject({ method: "GET", url: "/api/hosts" });
      const host = (res.json() as Array<{ id: string; health: string }>).find(
        (h) => h.id === hostId,
      );
      return host?.health === "offline";
    });
  });

  it("does not delete the host row or terminate its projects — status-only, sessions survive the restart", async () => {
    const agentPort = await reserveFreePort();
    const agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_PRIMARY_URL: `http://127.0.0.1:${primary.port}`,
        MULLION_ENROLLMENT_TOKEN: "fleet-wide-secret", // pragma: allowlist secret
        MULLION_AGENT_ADVERTISE_URL: `http://127.0.0.1:${agentPort}`,
        PROJECTS_ROOTS: os.tmpdir(),
      },
      agentPort,
    );
    await waitUntil(() => agent.app.agentSession !== undefined);
    const hostId = agent.app.agentSession!.hostId;

    const created = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "survives-deregister", cwd: os.tmpdir(), hostId },
    });
    expect(created.statusCode).toBe(201);

    await agent.app.close();

    const hostsRes = await primary.app.inject({ method: "GET", url: "/api/hosts" });
    expect((hostsRes.json() as Array<{ id: string }>).some((h) => h.id === hostId)).toBe(true);

    const projectsRes = await primary.app.inject({ method: "GET", url: "/api/projects" });
    expect(
      (projectsRes.json() as Array<{ name: string }>).some((p) => p.name === "survives-deregister"),
    ).toBe(true);
  });

  it("a manually-registered static-token host has no deregistration path and degrades to heartbeat-only detection with no error", async () => {
    const agent = await buildAndListen({
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: "manual-static-token-deregister",
      PROJECTS_ROOTS: os.tmpdir(),
    });
    const created = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: "manual-deregister-regression",
        baseUrl: `http://127.0.0.1:${agent.port}`,
        token: "manual-static-token-deregister",
      },
    });
    const hostId = created.json().id as string;

    // No agentSession was ever established — nothing to deregister with.
    expect(agent.app.agentSession).toBeUndefined();

    // Must resolve cleanly (no hang, no throw) even though there's no
    // session credential to present.
    await expect(agent.app.close()).resolves.toBeUndefined();

    // No status jump — the row is untouched, still whatever the heartbeat
    // tracker last said (pending, since no sweep has targeted it yet in
    // this test).
    const hostsRes = await primary.app.inject({ method: "GET", url: "/api/hosts" });
    const host = (hostsRes.json() as Array<{ id: string; health: string }>).find(
      (h) => h.id === hostId,
    );
    expect(host?.health).toBe("pending");
  });
});
