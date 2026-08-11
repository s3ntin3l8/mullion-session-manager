import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Integration test for the actual mullion.mjs subprocess entry point — the
// thin spawned shim that core.test.ts/client.test.ts can't reach (those
// exercise the imported, coverage-counted core.mjs/client.mjs directly). A
// real `node mullion.mjs` child process stands in for what a user/agent
// actually invokes, against a real buildApp() control socket in this same
// process — mirrors test/hooks/forwarder.test.ts's and test/mcp/server.test.ts's
// "spawn the real entry point against a real listener" posture.

// Captures every spawned instance (not just created and discarded) so the
// events-tail test can push a real OSC title-change escape through a
// specific session's PTY after the fact — same pattern as
// test/plugins/control-socket.test.ts's own fakePtyChildren.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  constructor() {
    fakePtyChildren.push(this);
  }
  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit() {
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
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.emit("close", 0);
      });
      return ee;
    }),
  };
});

vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));

const { buildApp } = await import("../../src/app.js");
// The module-wide node:child_process mock above (for pty-manager.ts's own
// systemd-run bootstrap) would otherwise also swallow THIS test file's own
// use of spawn() to launch the real mullion.mjs child process below —
// importActual bypasses it for that one, unrelated use.
const { spawn: realSpawn } = await vi.importActual<typeof ChildProcess>("node:child_process");

const MULLION_PATH = fileURLToPath(new URL("../../src/cli/mullion.mjs", import.meta.url));

/** Runs the real mullion.mjs as a child process against `socketPath`, with a
 * clean env (NOT process.env — this test runs inside a real Mullion session
 * itself, whose own MULLION_HOOK_TOKEN/MULLION_SOCKET_PATH must not leak
 * into the child and get mistaken for the test server's). */
function runCli(
  args: string[],
  socketPath: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = realSpawn(process.execPath, [MULLION_PATH, ...args], {
      env: { PATH: process.env.PATH ?? "", MULLION_SOCKET_PATH: socketPath, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** For a streaming command (`events tail`) that runs until interrupted:
 * spawns the CLI, waits until `stdout` satisfies `until`, sends SIGINT, and
 * resolves once the process actually exits — proving both that real output
 * arrived AND that interrupt-driven shutdown completes cleanly. */
function runCliUntilInterrupted(
  args: string[],
  socketPath: string,
  until: (stdout: string) => boolean,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = realSpawn(process.execPath, [MULLION_PATH, ...args], {
      env: { PATH: process.env.PATH ?? "", MULLION_SOCKET_PATH: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (until(stdout)) child.kill("SIGINT");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("mullion.mjs (Phase 4, #134 PR6, spawned entry point)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("--help prints usage and exits 0 with no server needed", async () => {
    const { code, stdout } = await runCli(["--help"], "/nonexistent/mullion.sock");
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: mullion");
  });

  it("an unresolvable command exits 2 without ever touching the socket", async () => {
    const { code, stderr } = await runCli(["bogus"], "/nonexistent/mullion.sock");
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });

  it("reports a clear connection error when nothing is listening", async () => {
    const { code, stderr } = await runCli(["ps"], "/nonexistent/mullion.sock");
    expect(code).toBe(1);
    expect(stderr).toContain("cannot connect to control socket");
  });

  it("config reports the resolved socket path and full scope against a real server (auth disabled)", async () => {
    app = await buildApp();
    await app.ready();
    const { code, stdout } = await runCli(["config"], app.pty.controlSocketPath);
    expect(code).toBe(0);
    expect(stdout).toContain(app.pty.controlSocketPath);
    expect(stdout).toContain("scope:   full");
  });

  it("ps lists sessions as JSON via --json against a real server", async () => {
    app = await buildApp();
    await app.ready();
    const { code, stdout } = await runCli(["ps", "--json"], app.pty.controlSocketPath);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("creates a project + session through the real REST routes and reads it back via the CLI", async () => {
    app = await buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const { code, stdout } = await runCli(
      ["session", "create", "--project", String(projectId), "--command", "bash", "--json"],
      app.pty.controlSocketPath,
    );
    expect(code).toBe(0);
    const created = JSON.parse(stdout);
    expect(created.projectId).toBe(projectId);

    const { code: getCode, stdout: getStdout } = await runCli(
      ["session", "get", String(created.id), "--json"],
      app.pty.controlSocketPath,
    );
    expect(getCode).toBe(0);
    expect(JSON.parse(getStdout).id).toBe(created.id);
  });

  it("browser click without a target exits 2 with a clear usage error, no server round trip", async () => {
    app = await buildApp();
    await app.ready();
    const { code, stderr } = await runCli(
      ["browser", "click", "--session", "1"],
      app.pty.controlSocketPath,
    );
    expect(code).toBe(2);
    expect(stderr).toContain("requires --ref or --selector");
  });

  it("notify errors clearly when run outside a session (no MULLION_HOOK_SOCKET)", async () => {
    const { code, stderr } = await runCli(
      ["notify", "--message", "hi"],
      "/nonexistent/mullion.sock",
    );
    expect(code).toBe(1);
    expect(stderr).toContain("MULLION_HOOK_SOCKET");
  });

  // Regression coverage for a real bug a code review caught: runEventsTail
  // originally checked for a {type:"event", event:{...}} wrapper that
  // doesn't exist on the wire — real event frames carry no "type" field at
  // all (docs/socket-api.md). Only a real spawned CLI against a real
  // server, printing a real title_change event, would have caught that;
  // the unit tests' fake stream fixtures didn't reproduce the actual shape.
  it("events tail prints a real title_change event triggered through a live session, then exits cleanly on interrupt", async () => {
    app = await buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    const before = fakePtyChildren.length;
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: project.json().id, command: "bash" },
    });
    const sessionId = created.json().id as number;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakePtyChildren.length).toBeGreaterThan(before);
    const pty = fakePtyChildren[fakePtyChildren.length - 1];

    const tailDone = runCliUntilInterrupted(
      ["events", "tail"],
      app.pty.controlSocketPath,
      (stdout) => stdout.includes("title_change"),
    );
    // Give the subscribe op time to land before triggering the event —
    // otherwise it could fire before the stream is even open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    pty.emitData("\x1b]2;hello-from-test\x07");
    // A1: the title_change EVENT is now debounced at the source
    // (pty-manager.ts's TITLE_CHANGE_EVENT_DEBOUNCE_MS, 3s) — this test's
    // own timeout is bumped below to give the real wait room.

    const { code, stdout } = await tailDone;
    expect(code).toBe(0);
    const line = stdout.split("\n").find((l) => l.includes("title_change")) as string;
    const event = JSON.parse(line);
    expect(event).toMatchObject({ sessionId, kind: "title_change" });
    // The stream's own multiplexing id (SocketChannel's internal plumbing)
    // must not leak into the printed event.
    expect(event).not.toHaveProperty("id");
  }, 10_000);
});
