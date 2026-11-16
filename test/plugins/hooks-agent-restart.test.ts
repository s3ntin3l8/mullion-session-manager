import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { FastifyInstance } from "fastify";

// Issue #3166 — an agent host re-registers the hook tokens of the sessions
// that survived its restart, so their agents can complete a hook handshake
// again.
//
// This exercises the REAL hook socket (src/plugins/hooks.ts) end to end: the
// handshake line, the token resolution through `PtyManager.resolveToken()`,
// and the server's answer to a message that arrives on an accepted
// connection. Only the two things that would touch the machine are faked:
//
//   - `node:child_process`'s `spawn` — the scope listing goes through
//     `systemctl --user list-units` (src/services/systemctl-runner.ts), and
//     the scope launch goes through `systemd-run` (src/services/scope/
//     spawn.ts). Both are `spawn`ed, so faking `spawn` covers both: the
//     listing is answered from a canned table, and a real `systemd-run` can
//     never fire.
//   - the sessions' own dtach sockets — a live scope is a socket something is
//     serving, so the "live" scopes here are real `net.Server`s listening on
//     `<sessionsDir>/<id>.sock`.
//
// The scope liveness answer comes from the HOST's scope backend: on Linux
// that is `listOwnedScopes` (the `systemctl` listing this file fakes), on
// macOS the detached backend's probe of the session's own socket (the real
// `net.Server` this file opens). Both are set up here, so the test means the
// same thing on either platform.

const childState = vi.hoisted(() => ({ scopeListing: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[] = []) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout?: EventEmitter;
        kill: () => void;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      // A real child's `.stdout` exists from construction, and
      // `armKillEscalation` reads `.kill`/`.exitCode`/`.signalCode` — so the
      // fake has to carry all of them (see test/helpers/mock-spawn.ts's own
      // comment on the same point).
      child.stdout = new EventEmitter();
      child.kill = () => {};
      child.exitCode = null;
      child.signalCode = null;
      setImmediate(() => {
        if (command === "systemctl" && args.includes("list-units")) {
          child.stdout?.emit("data", Buffer.from(childState.scopeListing));
        }
        child.emit("exit", 0);
        // `runSystemctl` waits on "close" when it captures stdout, and on
        // "exit" otherwise — both have to fire, in that order, or the
        // listing never settles.
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    }),
  };
});

const { buildTestApp } = await import("../helpers/app.js");
const { deriveInstanceId } = await import("../../src/services/session-process.js");

/** A well-formed hook token: 48 lowercase hex characters (hook-token.ts's
 *  own `HOOK_TOKEN_RE`). */
const LIVE_TOKEN = "a1".repeat(24);
const DEAD_TOKEN = "b2".repeat(24);
const FOREIGN_TOKEN = "c3".repeat(24);
const MALFORMED_TOKEN = "not-a-well-formed-token";

/** Connects a raw net socket to `path`, resolving once actually connected. */
function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Resolves once `socket` closes (the server's refusal path). */
function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

/** Resolves with the first complete newline-terminated line the server
 *  writes back — the `session_start` reply that only an ACCEPTED handshake
 *  ever gets. */
function waitForLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) resolve(buffer.slice(0, newlineIndex));
    });
  });
}

describe("agent-role hook-token adoption (issue #3166)", () => {
  let sessionsDir: string;
  let foreignDir: string;
  let projectsRoot: string;
  const scopeServers: net.Server[] = [];

  /** Opens a socket something is serving — the "a live scope is a socket
   *  with a master behind it" model both scope backends use. */
  async function listenAt(socketPath: string): Promise<void> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    scopeServers.push(server);
  }

  /**
   * The fixture: two live scopes this host owns (one with a good token
   * file, one with a malformed one), one DEAD scope with a good token file,
   * and one scope that belongs to a DIFFERENT Mullion instance (its socket
   * lives in another instance's sessions dir).
   */
  async function setupFixture(): Promise<void> {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-adopt-sessions-"));
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-adopt-foreign-"));
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-adopt-projects-"));

    // The token files a PRE-restart process would have left behind.
    fs.writeFileSync(path.join(sessionsDir, "1.token"), LIVE_TOKEN);
    fs.writeFileSync(path.join(sessionsDir, "2.token"), DEAD_TOKEN);
    fs.writeFileSync(path.join(sessionsDir, "3.token"), MALFORMED_TOKEN);
    fs.writeFileSync(path.join(sessionsDir, "4.token"), FOREIGN_TOKEN);

    // The live scopes' own sockets — served by a real listener, so the
    // detached (macOS) backend's probe answers "live" too.
    await listenAt(path.join(sessionsDir, "1.sock"));
    await listenAt(path.join(sessionsDir, "3.sock"));
    // The foreign scope's socket: alive, but in ANOTHER instance's dir.
    await listenAt(path.join(foreignDir, "4.sock"));

    // The systemd listing the Linux backend reads. Ownership is resolved
    // from the dtach socket path in the Description (never from the unit
    // name), so the foreign row names a socket outside this instance's dirs
    // and is therefore not this host's scope.
    const instanceId = deriveInstanceId(sessionsDir);
    childState.scopeListing = [
      `crs-session-${instanceId}-1.scope loaded active running dtach -n ${path.join(sessionsDir, "1.sock")} /bin/bash -lc agent`,
      `crs-session-${instanceId}-3.scope loaded active running dtach -n ${path.join(sessionsDir, "3.sock")} /bin/bash -lc agent`,
      `crs-session-deadbeef-4.scope loaded active running dtach -n ${path.join(foreignDir, "4.sock")} /bin/bash -lc agent`,
    ].join("\n");
  }

  /**
   * Builds the agent-role app and waits for the boot sweep to finish.
   *
   * The sweep is fire-and-forget inside the onReady hook (the same posture
   * the primary's own adoption uses), so "the sweep is done" is observed
   * through the log line it ends with — never by a sleep.
   */
  async function bootAgent(): Promise<FastifyInstance> {
    const app = await buildTestApp();
    const infoSpy = vi.spyOn(app.log, "info");
    await app.ready();
    await vi.waitFor(
      () => {
        const logged = infoSpy.mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && arg.includes("surviving sessions")),
        );
        expect(logged).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );
    return app;
  }

  beforeAll(async () => {
    // Warm the app module OUTSIDE a test body: importing it pulls in the
    // whole server (playwright, the DB layer, ...), which costs several
    // seconds — more than the 20s per-test timeout allows once a test body
    // also has to build an app and wait for the boot sweep.
    await import("../../src/app.js");
  });

  beforeEach(async () => {
    await setupFixture();
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "test-agent-token";
    process.env.SESSIONS_DIR = sessionsDir;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });

  afterEach(async () => {
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.SESSIONS_DIR;
    delete process.env.PROJECTS_ROOTS;
    childState.scopeListing = "";
    for (const server of scopeServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("accepts a surviving live session's pre-restart token after the agent boots", async () => {
    const app = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: LIVE_TOKEN })}\n`);
    // A message on the SAME connection: only an accepted handshake gets a
    // reply (the `session_start` answer), so this is the proof that the
    // handshake was not merely "not closed yet".
    socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);

    const line = await waitForLine(socket);
    expect(JSON.parse(line)).toHaveProperty("additionalContext");
    socket.destroy();
  });

  it("still refuses an unknown token", async () => {
    const app = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: "f".repeat(48) })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses the token of a dead scope", async () => {
    const app = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: DEAD_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses a malformed token file's content", async () => {
    const app = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: MALFORMED_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses the token of a scope this host does not own", async () => {
    const app = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: FOREIGN_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("never writes a whole token to a log line", async () => {
    const app = await buildTestApp();
    const spies = [
      vi.spyOn(app.log, "info"),
      vi.spyOn(app.log, "warn"),
      vi.spyOn(app.log, "error"),
    ];
    await app.ready();
    await vi.waitFor(
      () => {
        const logged = spies[0].mock.calls.some((call) =>
          call.some((arg) => typeof arg === "string" && arg.includes("surviving sessions")),
        );
        expect(logged).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );

    // Every token this test knows about, whole — the log may carry the
    // existing 8-character prefix (hooks.ts's own rule), never the value.
    for (const token of [LIVE_TOKEN, DEAD_TOKEN, FOREIGN_TOKEN, MALFORMED_TOKEN]) {
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(token);
        }
      }
    }
  });
});
