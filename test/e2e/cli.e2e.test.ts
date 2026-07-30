import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Issue #407's checklist item "CLI end-to-end": `mullion config`,
// `mullion ps --json`, `mullion session create`, `mullion logs`,
// `mullion events tail`, `mullion session kill`, run in that exact sequence
// against ONE real spawned mullion.mjs process per step (matching real CLI
// usage — a human runs each of these as a separate invocation) and a single
// real control socket. Modeled directly on test/cli/mullion.test.ts's own
// spawn/mock setup — see that file's comments for why node-pty and
// node:child_process's OWN spawn (the systemd-run/dtach bootstrap, not this
// file's own use of spawn to launch the real CLI) are faked: real dtach +
// systemd --user persistence is issue #407's one deliberately-manual
// checklist item (see test/e2e/README.md), not something this suite
// reproduces.
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
const { spawn: realSpawn } = await vi.importActual<typeof ChildProcess>("node:child_process");

const MULLION_PATH = fileURLToPath(new URL("../../src/cli/mullion.mjs", import.meta.url));

function runCli(
  args: string[],
  socketPath: string,
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
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

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

describe("mullion CLI — full advertised sequence against a real server (issue #407)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it("config -> ps --json -> session create -> logs -> events tail -> session kill", async () => {
    app = await buildApp();
    await app.ready();
    const socketPath = app.pty.controlSocketPath;

    // 1. `mullion config`
    const config = await runCli(["config"], socketPath);
    expect(config.code).toBe(0);
    expect(config.stdout).toContain(socketPath);
    expect(config.stdout).toContain("scope:   full");

    // 2. `mullion ps --json` — no sessions yet.
    const psEmpty = await runCli(["ps", "--json"], socketPath);
    expect(psEmpty.code).toBe(0);
    expect(JSON.parse(psEmpty.stdout)).toEqual([]);

    // 3. `mullion session create` — real project via the real REST route,
    // real session via the real CLI (not app.inject() directly), so this
    // step exercises the exact path a human/agent invocation would.
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "cli-e2e", cwd: "/tmp" },
    });
    const projectId = project.json().id as number;

    const before = fakePtyChildren.length;
    const created = await runCli(
      ["session", "create", "--project", String(projectId), "--command", "bash", "--json"],
      socketPath,
    );
    expect(created.code).toBe(0);
    const session = JSON.parse(created.stdout);
    expect(session.projectId).toBe(projectId);
    const sessionId = session.id as number;

    // `mullion ps --json` again — now shows the session the CLI itself
    // created, proving `ps` and `session create` share the same real state.
    const psAfter = await runCli(["ps", "--json"], socketPath);
    const listed = JSON.parse(psAfter.stdout);
    expect(listed.some((s: { id: number }) => s.id === sessionId)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakePtyChildren.length).toBeGreaterThan(before);
    const pty = fakePtyChildren[fakePtyChildren.length - 1];
    pty.emitData("hello-from-cli-e2e-logs\r\n");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 4. `mullion logs <id>` — raw scrollback bytes on stdout.
    const logs = await runCli(["logs", String(sessionId)], socketPath);
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("hello-from-cli-e2e-logs");

    // 5. `mullion events tail` — a real title_change event, triggered
    // through this same live session, interrupted cleanly with SIGINT.
    const tailDone = runCliUntilInterrupted(["events", "tail"], socketPath, (stdout) =>
      stdout.includes("title_change"),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    pty.emitData("\x1b]2;cli-e2e-title\x07");
    const tail = await tailDone;
    expect(tail.code).toBe(0);
    const eventLine = tail.stdout.split("\n").find((l) => l.includes("title_change")) as string;
    expect(JSON.parse(eventLine)).toMatchObject({ sessionId, kind: "title_change" });

    // 6. `mullion session kill <id>`.
    const killed = await runCli(["session", "kill", String(sessionId)], socketPath);
    expect(killed.code).toBe(0);

    const psFinal = await runCli(["ps", "--json"], socketPath);
    const finalList = JSON.parse(psFinal.stdout);
    const finalRow = finalList.find((s: { id: number }) => s.id === sessionId);
    expect(finalRow?.status).toBe("killed");
  });
});
