import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as childProcessSpawn } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { gitEnv } from "../../src/services/git-env.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  buildCanonicalString,
  hashBody,
  sign,
} from "../../src/services/request-signature.js";
import { taskReviewFindingsPath, taskCommitTitlePath } from "../../src/services/task-prompt.js";
import { sessionBriefingPath } from "../../src/services/project-briefing.js";
import { sessionWorkflowConventionsPath } from "../../src/services/workflow-conventions.js";

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

// Perf audit finding B8(2) — PtyManager.isMasterAliveBatch replies with
// `systemctl --user list-units ... crs-session-*.scope`, one call for the
// whole batch, instead of one `is-active` spawn per id. Unlike is-active
// (which the mock below always answers "active" for regardless of which
// unit was asked about — "this suite asserts response shape, not
// session-reconciler-style semantics"), list-units has no per-unit
// argument to echo back: its answer is a real inventory of what's
// currently active. Track that inventory here, populated by the same
// `systemd-run -u <unit>` spawns bootstrapMaster makes below, so
// list-units' fake reply matches whichever sessions this test file has
// actually "spawned" so far.
const activeScopeUnits = new Set<string>();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[] = [], options?: unknown) => {
      // `git` (git-status.ts, issues #76/#96) is passed straight through to
      // the real implementation rather than faked — unlike
      // systemctl/systemd-run/agent-detect's shell probe below, this suite
      // actually asserts on real git output (branch/isClean), and a real
      // temp repo is cheap to spin up in these tests.
      if (file === "git") {
        return actual.spawn(file, args, options as ChildProcess.SpawnOptions);
      }

      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter; unref?: () => void };
      // A real ChildProcess has .unref() (spawnSelfUpdate, issue #647, calls
      // it right after .on("error", ...) — same pty-manager.ts
      // bootstrapMaster convention every systemd-run spawn in this repo
      // follows); a bare EventEmitter doesn't. Without this, that call
      // throws synchronously INSIDE the route handler, which — critically —
      // happens before the throwing test's own `await app.close()` ever
      // runs, leaking that test's hooks socket and cascading into
      // SocketAlreadyListeningError failures for every test after it in
      // this file.
      ee.unref = () => {};

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

      // PtyManager.isMasterAliveBatch: `systemctl --user list-units --type=scope
      // --state=active --no-legend --plain crs-session-*.scope`. Reports
      // exactly the units activeScopeUnits currently tracks (see its own
      // comment above), in the real `--plain --no-legend` UNIT LOAD ACTIVE
      // SUB DESCRIPTION shape (only the first field is actually parsed).
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

      // PtyManager.stopScope (terminate): only waits on 'exit'.
      if (file === "systemctl" && args[1] === "stop") {
        const unit = args[2];
        if (unit) activeScopeUnits.delete(unit);
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

// Real PNG signature bytes — /internal/uploads now checks the body's actual
// magic bytes against the declared mime (issue #68 hardening), not just the
// Content-Type header, so a happy-path upload test needs a real signature,
// not an arbitrary string.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

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

// The near side (this test's own client) can finish its handshake with the
// agent before the agent's own upstream connection to the loopback stub
// has — pipeWsFrames deliberately drops (not queues) a message sent before
// the upstream is OPEN, same tradeoff as terminal.ts's own
// proxyToRemoteAttach. Retrying the send until a response arrives, rather
// than sending once and awaiting a fixed delay, is this repo's existing
// convention for this exact gap (see preview-ws-proxy.test.ts's own
// identical helper).
function sendUntilEcho(ws: NodeWebSocket, message: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const onMessage = (data: Buffer) => {
      clearInterval(interval);
      resolve(data.toString());
    };
    ws.once("message", onMessage);
    const interval = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(interval);
        ws.off("message", onMessage);
        reject(new Error("no response received before timeout"));
        return;
      }
      if (ws.readyState === NodeWebSocket.OPEN) ws.send(message);
    }, 20);
  });
}

describe("internal routes (agent role, issue #26)", () => {
  let projectsRoot: string;
  // #819/#822 SSH-agent follow-up (Hermes review, PR #828) — the
  // "sshAuthSock: null" assertion below assumes MULLION_SSH_AUTH_SOCK is
  // unset in the ambient process env. That's true in CI, but not
  // guaranteed everywhere this feature is actually deployed (e.g. a shell
  // on mgmt with it exported) — save/restore rather than trust ambient
  // absence, same posture as the MULLION_ROLE/TOKEN/PROJECTS_ROOTS vars
  // just below.
  let prevSshAuthSock: string | undefined;
  // Issue #820 PR5d — resolveSshAuthSock's ambient tier reads this
  // process's own SSH_AUTH_SOCK, so it needs the same save/restore
  // treatment as MULLION_SSH_AUTH_SOCK above for the same reason: this
  // suite must not silently pass or fail depending on whether the shell
  // that happens to run it has a real ssh-agent exported.
  let prevAmbientSshAuthSock: string | undefined;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-discover-root-"));
    fs.mkdirSync(path.join(projectsRoot, "git-repo", ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(projectsRoot, "git-repo", ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:s3ntin3l8/mullion-session-manager.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
    prevSshAuthSock = process.env.MULLION_SSH_AUTH_SOCK;
    delete process.env.MULLION_SSH_AUTH_SOCK;
    prevAmbientSshAuthSock = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
    if (prevSshAuthSock === undefined) delete process.env.MULLION_SSH_AUTH_SOCK;
    else process.env.MULLION_SSH_AUTH_SOCK = prevSshAuthSock;
    if (prevAmbientSshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = prevAmbientSshAuthSock;
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

  // Issue #247 / roadmap 7.4. Issue #820 PR5d — sshAuthSock is no longer
  // unconditionally null here: with MULLION_SSH_AUTH_SOCK and ambient
  // SSH_AUTH_SOCK both unset (this describe block's own beforeAll), the
  // agent role falls back to the bridge-materialized socket
  // (resolveSshAuthSock's tier 3) — and sshAgentPlugin has genuinely bound
  // that socket by the time this request runs, so `present` is true, not
  // a dangling-path case.
  it("returns this agent's own effective config, with no idle timeout (that's DB-backed on the primary)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/config",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      role: "agent",
      projectsRoots: [projectsRoot],
      sessionsDir: app.config.SESSIONS_DIR,
      crsConfigDir: app.config.CRS_CONFIG_DIR,
      browserEnabled: app.config.BROWSER_ENABLED,
    });
    expect(body.sshAuthSock).toEqual({
      path: path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock"),
      present: true,
      source: "bridge",
    });
    expect(typeof body.version).toBe("string");
    expect(body).not.toHaveProperty("idleTimeout");
    await app.close();
  });

  // #819/#822 SSH-agent follow-up — the dangling-socket case is the
  // expected steady state whenever the far end (an `ssh -R` tunnel) is
  // offline, not an error, so this must surface as `present: false`
  // rather than throwing or omitting the field.
  it("reports sshAuthSock present/absent from a live existsSync check, not just the configured path", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-"));
    const presentSockPath = path.join(socketDir, "agent.sock");
    fs.writeFileSync(presentSockPath, "");
    const absentSockPath = path.join(socketDir, "does-not-exist.sock");

    try {
      process.env.MULLION_SSH_AUTH_SOCK = presentSockPath;
      const presentApp = await buildApp();
      const presentRes = await presentApp.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(presentRes.json().sshAuthSock).toEqual({
        path: presentSockPath,
        present: true,
        source: "configured",
      });
      await presentApp.close();

      process.env.MULLION_SSH_AUTH_SOCK = absentSockPath;
      const absentApp = await buildApp();
      const absentRes = await absentApp.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(absentRes.json().sshAuthSock).toEqual({
        path: absentSockPath,
        present: false,
        source: "configured",
      });
      await absentApp.close();
    } finally {
      delete process.env.MULLION_SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // Issue #820 PR7a — before this, the ambient tier reported `sshAuthSock:
  // null`, identical to genuinely having nothing configured at all
  // (resolveSshAuthSock's "none" tier). Settings > Hosts needs to tell
  // these apart, so the ambient tier now reports the inherited path itself
  // (not the bridge/configured path — there isn't one; Mullion isn't
  // supplying this value) tagged `source: "ambient"`.
  it("reports the ambient SSH_AUTH_SOCK itself, tagged source: ambient — distinct from the null 'nothing configured' case", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-ambient-"));
    const ambientSockPath = path.join(socketDir, "keyring-agent.sock");
    fs.writeFileSync(ambientSockPath, "");

    try {
      process.env.SSH_AUTH_SOCK = ambientSockPath;
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().sshAuthSock).toEqual({
        path: ambientSockPath,
        present: true,
        source: "ambient",
      });
      await app.close();
    } finally {
      delete process.env.SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // #819/#822 SSH-agent follow-up — pty-manager.ts's PtyManager resolves a
  // relative MULLION_SSH_AUTH_SOCK once, at construction (its own comment:
  // "a relative MULLION_SSH_AUTH_SOCK would resolve against a different ...
  // directory instead of the single stable path this feature depends on").
  // This diagnostic must report that same resolved path, not the raw
  // relative string — otherwise it would show an operator a path that
  // doesn't match what sessions actually receive, and existsSync would run
  // against the wrong location (this process's cwd) rather than a
  // guaranteed-stable one.
  it("resolves a relative MULLION_SSH_AUTH_SOCK the same way PtyManager does, not the raw string", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-relative-"));
    const sockPath = path.join(socketDir, "agent.sock");
    fs.writeFileSync(sockPath, "");
    const relativeSockPath = path.relative(process.cwd(), sockPath);

    try {
      process.env.MULLION_SSH_AUTH_SOCK = relativeSockPath;
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().sshAuthSock).toEqual({
        path: sockPath,
        present: true,
        source: "configured",
      });
      await app.close();
    } finally {
      delete process.env.MULLION_SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // Issue #647 / roadmap 7.8 — the agent-side counterpart to
  // test/routes/updates.test.ts's own suite. Deliberately mirrors that
  // file's fixtures (VALID_ASSET_URL/VALID_CHECKSUM_URL, a per-test
  // mkdtemp MULLION_HOME) rather than sharing them, since these routes are
  // reached over a different mount point (/internal/updates/* — see this
  // file's own onRequest gate above) with a different auth requirement.
  describe("self-update (issue #647 / roadmap 7.8)", () => {
    const VALID_ASSET_URL =
      "https://github.com/s3ntin3l8/mullion-session-manager/releases/download/v0.1.5/mullion-0.1.5.tgz";
    const VALID_CHECKSUM_URL =
      "https://github.com/s3ntin3l8/mullion-session-manager/releases/download/v0.1.5/mullion-0.1.5.tgz.sha256";
    let mullionHome: string;

    beforeEach(() => {
      mullionHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-updates-test-home-"));
    });

    afterEach(() => {
      delete process.env.MULLION_HOME;
      fs.rmSync(mullionHome, { recursive: true, force: true });
    });

    it("rejects GET /internal/updates/status with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/internal/updates/status" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects POST /internal/updates/apply with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("reports 'unavailable' from GET /internal/updates/status when MULLION_HOME is unset", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/updates/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ phase: "unavailable" });
      await app.close();
    });

    it("reflects the current contents of .update-status.json", async () => {
      process.env.MULLION_HOME = mullionHome;
      fs.writeFileSync(
        path.join(mullionHome, ".update-status.json"),
        JSON.stringify({ phase: "restarting", version: "0.1.5", updatedAt: 12345 }),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/updates/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toMatchObject({ phase: "restarting", version: "0.1.5" });
      await app.close();
    });

    it("rejects a malformed body (bad version pattern) on POST /internal/updates/apply", async () => {
      process.env.MULLION_HOME = mullionHome;
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          version: "not-a-version",
          assetUrl: VALID_ASSET_URL,
          checksumUrl: VALID_CHECKSUM_URL,
        },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("refuses when MULLION_HOME is unset", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("launches self-update.sh detached via systemd-run and returns 202", async () => {
      process.env.MULLION_HOME = mullionHome;
      const scriptDir = path.join(mullionHome, "current", "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(path.join(scriptDir, "self-update.sh"), "#!/usr/bin/env bash\n");
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ phase: "downloading", version: "0.1.5" });
      // The shared node:child_process mock at the top of this file tracks
      // every "systemd-run -u <unit> ..." call's unit name in
      // activeScopeUnits — reused here rather than adding a second spy on
      // the same mocked spawn().
      expect(activeScopeUnits.has("mullion-update-0.1.5.scope")).toBe(true);
      await app.close();
    });
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

  it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-outside-roots-"));

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  // Issue #604 — resolveWithinRoots used to compare only the LEXICAL cwd
  // against PROJECTS_ROOTS, so a symlink planted inside a root (something
  // an authenticated caller with filesystem access to a project could do)
  // passed the containment check on its lexical path even though it points
  // straight outside every configured root. Before the fix this cwd would
  // have 200'd (following the symlink transparently); the fix compares
  // realpath'd paths instead, so this must now 400 exactly like the
  // "outside PROJECTS_ROOTS" case above.
  it("rejects a cwd that is a symlink inside PROJECTS_ROOTS pointing outside it (issue #604)", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-symlink-escape-"));
    const escapeLink = path.join(projectsRoot, "escape-link");
    fs.symlinkSync(outsideRoots, escapeLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(escapeLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).toBe(400);

      const dock = await app.inject({
        method: "GET",
        url: `/internal/dock?cwd=${encodeURIComponent(escapeLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(dock.statusCode).toBe(400);
    } finally {
      fs.rmSync(escapeLink, { force: true });
      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    }
  });

  // The other direction: a symlink INSIDE a legitimate project dir, still
  // resolving to somewhere INSIDE that same PROJECTS_ROOTS entry, must stay
  // accepted — the realpath-based check must not reject ordinary intra-root
  // symlinks the way it now rejects an escaping one.
  it("still accepts a cwd whose symlink resolves to somewhere inside the same PROJECTS_ROOTS entry", async () => {
    const app = await buildApp();
    const realProject = path.join(projectsRoot, "real-project");
    fs.mkdirSync(realProject, { recursive: true });
    const innerLink = path.join(projectsRoot, "inner-link");
    fs.symlinkSync(realProject, innerLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(innerLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).toBe(200);
    } finally {
      fs.rmSync(innerLink, { force: true });
      fs.rmSync(realProject, { recursive: true, force: true });
      await app.close();
    }
  });

  // Hermes review, PR #612: a DANGLING cwd symlink (the link exists, its
  // target doesn't) is the trickiest case realpathExistingPrefix's ENOENT
  // fallback handles — fs.realpathSync itself throws ENOENT resolving a
  // dangling link (not just a genuinely missing path), so this hits the
  // exact same "doesn't exist yet, fall back to lexical" branch a brand-new
  // project would. Containment passes on the lexical value (same as before
  // this fix, since there's nothing to realpath through), but every
  // downstream sink fails closed reading a target that doesn't exist —
  // nothing escapes, this just pins that no request-shaped input here
  // crashes with a 500.
  it("handles a DANGLING cwd symlink inside PROJECTS_ROOTS without erroring or leaking anything", async () => {
    const app = await buildApp();
    const danglingLink = path.join(projectsRoot, "dangling-link");
    fs.symlinkSync(path.join(projectsRoot, "nonexistent-target"), danglingLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(danglingLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).not.toBe(500);

      const dock = await app.inject({
        method: "GET",
        url: `/internal/dock?cwd=${encodeURIComponent(danglingLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(dock.statusCode).not.toBe(500);
    } finally {
      fs.rmSync(danglingLink, { force: true });
      await app.close();
    }
  });

  // U4 — the agent-side half of the dock-config write triple
  // (routes/dock-config.ts is the primary side). Same
  // resolveWithinRoots-containment shape as /internal/actions and
  // /internal/dock above, and the same CodeQL js/path-injection concern
  // those two already have a test for — GitHub Advanced Security flagged
  // this exact new file (dock-config.ts) on the PR that introduced it;
  // this proves the containment gate is real, executing code, not just a
  // comment claiming it is.
  describe("/internal/dock-config (U4, CodeQL: uncontrolled data in path expression)", () => {
    it("requires a cwd query param for both GET and PUT", async () => {
      const app = await buildApp();
      const get = await app.inject({
        method: "GET",
        url: "/internal/dock-config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(400);

      const put = await app.inject({
        method: "PUT",
        url: "/internal/dock-config",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [] },
      });
      expect(put.statusCode).toBe(400);
      await app.close();
    });

    it("resolves and writes dock.json for a cwd on this host", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const get = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({
        controls: [],
        invalid: false,
        reason: null,
        isSymlink: false,
      });

      const put = await app.inject({
        method: "PUT",
        url: `/internal/dock-config?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".crs", "dock.json"), "utf8"))).toEqual({
        controls: [{ id: "x", title: "X", command: "echo x" }],
      });
      fs.rmSync(path.join(cwd, ".crs"), { recursive: true, force: true });
      await app.close();
    });

    // The concrete proof the coordinator asked for: a cwd outside this
    // agent's own PROJECTS_ROOTS must be rejected before it ever reaches
    // dock-config.ts's readDockConfig/writeDockConfig — for BOTH verbs,
    // and PUT must not have written anything to that outside directory.
    it("rejects a cwd outside this agent's own PROJECTS_ROOTS for both GET and PUT, and never writes", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-dock-config-outside-"));

      const get = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(400);

      const put = await app.inject({
        method: "PUT",
        url: `/internal/dock-config?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(put.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, ".crs"))).toBe(false);

      // A "../" traversal attempt riding on an otherwise-in-roots cwd must
      // resolve (path.resolve collapses ".." segments) to a path that's
      // STILL checked against PROJECTS_ROOTS, not escape the check via the
      // literal ".." substring.
      const traversal = `${path.join(projectsRoot, "git-repo")}/../../../../../../etc`;
      const traversalGet = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(traversal)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(traversalGet.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });
  });

  // Issue #431 — the agent-side half of the agent-rules triple
  // (routes/agent-rules.ts is the primary side). Global-scope targets
  // resolve off os.homedir(), redirected here the same way
  // test/services/agent-rules.test.ts does, so this never touches the
  // real test-runner's own ~/.claude etc.
  describe("/internal/agent-rules (issue #431)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/agent-rules",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS (CodeQL: this route WRITES, unlike the read-only ones above)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-outside-"));

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(400);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "malicious" },
      });
      expect(write.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, "CLAUDE.md"))).toBe(false);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists, writes, and deletes a target for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(200);
      expect(Array.isArray(list.json())).toBe(true);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "written via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("written via internal route");
      expect(fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8")).toBe(
        "written via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — this route used to reject a
    // global-scope target id here, which for a remote-hosted project's
    // global CLAUDE.md/AGENTS.md forced the primary through a standalone,
    // primary-host-only route instead — silently writing to the *primary's*
    // filesystem, not this (remote) host's. `cwd` is still confined to
    // PROJECTS_ROOTS, but it's unused for a global-scope target (which
    // resolves off this host's own redirected HOME instead).
    it("writes and deletes a global-scope target id on the project-scoped write/delete routes, resolved on this host's own HOME", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "global content via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("global content via internal route");
      expect(fs.readFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "global content via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(fakeHome, ".claude", "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    it("400s on a malformed body (missing content) via the new schema", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");
      const res = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — the names-only counterpart the
    // sidebar's per-project indicator uses instead of the full listing.
    describe("/internal/agent-rules/exists", () => {
      it("requires a cwd query param", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/internal/agent-rules/exists",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("rejects a cwd outside PROJECTS_ROOTS", async () => {
        const app = await buildApp();
        const outsideRoots = fs.mkdtempSync(
          path.join(os.tmpdir(), "internal-agent-rules-exists-outside-"),
        );
        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(outsideRoots)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        fs.rmSync(outsideRoots, { recursive: true, force: true });
        await app.close();
      });

      it("returns only existing project-scope filenames, never content", async () => {
        const app = await buildApp();
        const cwd = fs.mkdtempSync(path.join(projectsRoot, "exists-test-"));
        fs.writeFileSync(path.join(cwd, "AGENTS.md"), "should not appear in the response");

        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(cwd)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(["AGENTS.md"]);
        expect(res.payload).not.toContain("should not appear");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });

  // Issue #432 — the agent-side half of the skills-discovery triple
  // (routes/skills.ts is the primary side). Same fake-HOME redirection
  // reasoning as /internal/agent-rules above.
  describe("/internal/skills (issue #432)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    function writeSkill(dir: string, name: string, description: string) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
      );
    }

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/skills",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-outside-"));

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists project- and global-scope skills for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "skills-repo");
      writeSkill(path.join(cwd, ".claude", "skills", "proj-skill"), "proj-skill", "in the repo");
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "home-skill"),
        "home-skill",
        "in the home dir",
      );

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const byName = Object.fromEntries(
        res.json().map((s: { name: string; scope: string }) => [s.name, s]),
      );
      expect(byName["proj-skill"].scope).toBe("project");
      expect(byName["home-skill"].scope).toBe("global");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });

  it("rejects a session id that isn't a plain alphanumeric token", async () => {
    const app = await buildApp();

    const terminateRes = await app.inject({
      method: "POST",
      url: `/internal/sessions/${encodeURIComponent("weird;id")}/terminate`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(400);

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "weird id", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(400);

    await app.close();
  });

  it("resolves a github.com owner/repo from this host's own .git/config (issue #27)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: "s3ntin3l8", repo: "mullion-session-manager" });
    await app.close();
  });

  it("resolves null for a repo with no github.com origin remote", async () => {
    // A separate root (not projectsRoot) so this bare repo never shows up
    // as an extra candidate in the "discovers candidates" test's exact
    // single-entry assertion above.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bare-root-"));
    fs.mkdirSync(path.join(bareRoot, "bare-repo", ".git"), { recursive: true });
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = bareRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(path.join(bareRoot, "bare-repo"))}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(bareRoot, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for github-repo, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/github-repo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-github-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves the current branch from this host's own HEAD (issue #96)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe("main");
    await app.close();
  });

  it("requires a cwd query param for git-branch, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branch",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branch-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves git status from this host's own filesystem (issue #76)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, status } — not a bare GitStatus — so the primary can tell
    // "not a repo" apart from "repo exists but git status failed
    // transiently" for a remote host the same way it already can locally
    // (isGitRepo/getGitStatus).
    expect(res.json()).toMatchObject({
      isRepo: true,
      status: { branch: "main", isClean: true },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a directory that isn't a git repo (issue #76)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, status: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-status, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-status",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves diff stats from this host's own filesystem (issue #202)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\ntwo\n");

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, stats } — same shape as /internal/git-status's own
    // { isRepo, status }, for the same "durable vs. transient" reason.
    expect(res.json()).toEqual({
      isRepo: true,
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a git-diff cwd that isn't a git repo (issue #202)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, stats: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-diff, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-diff",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves branches and worktrees from this host's own filesystem (issue #162)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["branch", "feature/foo"], { cwd, stdio: "pipe", env: gitEnv() });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // objectContaining, not exact equality — issue #442 adds unconditional
    // enrichment fields (lastCommitRelative etc.) to every branch entry.
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "main", isCurrent: true }),
    );
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "feature/foo", isCurrent: false }),
    );
    expect(body.branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined)).toBe(true);
    expect(body.worktrees).toEqual([{ path: cwd, branch: "main", isMain: true }]);

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("resolves isMerged when ?detail=1 is set (issue #442)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-detail-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    run(["add", "-A"]);
    run(["commit", "-m", "initial", "--no-verify"]);
    run(["checkout", "-b", "merged-branch"]);
    run(["checkout", "main"]);
    run(["merge", "merged-branch", "--no-edit"]);

    const remoteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "internal-git-branches-detail-origin-"),
    );
    run(["remote", "add", "origin", remoteDir]);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: remoteDir,
      stdio: "pipe",
      env: gitEnv(),
    });
    run(["push", "-u", "origin", "main"]);

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}&detail=1`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branches.find((b: { name: string }) => b.name === "merged-branch").isMerged).toBe(
      true,
    );

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-branches, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branches",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  describe("POST /internal/git-worktree/remove, /clear-orphan, and /prune (issue #283)", () => {
    async function makeTaskWorktreeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-worktree-remove-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      // Branch uses the new descriptive shape (mullion/task-<id>-<slug>) —
      // task-claim.ts's TASK_BRANCH_NAME_RE only accepts the slugged form
      // now, so a leftover branch left in this shape is the only one
      // clearOrphanedTaskWorktree / resumeTaskWorktree will recognize.
      const branch = "mullion/task-1-test";
      const worktreePath = path.join(cwd, ".mullion-worktrees", "mullion-task-1-test");
      run(["worktree", "add", "-b", branch, worktreePath, "main"]);
      return { repoRoot, cwd, worktreePath, run, branch };
    }

    it("removes a clean task worktree, but refuses (and leaves in place) a dirty one", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      // Dirty first — refused, still on disk.
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ removed: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      fs.unlinkSync(path.join(worktreePath, "dirty.txt"));
      const cleanRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(cleanRes.statusCode).toBe(200);
      expect(cleanRes.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a worktreePath or parentCwd outside this agent's own PROJECTS_ROOTS", async () => {
      const { repoRoot, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const outsideParent = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: "/etc" },
      });
      expect(outsideParent.statusCode).toBe(400);
      // Untouched by the rejected request.
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes an explicitly-named orphan but skips a dirty one, and rejects an orphanPaths entry outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const pruneRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: [worktreePath] },
      });
      expect(pruneRes.statusCode).toBe(200);
      expect(pruneRes.json()).toEqual({ removed: [worktreePath], skipped: [] });
      expect(fs.existsSync(worktreePath)).toBe(false);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: ["/etc/not-a-project"] },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan removes a clean worktree AND its branch ref, so a fresh worktree add -b at the same path/branch succeeds", async () => {
      const { repoRoot, cwd, worktreePath, run, branch } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: branch },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cleared: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      // The branch is gone too — re-adding a worktree with the same -b
      // branch name at the same path no longer collides.
      expect(() => run(["worktree", "add", "-b", branch, worktreePath, "main"])).not.toThrow();
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan refuses (leaving worktree and branch in place) when the worktree is dirty, and rejects a cwd/worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath, branch } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: branch },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ cleared: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project", branchName: branch },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("Task Master remote-hosted proxy routes (#484)", () => {
    async function makeTaskWorktreeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-484-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      // Same descriptive shape as the other makeTaskWorktreeRepo — see
      // that function's own comment for why.
      const branch = "mullion/task-1-test";
      const worktreePath = path.join(cwd, ".mullion-worktrees", "mullion-task-1-test");
      run(["worktree", "add", "-b", branch, worktreePath, "main"]);
      return { repoRoot, cwd, worktreePath, run, branch };
    }

    it("GET /internal/git-status?fresh=1 bypasses the cache — a change made just before the request is reflected immediately", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-fresh-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      // Prime the 5s cache with a "clean" read.
      const cached = await app.inject({
        method: "GET",
        url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(cached.json()).toMatchObject({ status: { isClean: true } });

      // Dirty the tree — the plain (non-fresh) route would still report the
      // stale cached "clean" result here.
      fs.writeFileSync(path.join(cwd, "b.txt"), "uncommitted");
      const freshRes = await app.inject({
        method: "GET",
        url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}&fresh=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(freshRes.statusCode).toBe(200);
      expect(freshRes.json()).toMatchObject({ isRepo: true, status: { isClean: false } });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-base-ref resolves the default base ref and its pinned SHA on this host's own filesystem", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-root-"));
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-remote-"));
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["remote", "add", "origin", remote]);
      run(["push", "origin", "main"]);
      const expectedSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { env: gitEnv() })
        .toString("utf8")
        .trim();

      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ baseRef: "origin/main", sha: expectedSha });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-base-ref resolves { baseRef: 'HEAD', sha: null } for a non-repo cwd — the same last-resort fallback the local path uses", async () => {
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-not-a-repo-"));
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = notARepo;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(notARepo)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ baseRef: "HEAD", sha: null });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(notARepo, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd query param for git-base-ref, and rejects one outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "GET",
        url: "/internal/git-base-ref",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-base-ref-outside-"));
      const outside = await app.inject({
        method: "GET",
        url: `/internal/git-base-ref?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-push pushes a branch to origin on this host's own filesystem", async () => {
      const { repoRoot, worktreePath, branch } = await makeTaskWorktreeRepo();
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-remote-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: worktreePath,
        stdio: "pipe",
        env: gitEnv(),
      });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: worktreePath, branch, token: "ghp_supersecrettoken" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // The push actually landed — a real bare-repo remote doesn't need the
      // http.extraHeader token at all (that's an https-transport mechanism,
      // see git-push.ts's own header comment), so this confirms the route
      // really runs `git push`, not just plumbing through a mock.
      const branches = execFileSync("git", ["-C", remote, "branch"], { env: gitEnv() }).toString();
      expect(branches).toContain(branch);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-push relays a git-level failure's redacted detail (redaction itself is git-push.test.ts's own coverage) and never echoes the token", async () => {
      const { repoRoot, worktreePath } = await makeTaskWorktreeRepo();
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-remote-fail-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remote,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: worktreePath,
        stdio: "pipe",
        env: gitEnv(),
      });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        // A branch that doesn't exist locally — a deterministic git-level
        // failure with no network involved.
        payload: {
          cwd: worktreePath,
          branch: "mullion/task-does-not-exist",
          token: "ghp_supersecrettoken",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(false);
      expect(body.detail).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain("ghp_supersecrettoken");

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/branch/token body for git-push, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-push-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-push",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, branch: "main", token: "x" },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("GET /internal/git-worktree/task-dirs lists this host's own on-disk task-worktree directories", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "GET",
        url: `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        dirs: [worktreePath],
      });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd query param for git-worktree/task-dirs, and rejects one outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "GET",
        url: "/internal/git-worktree/task-dirs",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-task-dirs-outside-"));
      const outside = await app.inject({
        method: "GET",
        url: `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("POST /internal/git-worktree/resume checks out an EXISTING branch (not -b, not --detach) into a fresh worktree at the deterministic path", async () => {
      const { repoRoot, cwd, worktreePath, run, branch } = await makeTaskWorktreeRepo();
      // Remove the worktree directory but leave the branch — reproduces the
      // exact state `→ failed` cleanup leaves behind (removeWorktreeIfClean
      // never deletes the branch).
      run(["worktree", "remove", "--force", worktreePath]);
      expect(fs.existsSync(worktreePath)).toBe(false);

      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: branch },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: worktreePath, branch });
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("resume resolves null (200, not an error) when the branch no longer exists — restricted to the closed mullion/task-<id> namespace", async () => {
      const { repoRoot, cwd } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const noBranch = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: "mullion/task-999" },
      });
      expect(noBranch.statusCode).toBe(200);
      expect(noBranch.json()).toBeNull();

      const notTaskShaped = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branchName: "main" },
      });
      expect(notTaskShaped.statusCode).toBe(200);
      expect(notTaskShaped.json()).toBeNull();

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/branchName body for git-worktree/resume, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-resume-outside-"));
      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/resume",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: outsideRoots, branchName: "mullion/task-1-test" },
      });
      expect(outside.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET/DELETE /internal/task-review-findings (#760)", () => {
    it("GET returns { content: null } (200, not 404) for a genuinely absent file", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=999&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: null });
      await app.close();
    });

    it("GET returns the trimmed file content when present", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 7, 0);
      fs.writeFileSync(findingsPath, "  ## Round 0\n\nLooks good.  \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=7&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: "## Round 0\n\nLooks good." });

      fs.rmSync(findingsPath, { force: true });
      await app.close();
    });

    it("GET returns { content: null } for a present-but-empty file, same as absent", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 8, 0);
      fs.writeFileSync(findingsPath, "   \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=8&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toEqual({ content: null });

      fs.rmSync(findingsPath, { force: true });
      await app.close();
    });

    it("GET rejects non-integer taskId/round with 400, not a crash", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-review-findings?taskId=abc&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("DELETE removes the file when present, and is a no-op (still 204) when absent", async () => {
      const app = await buildApp();
      const findingsPath = taskReviewFindingsPath(path.dirname(app.pty.hookSocketPath), 9, 0);
      fs.writeFileSync(findingsPath, "content");

      const res = await app.inject({
        method: "DELETE",
        url: "/internal/task-review-findings?taskId=9&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(204);
      expect(fs.existsSync(findingsPath)).toBe(false);

      // Already gone — deleting again must still succeed, not throw.
      const again = await app.inject({
        method: "DELETE",
        url: "/internal/task-review-findings?taskId=9&round=0",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(again.statusCode).toBe(204);

      await app.close();
    });

    // Safety property this route exists to preserve (session-backend.ts's
    // SessionBackend.readTaskReviewFindings doc comment): the path is
    // derived ENTIRELY from this agent's own hookSocketPath plus two
    // numeric identifiers — no cwd, no caller-supplied path fragment at
    // all — so there's nothing here for a traversal attempt to reach.
    it("never accepts a path fragment — taskId/round are the only inputs, both numeric", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/task-review-findings?taskId=${encodeURIComponent("../../etc/passwd")}&round=0`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // #778 — mirrors GET /internal/task-review-findings's own shape/tests
  // exactly (no DELETE counterpart: the commit-title file isn't
  // round-suffixed and is meant to persist across rounds).
  describe("GET /internal/task-commit-title (#778)", () => {
    it("returns { content: null } (200, not 404) for a genuinely absent file", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=999",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: null });
      await app.close();
    });

    it("returns the trimmed file content when present", async () => {
      const app = await buildApp();
      const titlePath = taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), 7);
      fs.writeFileSync(titlePath, "  fix: handle the edge case  \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=7",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ content: "fix: handle the edge case" });

      fs.rmSync(titlePath, { force: true });
      await app.close();
    });

    it("returns { content: null } for a present-but-empty file, same as absent", async () => {
      const app = await buildApp();
      const titlePath = taskCommitTitlePath(path.dirname(app.pty.hookSocketPath), 8);
      fs.writeFileSync(titlePath, "   \n");

      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=8",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toEqual({ content: null });

      fs.rmSync(titlePath, { force: true });
      await app.close();
    });

    it("rejects a non-integer taskId with 400, not a crash", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/task-commit-title?taskId=abc",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("never accepts a path fragment — taskId is the only input, numeric", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/task-commit-title?taskId=${encodeURIComponent("../../etc/passwd")}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("POST /internal/git-worktree/checkout, /force-remove, and /sync (issue #345)", () => {
    async function makeDockPreviewRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-worktree-345-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("checks out an existing branch into a fresh detached-HEAD worktree", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branch).toBe("main");
      expect(path.basename(body.path)).toMatch(/^dock-preview-main-/);
      expect(fs.existsSync(body.path)).toBe(true);
      // Detached HEAD: `git symbolic-ref HEAD` exits non-zero (throws) —
      // exactly what makes the sync tick's `reset --hard` safe alongside
      // `main` checked out elsewhere (see syncWorktree's doc comment).
      const { execFileSync } = await import("node:child_process");
      expect(() =>
        execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
          cwd: body.path,
          stdio: "pipe",
          env: gitEnv(),
        }),
      ).toThrow();

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("returns null (200) for a nonexistent branch, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const badBranch = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "no-such-branch" },
      });
      expect(badBranch.statusCode).toBe(200);
      expect(badBranch.json()).toBeNull();

      const outsideCwd = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc", branch: "main" },
      });
      expect(outsideCwd.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("force-removes a dirty preview worktree, and rejects a worktreePath/parentCwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      const { path: worktreePath } = checkoutRes.json();
      // Dirty the worktree — force-remove must succeed anyway (unlike
      // /internal/git-worktree/remove's removeWorktreeIfClean).
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const outsideParent = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: "/etc" },
      });
      expect(outsideParent.statusCode).toBe(400);
      expect(fs.existsSync(worktreePath)).toBe(true);

      const removeRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/force-remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(removeRes.statusCode).toBe(200);
      expect(removeRes.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("syncs a preview worktree to the branch's local tip, and rejects a worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, run } = await makeDockPreviewRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const checkoutRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/checkout",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, branch: "main" },
      });
      const { path: worktreePath } = checkoutRes.json();

      // A new commit on main in the primary checkout, not yet reflected in
      // the (detached-HEAD) preview worktree.
      fs.writeFileSync(path.join(cwd, "b.txt"), "b\n");
      run(["add", "-A"]);
      run(["commit", "-m", "second", "--no-verify"]);
      expect(fs.existsSync(path.join(worktreePath, "b.txt"))).toBe(false);

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/sync",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project", branch: "main" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const syncRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/sync",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, branch: "main" },
      });
      expect(syncRes.statusCode).toBe(200);
      expect(syncRes.json()).toEqual({ synced: true });
      expect(fs.existsSync(path.join(worktreePath, "b.txt"))).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-branch-delete, /git-worktree/remove-listed, and /prune-metadata (issue #442)", () => {
    async function makeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-442-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("deletes a branch on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      run(["branch", "feature-x"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, name: "feature-x" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/name body for git-branch-delete, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc/not-a-project", name: "main" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("removes any worktree git worktree list reports, not just a mullion-task-prefixed one", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/worktreePath body for remove-listed, and rejects a worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes stale worktree administrative metadata on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "oob-removed");
      run(["worktree", "add", "-b", "oob-branch", worktreePath, "main"]);
      fs.rmSync(worktreePath, { recursive: true, force: true });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pruned: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body for prune-metadata, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-pull (issue #745)", () => {
    async function makeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-pull-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("runs git pull on this host's own filesystem and returns GitPullResult", async () => {
      const { repoRoot, cwd } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ pulled: expect.any(Boolean) as boolean }),
      );

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
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
      payload: { id: "501", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501", "never-spawned"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.statusCode).toBe(200);
    const live = liveRes.json();
    expect(live["501"]).toMatchObject({ alive: true, cwd: "/tmp", command: "bash" });
    expect(live["never-spawned"]).toBeNull();

    const livenessRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/liveness",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501"] },
    });
    expect(livenessRes.statusCode).toBe(200);
    // The fake systemd-run spawn above (the POST /internal/sessions call)
    // recorded crs-session-501.scope into activeScopeUnits, so the fake
    // `list-units` reply includes it.
    expect(livenessRes.json()).toEqual({ "501": true });

    const terminateRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/501/terminate",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(204);

    await app.close();
  });

  // Task Master's initial-prompt fix (see task-claim.ts's own doc comment)
  // reaches a remote agent host through this exact route — RemoteBackend.
  // spawn (session-backend.ts) serializes the whole SpawnSessionOptions
  // object, including `initialPrompt`, straight into this body.
  it("threads a spawn body's initialPrompt through to the spawned command line as the matched hook adapter's argv", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "502",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).toContain("'fix the bug'");

    await app.close();
  });

  // Hermes review, PR #538 — the primary's own local `seedDelivered` guess
  // can't be trusted for a remote spawn (an old agent build silently strips
  // unknown body fields), so this route echoes back whether it actually
  // understood and used the prompt. A NEW build's echo must be exact.
  it("echoes initialPromptApplied: true when the spawn body's command can receive an initial prompt", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "504",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: true,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      // No taskId in the payload, so the echo is `false` (the Session
      // was created without a taskId, the value echoed is the
      // post-creation state, not the absent request field). See
      // routes/internal.ts's own comment on `taskIdApplied`.
      taskIdApplied: false,
    });
    await app.close();
  });

  // gemini, not opencode — opencode gained `initialPromptArgs` (`--prompt`)
  // and now takes the `true` branch above like claude/codex/agy do; see
  // hook-adapters/opencode.ts. gemini has no adapter at all, so it's a
  // genuine example of "no initial-prompt argv form."
  it("echoes initialPromptApplied: false when the spawn body's command has no initial-prompt argv form (gemini)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "505",
        cwd: "/tmp",
        command: "gemini",
        cols: 80,
        rows: 24,
        initialPrompt: "fix the bug",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      // Same `false` echo as the no-initialPrompt test below — neither
      // payload carries taskId, so the resulting Session's `taskId`
      // stays `undefined` and the echo reflects that.
      taskIdApplied: false,
    });
    await app.close();
  });

  it("echoes initialPromptApplied: false when no initialPrompt was sent at all", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "506", cwd: "/tmp", command: "claude", cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      // No taskId in the payload — same `false` echo as the `true` /
      // `false` initialPromptApplied tests above.
      taskIdApplied: false,
    });
    await app.close();
  });

  // Hermes review, PR #966 — the agent-side counterpart of
  // task-claim.ts's `taskId: task.id` set on every Task Master spawn.
  // The wire schema accepts it, the handler threads it to getOrCreate,
  // and the echo is `true` iff the resulting Session actually carries
  // that taskId (a reattach of a pre-PR-#966 session would have
  // `taskId: undefined` and the echo would be `false`). See
  // routes/internal.ts's own comment.
  it("threads taskId from the spawn body into the resulting Session and echoes taskIdApplied: true", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        // Numeric id (the agent-side /internal/sessions route's
        // schema accepts alphanumeric, but PtyManager's constructor
        // requires numeric — see pty-manager.ts's own check).
        id: "506506",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
        taskId: 348423,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      taskIdApplied: true,
    });

    // The resulting Session must actually carry the taskId — proves
    // the handler threaded it through getOrCreate rather than just
    // echoing the request body. Public `readonly` field (matches
    // injectAgentGuide's posture) on pty-manager.ts's Session.
    const session = app.pty.get("506506");
    expect(session?.taskId).toBe(348423);

    await app.close();
  });

  // Same Hermes review — `taskIdApplied: false` echoes for a reattach
  // of a session whose original spawn predates this field. The resulting
  // Session has `taskId: undefined` (never set on creation), and the
  // echo reflects that regardless of what THIS particular request body
  // asks for (this request doesn't carry taskId at all, but the
  // assertion is the same `false` value either way — the field is
  // computed from the Session, not the request).
  it("echoes taskIdApplied: false when the resulting Session has no taskId set, regardless of what's in the request", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "506507",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      initialPromptApplied: false,
      injectAgentGuide: true,
      injectProjectBriefing: true,
      taskIdApplied: false,
    });
    expect(app.pty.get("506507")?.taskId).toBeUndefined();
    await app.close();
  });

  // Issue: per-project briefing storage (a follow-up PR) — this PR only
  // wires the spawn-body channel through; no producer sets briefingOverride
  // yet, but the agent-side route must already thread whatever a future
  // primary sends correctly. Proves the field survives the actual HTTP
  // round trip (request body -> schema validation -> app.pty.getOrCreate ->
  // writeSessionBriefing), not just a typechecked-but-untested pass-through.
  it("threads briefingOverride from the spawn body into the per-session briefing file", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "507",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "operator-configured briefing text",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const written = fs.readFileSync(sessionBriefingPath(app.config.SESSIONS_DIR, "507"), "utf8");
    expect(written).toContain("operator-configured briefing text");

    await app.close();
  });

  it("rejects a briefingOverride over the schema's maxLength", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "508",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "a".repeat(8193),
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // Issue #942 — project-tooling.ts's save-time cap for NEW notes shrank to
  // 512 bytes, but this schema's own maxLength deliberately stayed at the
  // OLD 8192-byte bound (see internal-schemas.ts's own comment): a project
  // that saved a briefing between 512 and 8192 bytes BEFORE that cap shrank
  // still has that value sitting in the DB, unmodified (no data migration),
  // and session-lifecycle.ts's createSessionRecord reads it straight
  // through into this exact spawn-body field on a remote-host spawn. If
  // this schema's maxLength were tightened to match the new save-time cap,
  // that legacy row would 400 here on every remote spawn until someone
  // happened to re-save it — a hard failure the local/primary spawn path
  // never sees (it degrades gracefully via writeSessionBriefing's own
  // clamp instead, which this route's schema gate runs before).
  it("still accepts a legacy briefingOverride saved under the pre-#942 8 KiB cap, well over the new 512-byte save-time one", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "509",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        briefingOverride: "a".repeat(4000),
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    await app.close();
  });

  // Issue #937 — same "proves the field survives the actual HTTP round
  // trip" bar as the briefingOverride test above, for the new
  // workflowConventionsText spawn-body field (request body -> schema
  // validation -> app.pty.getOrCreate -> writeSessionWorkflowConventions).
  it("threads workflowConventionsText from the spawn body into the per-session workflow-conventions file", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "510",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "always branch, never commit to main",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const written = fs.readFileSync(
      sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, "510"),
      "utf8",
    );
    expect(written).toContain("always branch, never commit to main");

    await app.close();
  });

  it("rejects a workflowConventionsText over the schema's maxLength", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "511",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "a".repeat(8193),
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  // Writer-side "empty means unlink, not a body-less file" behavior (see
  // writeSessionWorkflowConventions's own doc comment) — a spawn body
  // carrying an explicit empty string must leave no per-session file, unlike
  // briefingOverride's own deliberately different empty-string posture.
  it("writes no per-session file when workflowConventionsText is an empty string", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        id: "512",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        workflowConventionsText: "",
      },
    });
    expect(res.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    expect(fs.existsSync(sessionWorkflowConventionsPath(app.config.SESSIONS_DIR, "512"))).toBe(
      false,
    );

    await app.close();
  });

  it("omits any prompt argv when a spawn body carries no initialPrompt", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "503", cwd: "/tmp", command: "claude", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const call = vi
      .mocked(childProcessSpawn)
      .mock.calls.findLast(([command]) => command === "systemd-run");
    const args = call?.[1] as string[];
    expect(args[args.length - 1]).not.toContain("fix the bug");

    await app.close();
  });

  describe("GET /internal/sessions/:id/scrollback (Phase 4, #187)", () => {
    it("returns the base64-encoded scrollback for a tracked session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;

      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "601", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/601/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const { b64 } = res.json();
      expect(typeof b64).toBe("string");
      // Always non-empty: getScrollback()'s synthesized alt-screen preamble
      // is unconditional, even with nothing else in the ring buffer yet —
      // see pty-manager.ts's getScrollback doc comment.
      expect(Buffer.from(b64, "base64").length).toBeGreaterThan(0);

      await app.close();
    });

    it("returns an empty b64 for a session id this agent has never tracked", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/never-spawned/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ b64: "" });
      await app.close();
    });

    it("401s without a valid bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/internal/sessions/601/scrollback" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("POST /internal/sessions/:id/review-gate (issue #178)", () => {
    it("delivers a decision to a real pending gate and reports {ok: true}", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9001", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      const session = app.pty.get("9001");
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" })}\n`,
      );
      await waitUntil(() => session.toInfo().gateState === "waiting");

      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9001/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      expect(session.toInfo().gateState).toBe("approved");

      socket.destroy();
      await app.close();
    });

    it("reports {ok: false} when nothing is pending for this session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9002", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9002/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "denied", reason: "nothing pending" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false });

      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9003/review-gate",
        headers: { authorization: "Bearer wrong" },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("400s an unrecognized decision value", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9004/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  it("expands a leading ~ in a spawned session's cwd against this host's own home dir", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "502", cwd: "~", command: "bash", cols: 80, rows: 24 },
    });
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["502"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.json()["502"]).toMatchObject({ cwd: os.homedir() });

    await app.close();
  });

  describe("POST /internal/uploads (issue #68)", () => {
    it("writes an image under <cwd>/.mullion-uploads and returns its absolute path", async () => {
      const app = await buildApp();
      // Must be within projectsRoot: this route now confines cwd via
      // resolveWithinRoots, same as /internal/actions and /internal/dock.
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const buffer = PNG_BYTES;

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: buffer,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads"))).toBe(true);
      expect(fs.readFileSync(uploadPath)).toEqual(buffer);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-upload-outside-"));

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(outsideRoots)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a mime type outside the allow-list", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fsvg%2Bxml`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/svg+xml" },
        payload: Buffer.from("<svg/>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a body whose bytes don't match the declared mime, even with an allow-listed Content-Type", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: Buffer.from("<html><script>alert(1)</script></html>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("requires cwd and mime query params", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/uploads",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a request with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=%2Ftmp&mime=image%2Fpng`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
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

  it("rejects a WS attach whose id isn't a plain alphanumeric token", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=${encodeURIComponent("weird;id")}&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("attaches over WS with a valid token, spawning and streaming pty output", async () => {
    const { app, port } = await buildAndListen();
    const before = fakePtyChildren.length;

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=503&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
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

  describe("/internal/ws/events (issue #166's multi-host twin — the agent-side half)", () => {
    it("rejects a connection with no Authorization header", async () => {
      const { app, port } = await buildAndListen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/events`);
      const outcome = await waitForOpenOrClose(ws);
      expect(outcome).toBe("close");

      await app.close();
    });

    it("replays buffered events then streams live ones, using the same shared core as /ws/events", async () => {
      const { app, port } = await buildAndListen();

      // Numeric-looking id — matches production reality (a session id on
      // the agent side is always the primary's stringified DB row id, see
      // session-lifecycle.ts's spawn() call), and NotificationEvent.sessionId is
      // typed `number` (pty-manager.ts), derived via Number(this.id).
      // fakePtyChildren accumulates across every test in this file — snapshot
      // its length first (same pattern the /internal/ws/attach test above
      // uses) so `pty` below is genuinely THIS test's own session, not a
      // stale one left over from an earlier test.
      const before = fakePtyChildren.length;
      const spawn = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "77", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      expect(spawn.statusCode).toBe(201);
      await waitUntil(() => fakePtyChildren.length > before);
      const pty = fakePtyChildren[fakePtyChildren.length - 1];

      // Emitted before the WS connects — must still appear in the replay
      // batch (mirrors events.test.ts's own local-route replay assertion).
      // A1: title_change events are now debounced at the source
      // (pty-manager.ts's TITLE_CHANGE_EVENT_DEBOUNCE_MS, 3s) — wait that
      // out first so the event has actually settled into the session's
      // buffer before the client connects, otherwise this would be testing
      // live streaming, not replay (mirrors events.test.ts's identical fix).
      pty.emitData("\x1b]2;working\x07");
      await new Promise((resolve) => setTimeout(resolve, 3_200));

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const messages: Array<{ sessionId: number; kind: string; payload: Record<string, unknown> }> =
        [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({
        sessionId: 77,
        kind: "title_change",
        payload: { title: "working" },
      });

      // A working->idle title transition (#98) is a zero-threshold attention
      // signal (see ATTENTION_CONFIRM_MS in attention-detect.ts) — confirms
      // synchronously, unlike a bare bell (debounced against attention-detect.ts's
      // PENDING_ATTENTION state machine — see issue #171), which needs either
      // a real ~2s wait or a direct Session.tick() call this route-level test
      // has no access to. The session's title is already "working" from the
      // pre-connect emit above, so this is a genuine transition.
      pty.emitData("\x1b]2;idle\x07");
      await waitUntil(() => messages.some((m) => m.kind === "attention"));

      ws.close();
      await app.close();
    }, 10_000);
  });

  describe("/internal/ws/ssh-agent (issue #820, PR5b)", () => {
    it("rejects a connection with no Authorization header", async () => {
      const { app, port } = await buildAndListen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`);
      const outcome = await waitForOpenOrClose(ws);
      expect(outcome).toBe("close");

      await app.close();
    });

    it("wraps a successful connection in a MuxConnection tracked as app.sshAgentBridgeConnection.current", async () => {
      const { app, port } = await buildAndListen();
      expect(app.sshAgentBridgeConnection.current).toBeNull();

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);
      expect(typeof app.sshAgentBridgeConnection.current!.openChannel).toBe("function");

      ws.close();
      await app.close();
    });

    it("clears app.sshAgentBridgeConnection.current when the connection closes", async () => {
      const { app, port } = await buildAndListen();

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);

      ws.close();
      await waitUntil(() => app.sshAgentBridgeConnection.current === null);

      await app.close();
    });

    it("supersedes an old connection when a new one connects — closes the old socket, doesn't clobber the new one on the old one's belated close", async () => {
      const { app, port } = await buildAndListen();

      const firstWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const firstClosePromise = new Promise<void>((resolve) => firstWs.once("close", resolve));
      await new Promise<void>((resolve, reject) => {
        firstWs.once("open", () => resolve());
        firstWs.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);
      const firstMux = app.sshAgentBridgeConnection.current;

      const secondWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        secondWs.once("open", () => resolve());
        secondWs.once("error", reject);
      });

      // The FIRST connection must be closed as a side effect of the SECOND
      // one connecting — not left dangling (regression shape: routes/
      // agent-bridge.ts's own equivalent "superseded socket" test, #860).
      await firstClosePromise;
      await waitUntil(() => app.sshAgentBridgeConnection.current !== firstMux);
      expect(app.sshAgentBridgeConnection.current).not.toBeNull();

      secondWs.close();
      await app.close();
    });

    it("end-to-end: a local SSH client connecting to ssh-agent.sock gets closed immediately with no primary connected, and gets a real channel once one is", async () => {
      const { app, port } = await buildAndListen();
      const socketPath = path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock");

      // No primary connection yet — ssh-agent-socket.ts's own "no bridge
      // reachable" fail-fast path (PR5a) must close this immediately
      // rather than hang, since `ssh` blocks on SSH_AUTH_SOCK until the
      // agent answers or the connection drops.
      const before = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        before.once("close", () => resolve());
        before.once("connect", () => {
          // Connecting is expected (the listener itself is always up) —
          // only a prompt close afterward is being asserted here.
        });
        setTimeout(() => reject(new Error("local socket did not close without a primary")), 2000);
      });

      // Now a primary dials in — the exact same handshake the earlier
      // tests in this block exercise.
      const bridgeWs = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/ssh-agent`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        bridgeWs.once("open", () => resolve());
        bridgeWs.once("error", reject);
      });
      await waitUntil(() => app.sshAgentBridgeConnection.current !== null);

      // A fresh local connection now completes an actual channel open —
      // observed as a real Open frame (type byte 1) arriving on the
      // primary-side socket, not a prompt close.
      const framesFromAgent: Buffer[] = [];
      bridgeWs.on("message", (data) => framesFromAgent.push(data as Buffer));
      const after = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        after.once("connect", () => resolve());
        after.once("error", reject);
      });
      await waitUntil(() => framesFromAgent.some((f) => f.length >= 1 && f[0] === 1));

      after.destroy();
      bridgeWs.close();
      await app.close();
    });
  });

  describe("/internal/preview* (issue #28 phase 6 — the agent's own loopback-only proxy half)", () => {
    let stubHttpServer: http.Server;
    let stubWss: WebSocketServer;
    let stubPort: number;

    beforeAll(async () => {
      stubHttpServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              host: req.headers.host,
              path: req.url,
              method: req.method,
              headers: req.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      });
      stubWss = new WebSocketServer({ server: stubHttpServer });
      stubWss.on("connection", (socket) => {
        socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
      });
      await new Promise<void>((resolve) => stubHttpServer.listen(0, "127.0.0.1", resolve));
      stubPort = (stubHttpServer.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => stubWss.close(() => resolve()));
      await new Promise<void>((resolve) => stubHttpServer.close(() => resolve()));
    });

    it("proxies to this agent's own loopback dev server, stripping its own auth header before forwarding", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}/some/asset.js?v=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe("/some/asset.js?v=1");
      // The stub echoes whatever Authorization header it received — none,
      // proving buildUpstreamRequestHeaders' "authorization" exclusion
      // actually stripped this agent's own bearer token before the
      // onward loopback fetch (it would otherwise leak this agent's
      // shared secret to arbitrary project dev-server code).
      expect(body.host).toBe(`127.0.0.1:${stubPort}`);
      await app.close();
    });

    it("streams a POST body through to this agent's own loopback dev server", async () => {
      // Registered in its own encapsulated child context with a raw
      // content-type parser (see internal.ts) so request.body arrives as
      // the unparsed stream this route needs — this is the regression test
      // for that encapsulation actually working.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.method).toBe("POST");
      expect(body.body).toBe(JSON.stringify({ hello: "world" }));
      await app.close();
    });

    it("401s a POST with no Authorization header, same as the existing GET gate", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("still forwards a POST body with no Content-Type header at all", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: "raw-bytes-no-content-type",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toBe("raw-bytes-no-content-type");
      await app.close();
    });

    it("still parses JSON bodies for an ordinary /internal/* POST route (encapsulation regression net)", async () => {
      // Proves the preview route's own raw-body content-type parser
      // (registered in a child context so it can removeAllContentTypeParsers()
      // for itself) never leaked out and broke JSON parsing for the rest of
      // this plugin — spawn-session is a real POST route that requires a
      // parsed JSON body.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          id: "not-numeric-port-related",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        },
      });
      // Whatever this route's own validation does with this payload, it
      // must have been able to parse it as JSON in the first place — a
      // leaked raw-body parser would instead hand it an unparsed Buffer
      // and fail differently (e.g. a schema/type error, not this route's
      // own business-logic response).
      expect(res.statusCode).not.toBe(415);
      await app.close();
    });

    it("rejects a non-numeric or out-of-range port", async () => {
      const app = await buildApp();
      const notNumeric = await app.inject({
        method: "GET",
        url: "/internal/preview/not-a-port/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(notNumeric.statusCode).toBe(400);

      const outOfRange = await app.inject({
        method: "GET",
        url: "/internal/preview/70000/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outOfRange.statusCode).toBe(400);
      await app.close();
    });

    it("502s when the loopback dev server is unreachable", async () => {
      const app = await buildApp();
      // Port 1: a real, always-refused loopback port (same convention used
      // throughout this repo's other "unreachable" tests).
      const res = await app.inject({
        method: "GET",
        url: "/internal/preview/1/",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(502);
      await app.close();
    });

    // The core security claim of this phase: this agent must only ever
    // dial its own loopback, regardless of what path the primary forwards
    // — see resolveLoopbackPreviewUrl's own comment for the two concrete
    // bypasses (network-path reference, HTTP userinfo) a naive
    // string-concatenation would have been vulnerable to.
    it("never dials off-loopback, even for a path smuggling a network-path reference or userinfo host", async () => {
      const app = await buildApp();
      for (const maliciousRest of [
        "//evil.example.com/x",
        "/\\evil.example.com/x",
        "@evil.example.com/",
      ]) {
        const res = await app.inject({
          method: "GET",
          url: `/internal/preview/${stubPort}/${maliciousRest}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        // Either rejected outright (400, the expected outcome) or, in the
        // worst case a future change weakens the parse, proxied — but
        // NEVER to evil.example.com: assert on the stub's own recorded
        // host if it somehow got a 200.
        if (res.statusCode === 200) {
          expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
        } else {
          expect(res.statusCode).toBe(400);
        }
      }
      await app.close();
    });

    it("400s (not 500s) a preview path that `new URL()` itself throws on (Hermes review, PR #48)", async () => {
      // Confirmed via node -e: `new URL("//[::a.b.c.d]/x", base)` throws
      // TypeError outright rather than just parsing into something
      // resolveLoopbackPreviewUrl would otherwise reject — a case its own
      // try/catch exists for.
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}///[::a.b.c.d]/x`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a WS preview upgrade with a non-numeric port or missing path", async () => {
      const { app, port } = await buildAndListen();

      const badPort = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=not-a-port&path=%2F`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(badPort)).toBe("close");

      const missingPath = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(missingPath)).toBe("close");

      await app.close();
    });

    // A network-path reference doesn't get *rejected* pre-handshake — it
    // gets *sanitized* (resolveLoopbackPreviewUrl only ever keeps the
    // pathname/search, see its own comment) and the upgrade proceeds
    // against the real loopback dev server, same as the HTTP case above.
    // The assertion that matters isn't "close" — it's "this never actually
    // dials evil.example.com", proven here by getting a real echo back
    // from *our* stub.
    it("sanitizes (not rejects) a WS preview path smuggling a network-path reference — still only ever dials loopback", async () => {
      const { app, port } = await buildAndListen();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=${encodeURIComponent("//evil.example.com/x")}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });

    it("proxies a WS preview upgrade to this agent's own loopback dev server", async () => {
      const { app, port } = await buildAndListen();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=%2Fhmr`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });
  });
});

// Issue #245 / roadmap 7.1 (independent review, PR #528) — the single
// highest-consequence invariant in the self-registration feature: an
// enrolled agent has MULLION_AGENT_TOKEN unset (empty string), and without
// the `.trim() !== ""` guard in internal.ts's onRequest hook,
// timingSafeTokenMatch("", "") would make an EMPTY inbound Authorization
// header match an empty configured token — unauthenticated access to
// /internal/ws/attach, arbitrary command execution. This must be a test,
// not a comment.
describe("internal routes: empty MULLION_AGENT_TOKEN guard (issue #245)", () => {
  let projectsRoot: string;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-empty-token-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.PROJECTS_ROOTS = projectsRoot;
    // No MULLION_AGENT_TOKEN — mirrors an enrolled agent before (or
    // without) any successful self-registration, when app.agentSession is
    // also still undefined. Needs SOME path to boot per src/app.ts's
    // fail-closed check; port 1 fails fast (connection refused) so the
    // plugin's fire-and-forget registerWithRetry() doesn't hang the test
    // or make a real network call.
    process.env.MULLION_PRIMARY_URL = "http://127.0.0.1:1";
    process.env.MULLION_ENROLLMENT_TOKEN = "unused-in-this-test";
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
  });

  it("rejects a request with an empty Authorization Bearer value when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a request with no Authorization header at all when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/discover" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Hermes review, PR #528: the TTL must bound a leaked session credential
  // on the ACCEPTING side too — resolveCurrentCredentials/rotateSession already
  // enforce it on the issuing side, but the agent's own inbound gate
  // didn't check app.agentSession.expiresAt at all before this fix, so a
  // primary that's down (unable to renew) would leave a past-TTL session
  // id accepted here forever.
  it("rejects a request bearing a session id that matches but has already expired", async () => {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: "expired-session-id",
      sessionSecret: "unused", // pragma: allowlist secret
      expiresAt: new Date(Date.now() - 1000),
    };
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer expired-session-id" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Issue #249 / roadmap 7.5: a session-matched request must ALSO carry a
  // valid signature — a bare bearer token is no longer sufficient on its
  // own once a session credential is involved. See the dedicated
  // "signature verification" describe block below for the fuller set of
  // missing/stale/replayed/forged cases; this one stays focused on the
  // narrow claim its name makes.
  it("accepts a request bearing a session id that matches and has not yet expired, when properly signed", async () => {
    const app = await buildApp();
    const sessionSecret = "live-session-secret"; // pragma: allowlist secret
    app.agentSession = {
      hostId: "host-x",
      sessionId: "live-session-id",
      sessionSecret,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const timestamp = String(Date.now());
    const nonce = "nonce-live-session";
    const canonicalString = buildCanonicalString({
      method: "GET",
      requestTarget: "/internal/discover",
      timestamp,
      nonce,
      bodyHashed: true,
      bodyHash: hashBody(""),
    });
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: {
        authorization: "Bearer live-session-id",
        [SIGNATURE_HEADER]: sign(sessionSecret, canonicalString),
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a request bearing a matching, unexpired session id with NO signature headers at all", async () => {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: "live-session-id",
      sessionSecret: "live-session-secret", // pragma: allowlist secret
      expiresAt: new Date(Date.now() + 60_000),
    };
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer live-session-id" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// Issue #249 / roadmap 7.5 — deeper signature-verification coverage: the
// body-hash half (deferred to preValidation), replay/drift, and the
// static-Bearer regression the phase's dual-mode-auth invariant demands.
describe("signature verification (issue #249 / roadmap 7.5)", () => {
  let projectsRoot: string;
  const SESSION_ID = "sig-test-session-id";
  const SESSION_SECRET = "sig-test-session-secret"; // pragma: allowlist secret

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-signature-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  async function sessionApp() {
    const app = await buildApp();
    app.agentSession = {
      hostId: "host-x",
      sessionId: SESSION_ID,
      sessionSecret: SESSION_SECRET,
      expiresAt: new Date(Date.now() + 60_000),
    };
    return app;
  }

  function signedHeaders(
    method: string,
    requestTarget: string,
    opts: { bodyHashed: boolean; body?: string; timestamp?: string; nonce?: string } = {
      bodyHashed: true,
    },
  ) {
    const timestamp = opts.timestamp ?? String(Date.now());
    const nonce = opts.nonce ?? `nonce-${Math.random()}`;
    const canonicalString = buildCanonicalString({
      method,
      requestTarget,
      timestamp,
      nonce,
      bodyHashed: opts.bodyHashed,
      bodyHash: opts.bodyHashed ? hashBody(opts.body ?? "") : "",
    });
    return {
      authorization: `Bearer ${SESSION_ID}`,
      [SIGNATURE_HEADER]: sign(SESSION_SECRET, canonicalString),
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
    };
  }

  describe("static-Bearer regression", () => {
    it("a static-token request needs no signature headers and is completely unaffected", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("a static-token request bearing garbage signature headers is unaffected too (they're simply never checked)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          [SIGNATURE_HEADER]: "garbage",
          [TIMESTAMP_HEADER]: "garbage",
          [NONCE_HEADER]: "garbage",
        },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  // Hermes review, PR #531: AgentSession.sessionSecret is typed `string`
  // (never optional), but a primary predating #528 could still send a
  // register response whose body has no session_secret field at all,
  // making this undefined at runtime despite the type. Must fail closed
  // with a 401, NOT the same way as the documented null (static-Bearer)
  // sentinel (that would skip verification entirely — a bypass) and NOT by
  // throwing inside verify()'s crypto.createHmac (a 500).
  describe("malformed session_secret (pre-#528 primary compatibility)", () => {
    it("401s cleanly instead of 500ing when sessionSecret is undefined at runtime", async () => {
      const app = await buildApp();
      app.agentSession = {
        hostId: "host-x",
        sessionId: "no-secret-session-id",
        // Cast past the type system deliberately — this simulates a
        // primary whose JSON response omitted session_secret, which the
        // type (string, never optional) can't itself express.
        sessionSecret: undefined as unknown as string,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const timestamp = String(Date.now());
      const nonce = "nonce-no-secret";
      const res = await app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: {
          authorization: "Bearer no-secret-session-id",
          [SIGNATURE_HEADER]: "irrelevant-cant-be-computed-without-a-secret",
          [TIMESTAMP_HEADER]: timestamp,
          [NONCE_HEADER]: nonce,
        },
      });
      expect(res.statusCode).toBe(401);
      // Hermes review, PR #531: a distinct message from "signed request
      // required" — this request WAS properly signed (from the caller's
      // point of view); the broken state is server-side (this agent's own
      // registered session has no usable secret), and conflating the two
      // messages would mislead debugging on the one side that can't see
      // why its correctly-signed request was rejected.
      expect(res.json().message).toBe("invalid session credential");
      await app.close();
    });
  });

  describe("body-hash verification (POST /internal/sessions/:id/stash-seed)", () => {
    it("accepts a correctly-signed request whose signature covers the actual body", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "real-seed" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body,
          }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(204);
      await app.close();
    });

    it("rejects a request whose body was tampered with after signing", async () => {
      const app = await sessionApp();
      const signedBody = JSON.stringify({ seed: "original-seed" });
      const tamperedBody = JSON.stringify({ seed: "tampered-seed" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          // Signature covers `signedBody`, but the actual payload sent is
          // `tamperedBody` — the hash the agent recomputes won't match.
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body: signedBody,
          }),
        },
        payload: tamperedBody,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a request whose method was tampered with (signature computed for GET, sent as POST)", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("GET", "/internal/sessions/s1/stash-seed", { bodyHashed: true, body }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a replayed nonce even on a second, otherwise-identical request", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const headers = {
        "content-type": "application/json",
        ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", { bodyHashed: true, body }),
      };
      const first = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers,
        payload: body,
      });
      expect(first.statusCode).toBe(204);

      const second = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers,
        payload: body,
      });
      expect(second.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a stale timestamp even with an otherwise-correct signature", async () => {
      const app = await sessionApp();
      const body = JSON.stringify({ seed: "x" });
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/s1/stash-seed",
        headers: {
          "content-type": "application/json",
          ...signedHeaders("POST", "/internal/sessions/s1/stash-seed", {
            bodyHashed: true,
            body,
            timestamp: String(Date.now() - 60_000),
          }),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("unsigned-body path (POST /internal/uploads)", () => {
    it("accepts an upload whose signature does NOT cover the actual image bytes", async () => {
      const app = await sessionApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-cwd-"));
      const requestTarget = `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`;
      const res = await app.inject({
        method: "POST",
        url: requestTarget,
        headers: {
          "content-type": "image/png",
          // bodyHashed: false — matches internal.ts's own independent
          // isUnsignedBodyPath(request.url) determination for this path;
          // the signature here covers NOTHING about the actual PNG bytes
          // below, and must still be accepted.
          ...signedHeaders("POST", requestTarget, { bodyHashed: false }),
        },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
