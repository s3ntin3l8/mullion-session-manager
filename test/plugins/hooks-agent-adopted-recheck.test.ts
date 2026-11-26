import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { Session } from "../../src/services/pty-manager.js";
import type { ScopeLiveness } from "../../src/services/scope/types.js";
import {
  HOOK_TOKEN_RECHECK_INTERVAL_MS,
  recheckAdoptedHookTokensForApp,
} from "../../src/plugins/pty.js";

// Issue #3206 — an ADOPTED hook token must stop resolving once its scope
// dies.
//
// Issue #3166 taught an agent-role host to re-register the hook tokens of the
// sessions that survived its restart. That registration was a boot-time
// SNAPSHOT: the registry that resolves a handshake is PROCESS state, and the
// only thing that ever took an entry back out was `PtyManager.kill()` —
// which only knows the sessions THIS PROCESS TRACKS. An adopted id has no
// `Session` object here (the session was deliberately never rebuilt), so
// nothing ever dropped its token.
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
//   - the session's own dtach socket — a live scope is a socket something is
//     serving, so the "live" scope here is a real `net.Server` listening on
//     `<sessionsDir>/<id>.sock`.
//
// The scope liveness answer comes from the HOST's scope backend: on Linux
// that is `listOwnedScopes` (the `systemctl` listing this file fakes), on
// macOS the detached backend's probe of the session's own socket (the real
// `net.Server` this file opens). Both are set up here, so the test means the
// same thing on either platform.

const childState = vi.hoisted(() => ({
  scopeListing: "",
  /** When true, the systemctl listing FAILS — the backend answers "unknown". */
  listingFails: false,
  /** Every command this file's fake `spawn` was asked to run. */
  spawns: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[] = []) => {
      childState.spawns.push([command, ...args].join(" "));
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
          if (childState.listingFails) {
            // A listing that FAILED: `systemctl` exits non-zero, which
            // `listOwnedScopes` maps to "every id is UNKNOWN" — the answer
            // that must NOT be read as "dead" (see session-process.ts's
            // isMasterAliveStateBatch doc comment).
            child.emit("exit", 1);
            setImmediate(() => child.emit("close", 1));
            return;
          }
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
// The app module is imported OUTSIDE every test body on purpose: importing
// it pulls in the whole server (playwright, the DB layer, ...), which costs
// several seconds — more than the 20s per-test timeout allows once a test
// body also has to build an app and wait for the boot sweep.
const { buildApp } = await import("../../src/app.js");
const { deriveInstanceId } = await import("../../src/services/session-process.js");

/** A well-formed hook token: 48 lowercase hex characters (hook-token.ts's
 *  own `HOOK_TOKEN_RE`). */
const LIVE_TOKEN = "a1".repeat(24);

/**
 * The boot sweep's log lines (src/plugins/pty.ts).
 *
 * `SWEEP_FINISHED` fires whenever the sweep RAN, whatever it decided — so it
 * is the marker that tells a test "the sweep's verdict is in".
 */
const SWEEP_FINISHED = "boot sweep of surviving hook tokens finished";

/**
 * The re-check's own log line (src/plugins/pty.ts): it fires once the
 * re-check FORGOT at least one token, so it is the marker that tells a test
 * "the re-check's verdict is in".
 */
const FORGOT_TOKENS = "forgot the hook tokens of adopted sessions whose scope died";

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

/**
 * The handshake is ACCEPTED: the server answers the `session_start` line on
 * the SAME connection (only an accepted handshake gets a reply), so this is
 * the proof that the handshake was not merely "not closed yet".
 */
async function expectHandshakeAccepted(app: FastifyInstance): Promise<void> {
  const socket = await connect(app.pty.hookSocketPath);
  socket.write(`${JSON.stringify({ token: LIVE_TOKEN })}\n`);
  socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
  const line = await waitForLine(socket);
  expect(JSON.parse(line)).toHaveProperty("additionalContext");
  socket.destroy();
}

/**
 * The handshake is REFUSED: the server closes the connection without a
 * reply.
 */
async function expectHandshakeRefused(app: FastifyInstance): Promise<void> {
  const socket = await connect(app.pty.hookSocketPath);
  socket.write(`${JSON.stringify({ token: LIVE_TOKEN })}\n`);
  await waitForClose(socket);
  expect(socket.destroyed).toBe(true);
}

describe("an adopted hook token stops resolving once its scope dies (issue #3206)", () => {
  let sessionsDir: string;
  let projectsRoot: string;
  let scopeServer: net.Server | null = null;

  /** Opens a socket something is serving — the "a live scope is a socket
   *  with a master behind it" model both scope backends use. */
  async function listenAt(socketPath: string): Promise<void> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    scopeServer = server;
  }

  /**
   * The fixture: ONE live scope this host owns, with a persisted token file
   * (what a pre-restart process left behind) and a live socket.
   */
  async function setupFixture(): Promise<void> {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-recheck-sessions-"));
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-recheck-projects-"));

    fs.writeFileSync(path.join(sessionsDir, "1.token"), LIVE_TOKEN);
    await listenAt(path.join(sessionsDir, "1.sock"));

    // The systemd listing the Linux backend reads. Ownership is resolved
    // from the dtach socket path in the Description (never from the unit
    // name), so this row names a socket inside this instance's own dir.
    const instanceId = deriveInstanceId(sessionsDir);
    childState.scopeListing = [
      `crs-session-${instanceId}-1.scope loaded active running dtach -n ${path.join(sessionsDir, "1.sock")} /bin/bash -lc agent`,
    ].join("\n");
  }

  /**
   * Awaits the app's readiness and the boot sweep that follows it.
   *
   * The sweep is fire-and-forget inside the onReady hook (the same posture
   * the primary's own adoption uses), so "the sweep is done" is observed
   * through the log line it always ends with — never by a sleep. The log
   * spy has to be installed BEFORE `ready()`, or the sweep's own line could
   * land before anyone is listening for it.
   */
  async function readyAndAwaitSweep(app: FastifyInstance): Promise<void> {
    const logs = vi.spyOn(app.log, "info");
    await app.ready();
    await vi.waitFor(
      () => {
        const logged = logs.mock.calls.some((call) => call.some((arg) => arg === SWEEP_FINISHED));
        expect(logged).toBe(true);
      },
      { timeout: 10_000, interval: 20 },
    );
  }

  /**
   * Builds the agent-role app and waits for the boot sweep to finish.
   *
   * `buildTestApp()` closes the app again when the test ends (its own
   * `onTestFinished` hook), so the app's re-check timer cannot outlive the
   * test that armed it — the timer is cleared by the app's own `onClose`
   * hook.
   */
  async function bootAgent(): Promise<FastifyInstance> {
    const app = await buildTestApp();
    await readyAndAwaitSweep(app);
    return app;
  }

  /**
   * Runs the re-check the boot path runs — the SAME call the agent's own
   * timer makes (src/plugins/pty.ts), against the host's own scope backend.
   */
  async function recheck(
    app: FastifyInstance,
  ): Promise<{ forgotten: string[]; retained: string[] }> {
    return recheckAdoptedHookTokensForApp(app);
  }

  /**
   * The scope-liveness listing is cached for a few hundred milliseconds
   * (session-process.ts's OWNED_SCOPES_TTL_MS), so a change to it is only
   * visible once that cache has expired. Waiting it out is what lets the
   * re-check read the listing the test just wrote, instead of the boot
   * sweep's cached answer.
   */
  async function expireListingCache(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * The scope this host owned is GONE: its unit is no longer in the listing
   * and its socket has nobody serving it any more.
   */
  async function killScope(): Promise<void> {
    childState.scopeListing = "";
    const server = scopeServer;
    scopeServer = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(path.join(sessionsDir, "1.sock"), { force: true });
    await expireListingCache();
  }

  beforeEach(async () => {
    // Reset BEFORE the fixture fills the listing in — the fixture's own
    // listing is what the scope backend reads.
    childState.scopeListing = "";
    childState.listingFails = false;
    childState.spawns = [];
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
    childState.listingFails = false;
    const server = scopeServer;
    scopeServer = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("accepts the adopted token while the scope is alive", async () => {
    const app = await bootAgent();

    await expectHandshakeAccepted(app);
  });

  it("refuses the adopted token once the scope is confirmed dead", async () => {
    const app = await bootAgent();

    // Alive at boot: the token resolves.
    await expectHandshakeAccepted(app);

    await killScope();

    const result = await recheck(app);
    expect(result.forgotten).toContain("1");

    await expectHandshakeRefused(app);
  });

  it("keeps the adopted token accepted while the scope's liveness is unknown", async () => {
    const app = await bootAgent();

    // The scope's liveness can no longer be CONFIRMED — the listing fails,
    // which the backend reports as "unknown" for every id, never "dead".
    childState.listingFails = true;
    await expireListingCache();

    const result = await recheck(app);
    // Nothing was forgotten: "unknown" is not "dead".
    expect(result.forgotten).not.toContain("1");
    expect(result.retained).toContain("1");

    await expectHandshakeAccepted(app);
  });

  it("keeps every token when the re-check itself fails", async () => {
    const app = await bootAgent();

    // The liveness question could not be answered at all — the backend
    // threw. A failed re-check is a LOST TICK, not a broken state: nothing
    // is forgotten, and the next tick tries again.
    const spy = vi
      .spyOn(app.pty, "isMasterAliveStateBatch")
      .mockRejectedValue(new Error("the scope backend is down"));
    const result = await recheck(app);
    spy.mockRestore();

    expect(result.forgotten).toEqual([]);
    // The failed tick kept every adopted token registered.
    expect(result.retained).toContain("1");

    await expectHandshakeAccepted(app);
  });

  it("never stops, terminates or respawns a scope while re-checking", async () => {
    const app = await bootAgent();

    await killScope();
    await recheck(app);

    // The re-check READ the scope's liveness (a scope listing) and did
    // nothing else: a `systemctl stop` or a `systemd-run` would mean it had
    // touched the session instead of just asking about it.
    const listings = childState.spawns.filter((spawn) => spawn.includes("systemctl"));
    expect(listings.length).toBeGreaterThan(0);
    for (const spawn of childState.spawns) {
      expect(spawn).not.toMatch(/\bstop\b/);
      expect(spawn).not.toContain("systemd-run");
    }
  });

  it("keeps the token of an id this process now tracks itself", async () => {
    const app = await bootAgent();

    // The user re-opens the adopted session: the manager rebuilds the
    // `Session`, registers the token itself (the token FILE is reused
    // verbatim, so it is the very token the adoption registered) and spawns
    // a fresh scope. The scope listing still answers "dead" for the scope
    // that is coming back — it is cached for a few hundred milliseconds and
    // the new scope is not in it yet — so a re-check tick landing in that
    // window sees "dead" for a session that is ALIVE.
    //
    // The tracked state flips WHILE the liveness answer is in flight: the
    // exact shape of that window.
    let tracked = false;
    vi.spyOn(app.pty, "isMasterAliveStateBatch").mockImplementation(
      async (ids: string[]): Promise<Record<string, ScopeLiveness>> => {
        tracked = true;
        return Object.fromEntries(ids.map((id) => [id, "dead" as const]));
      },
    );
    vi.spyOn(app.pty, "get").mockImplementation((id: string) =>
      tracked && id === "1" ? ({} as Session) : undefined,
    );

    const result = await recheck(app);

    // The tracked session's token is NOT forgotten: it belongs to the
    // manager now, and the manager's own kill() path is what drops it.
    expect(result.forgotten).not.toContain("1");
    expect(result.retained).toContain("1");

    // And it still resolves: the live session's hook handshakes are
    // accepted, exactly as they were before the re-check ran.
    await expectHandshakeAccepted(app);
  });

  it("re-checks the adopted scopes on its own timer, and stops the timer when the app closes", async () => {
    // Only the interval timers are faked: the re-check's cadence is what
    // this test drives, while everything else (the scope listing's cache
    // TTL, the app's own boot) keeps running on real time.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // NOT the shared `buildTestApp()` helper: this test closes the app
    // itself, and the helper closes it a second time from its own
    // `onTestFinished` hook.
    let app: FastifyInstance | null = null;
    let closed = false;
    try {
      app = await buildApp();
      await readyAndAwaitSweep(app);
      const logs = vi.spyOn(app.log, "info");

      await killScope();

      // The tick fires on its own: the re-check runs, the dead scope's
      // token is forgotten, and the handshake is refused from then on.
      await vi.advanceTimersByTimeAsync(HOOK_TOKEN_RECHECK_INTERVAL_MS);
      await vi.waitFor(
        () => {
          const logged = logs.mock.calls.some((call) => call.some((arg) => arg === FORGOT_TOKENS));
          expect(logged).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
      await expectHandshakeRefused(app);

      // The app's close clears the timer: no further tick runs.
      const liveness = vi.spyOn(app.pty, "isMasterAliveStateBatch");
      await app.close();
      closed = true;
      await vi.advanceTimersByTimeAsync(HOOK_TOKEN_RECHECK_INTERVAL_MS * 2);
      expect(liveness).not.toHaveBeenCalled();
    } finally {
      if (!closed) await app?.close();
      vi.useRealTimers();
    }
  });
});
