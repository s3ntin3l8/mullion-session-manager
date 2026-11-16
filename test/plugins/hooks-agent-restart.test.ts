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

/**
 * The boot sweep's log lines (src/plugins/pty.ts).
 *
 * `SWEEP_FINISHED` fires whenever the sweep RAN, whatever it decided — so it
 * is the marker that tells a test "the sweep's verdict is in". `SWEEP_REGISTERED`
 * fires only when at least one token was registered, and `SWEEP_SKIPPED` only
 * when at least one candidate was skipped (with the ids and the reasons).
 */
const SWEEP_FINISHED = "boot sweep of surviving hook tokens finished";
const SWEEP_REGISTERED = "re-registered the hook tokens of surviving sessions";
const SWEEP_SKIPPED = "some surviving hook tokens could not be re-registered";

/** One watched log method — the shape this test needs (the recorded calls). */
interface LogSpy {
  mock: { calls: unknown[][] };
}

/** The log calls this test watches. */
interface LogSpies {
  info: LogSpy;
  warn: LogSpy;
  error: LogSpy;
}

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
    // and is therefore not this host's scope. Its unit carries ANOTHER
    // instance's id (guaranteed different from this one's), so the backend
    // reads it as "not ours" rather than as this instance's own unit whose
    // socket could not be placed.
    const instanceId = deriveInstanceId(sessionsDir);
    const foreignInstanceId = instanceId === "deadbeef" ? "deadbeee" : "deadbeef";
    childState.scopeListing = [
      `crs-session-${instanceId}-1.scope loaded active running dtach -n ${path.join(sessionsDir, "1.sock")} /bin/bash -lc agent`,
      `crs-session-${instanceId}-3.scope loaded active running dtach -n ${path.join(sessionsDir, "3.sock")} /bin/bash -lc agent`,
      `crs-session-${foreignInstanceId}-4.scope loaded active running dtach -n ${path.join(foreignDir, "4.sock")} /bin/bash -lc agent`,
    ].join("\n");
  }

  /**
   * Builds the agent-role app and waits for the boot sweep to finish.
   *
   * The sweep is fire-and-forget inside the onReady hook (the same posture
   * the primary's own adoption uses), so "the sweep is done" is observed
   * through the log line it always ends with — never by a sleep.
   */
  async function bootAgent(): Promise<{ app: FastifyInstance; logs: LogSpies }> {
    const app = await buildTestApp();
    const logs: LogSpies = {
      info: vi.spyOn(app.log, "info"),
      warn: vi.spyOn(app.log, "warn"),
      error: vi.spyOn(app.log, "error"),
    };
    await app.ready();
    await waitForLog(logs.info, SWEEP_FINISHED);
    return { app, logs };
  }

  /** Waits until `spy` has seen a log call whose message is `message`. */
  async function waitForLog(spy: LogSpy, message: string): Promise<void> {
    await vi.waitFor(
      () => {
        const logged = spy.mock.calls.some((call) => call.some((arg) => arg === message));
        expect(logged).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  /**
   * The sweep's own verdict for one candidate: the session id it skipped and
   * the reason. `undefined` when the sweep said nothing about that id.
   *
   * This is what tells "the sweep ran and skipped this id on purpose" apart
   * from "the sweep never ran" — without it, a refusal test cannot say which
   * of the two it is looking at.
   */
  function skippedVerdict(
    logs: LogSpies,
    sessionId: string,
  ): { sessionId: string; reason: string } | undefined {
    for (const call of logs.warn.mock.calls) {
      if (!call.some((arg) => arg === SWEEP_SKIPPED)) continue;
      for (const arg of call) {
        if (typeof arg !== "object" || arg === null) continue;
        const skipped = (arg as { skipped?: unknown }).skipped;
        if (!Array.isArray(skipped)) continue;
        for (const entry of skipped) {
          if (typeof entry !== "object" || entry === null) continue;
          const candidate = entry as { sessionId?: unknown; reason?: unknown };
          if (candidate.sessionId !== sessionId) continue;
          return { sessionId, reason: String(candidate.reason) };
        }
      }
    }
    return undefined;
  }

  /** The session ids the sweep registered (its own summary line). */
  function registeredIds(logs: LogSpies): string[] {
    for (const call of logs.info.mock.calls) {
      if (!call.some((arg) => arg === SWEEP_REGISTERED)) continue;
      for (const arg of call) {
        if (typeof arg !== "object" || arg === null) continue;
        const ids = (arg as { sessionIds?: unknown }).sessionIds;
        if (Array.isArray(ids)) return ids.map(String);
      }
    }
    return [];
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
    const { app, logs } = await bootAgent();

    // The sweep's own summary line: it registered this live scope's id —
    // the pinned fact this test is about.
    await waitForLog(logs.info, SWEEP_REGISTERED);
    expect(registeredIds(logs)).toContain("1");

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
    const { app } = await bootAgent();

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: "f".repeat(48) })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses the token of a dead scope", async () => {
    const { app, logs } = await bootAgent();

    // The sweep RAN and skipped this id on purpose — the refusal below is
    // the sweep's verdict, not the absence of one.
    expect(skippedVerdict(logs, "2")).toEqual({ sessionId: "2", reason: "dead-scope" });

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: DEAD_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses a malformed token file's content", async () => {
    const { app, logs } = await bootAgent();

    expect(skippedVerdict(logs, "3")).toEqual({
      sessionId: "3",
      reason: "malformed-token",
    });

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: MALFORMED_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("still refuses the token of a scope this host does not own", async () => {
    const { app, logs } = await bootAgent();

    // A scope of ANOTHER Mullion instance is not one of this host's scopes,
    // so the sweep skipped it — the reason it carries is the backend's
    // verdict on "this host holds no live scope for that id".
    expect(skippedVerdict(logs, "4")).toBeDefined();
    expect(registeredIds(logs)).not.toContain("4");

    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: FOREIGN_TOKEN })}\n`);

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("never writes a whole token to a log line", async () => {
    const app = await buildTestApp();
    const spies: LogSpies = {
      info: vi.spyOn(app.log, "info"),
      warn: vi.spyOn(app.log, "warn"),
      error: vi.spyOn(app.log, "error"),
    };
    await app.ready();
    await waitForLog(spies.info, SWEEP_FINISHED);

    // Every token this test knows about, whole — the log may carry the
    // existing 8-character prefix (hooks.ts's own rule), never the value.
    // The sweep's own skip summary (ids + reasons) is part of what is
    // checked here: it is logged, and it carries no token either.
    for (const token of [LIVE_TOKEN, DEAD_TOKEN, FOREIGN_TOKEN, MALFORMED_TOKEN]) {
      for (const spy of [spies.info, spies.warn, spies.error]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(token);
        }
      }
    }
  });
});
