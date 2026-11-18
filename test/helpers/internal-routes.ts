import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { WebSocket as NodeWebSocket } from "ws";
import type * as ScaffoldGenerateModule from "../../src/services/scaffold-generate.js";

export const INTERNAL_TEST_TOKEN = "test-agent-token";

// Real PNG signature bytes — /internal/uploads checks the body's actual
// magic bytes against the declared mime (issue #68 hardening), not just the
// Content-Type header, so a happy-path upload test needs a real signature,
// not an arbitrary string.
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** Fake `node-pty` child recording writes/resizes and allowing synthetic data emission. */
export class FakePty {
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

/**
 * Create a per-file `node-pty` mock harness for internal route tests.
 * Call `mockModule()` inside the file's hoisted `vi.mock("node-pty", ...)` and
 * `reset()` in `beforeEach` so no test relies on another's spawned children.
 */
export function createInternalPtyHarness() {
  const fakePtyChildren: FakePty[] = [];
  return {
    fakePtyChildren,
    mockModule: () => ({
      spawn: vi.fn(() => {
        const child = new FakePty();
        fakePtyChildren.push(child);
        return child;
      }),
    }),
    reset: () => {
      fakePtyChildren.length = 0;
    },
  };
}

/**
 * Create a per-file `node:child_process` mock harness for internal route tests.
 * Passes `git` through to the real binary while faking `systemctl`,
 * `systemd-run`, and shell probes, tracking active scope units and their
 * dtach socket paths in memory. Call `reset()` in `beforeEach`.
 */
export function createInternalChildProcessHarness() {
  // Track active scope units and their dtach socket paths across
  // `systemd-run`, `systemctl list-units`, and `systemctl stop` within a test.
  const activeScopeUnits = new Set<string>();
  const unitSocketPaths = new Map<string, string>();

  return {
    activeScopeUnits,
    unitSocketPaths,
    mockModule: (actual: typeof ChildProcess): typeof ChildProcess => ({
      ...actual,
      spawn: vi.fn((file: string, args: string[] = [], options?: unknown) => {
        if (file === "git") {
          return actual.spawn(file, args, options as ChildProcess.SpawnOptions);
        }

        const ee = new EventEmitter() as EventEmitter & {
          stdout?: EventEmitter;
          unref?: () => void;
        };
        // A real ChildProcess has .unref() (spawnSelfUpdate, issue #647, calls
        // it right after .on("error", ...)); without it, the handler throws
        // before app.close() runs and leaks the hooks socket.
        ee.unref = () => {};

        if (file === "systemctl" && args[1] === "list-units") {
          ee.stdout = new EventEmitter();
          setImmediate(() => {
            ee.emit("exit", 0);
            setImmediate(() => {
              const lines = [...activeScopeUnits]
                .map((unit) => {
                  const socketPath = unitSocketPaths.get(unit);
                  const description = socketPath
                    ? `/usr/bin/dtach -n ${socketPath} /usr/bin/zsh -lc bash`
                    : unit;
                  return `${unit} loaded active running ${description}`;
                })
                .join("\n");
              ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
              ee.emit("close", 0);
            });
          });
          return ee as unknown as ChildProcess.ChildProcess;
        }

        if (file === "systemd-run") {
          const unitIndex = args.indexOf("-u");
          if (unitIndex !== -1 && args[unitIndex + 1]) {
            const unit = `${args[unitIndex + 1]}.scope`;
            activeScopeUnits.add(unit);
            const dtachNIndex = args.indexOf("-n");
            if (dtachNIndex !== -1 && args[dtachNIndex + 1]) {
              unitSocketPaths.set(unit, args[dtachNIndex + 1]);
            }
          }
          setImmediate(() => ee.emit("exit", 0));
          return ee as unknown as ChildProcess.ChildProcess;
        }

        if (file === "systemctl" && args[1] === "stop") {
          const unit = args[2];
          if (unit) {
            activeScopeUnits.delete(unit);
            unitSocketPaths.delete(unit);
          }
          setImmediate(() => ee.emit("exit", 0));
          return ee as unknown as ChildProcess.ChildProcess;
        }

        // agent-detect probe(): `$SHELL -lc "command -v <bin>"` waits on 'close' only.
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
        return ee as unknown as ChildProcess.ChildProcess;
      }) as unknown as typeof ChildProcess.spawn,
    }),
    reset: () => {
      activeScopeUnits.clear();
      unitSocketPaths.clear();
    },
  };
}

/**
 * Create a per-file `bundle-sync` mock harness so internal route tests never
 * touch the test-runner's real `~/.claude`/`~/.agents`/`~/.gemini` directories.
 */
export function createBundleSyncHarness() {
  const uninstallBundleContentMock = vi.fn(async () => ({ removed: 0, legacySwept: 0 }));
  const runBundleSyncExclusiveMock = vi.fn(async (_enabled: boolean) => ({ changed: true }));

  return {
    uninstallBundleContentMock,
    runBundleSyncExclusiveMock,
    mockModule: () => ({
      uninstallBundleContent: () => uninstallBundleContentMock(),
      runBundleSyncExclusive: (enabled: boolean) => runBundleSyncExclusiveMock(enabled),
      isBundleSyncedFor: () => false,
      removeBundleContentForCli: vi.fn(),
    }),
    reset: () => {
      uninstallBundleContentMock.mockClear();
      uninstallBundleContentMock.mockResolvedValue({ removed: 0, legacySwept: 0 });
      runBundleSyncExclusiveMock.mockClear();
      runBundleSyncExclusiveMock.mockResolvedValue({ changed: true });
    },
  };
}

/** Build the `scaffold-generate.js` module mock without spawning real CLI/bwrap. */
export function mockScaffoldGenerateModule(
  actual: typeof ScaffoldGenerateModule,
): typeof ScaffoldGenerateModule {
  return {
    ...actual,
    runGenerationTurnInScratchWorktree: vi.fn(),
    isSandboxCapable: vi.fn().mockResolvedValue(true),
  };
}

/** Poll `check` on `setImmediate` ticks until it returns true or 50 ticks elapse. */
export async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

/** Wait for a DOM-style WebSocket to emit either `open` or `close`. */
export function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

/** Wait for a `ws` package client to open or reject/close. */
export function waitForNodeWsOutcome(ws: NodeWebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    ws.once("unexpected-response", () => resolve("close"));
    ws.once("error", () => resolve("close"));
  });
}

/** Retry sending `message` over `ws` until an echo frame arrives or `timeoutMs` elapses. */
export function sendUntilEcho(
  ws: NodeWebSocket,
  message: string,
  timeoutMs = 4000,
): Promise<string> {
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
      if (ws.readyState === 1 /* WebSocket.OPEN */) ws.send(message);
    }, 20);
  });
}

export interface InternalAgentEnv {
  readonly projectsRoot: string;
  setup(): void;
  teardown(): void;
}

/**
 * Manage the temp `projectsRoot` (with a seeded `git-repo`) and agent-role
 * environment variables (`MULLION_ROLE`, `MULLION_AGENT_TOKEN`,
 * `PROJECTS_ROOTS`, and saved/cleared `MULLION_SSH_AUTH_SOCK` / `SSH_AUTH_SOCK`).
 */
export function createInternalAgentEnv(token = INTERNAL_TEST_TOKEN): InternalAgentEnv {
  let projectsRoot = "";
  let prevSshAuthSock: string | undefined;
  let prevAmbientSshAuthSock: string | undefined;

  return {
    get projectsRoot() {
      return projectsRoot;
    },
    setup() {
      projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-discover-root-"));
      fs.mkdirSync(path.join(projectsRoot, "git-repo", ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(projectsRoot, "git-repo", ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:s3ntin3l8/mullion-session-manager.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      );
      process.env.MULLION_ROLE = "agent";
      process.env.MULLION_AGENT_TOKEN = token;
      process.env.PROJECTS_ROOTS = projectsRoot;
      prevSshAuthSock = process.env.MULLION_SSH_AUTH_SOCK;
      delete process.env.MULLION_SSH_AUTH_SOCK;
      prevAmbientSshAuthSock = process.env.SSH_AUTH_SOCK;
      delete process.env.SSH_AUTH_SOCK;
    },
    teardown() {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
      delete process.env.MULLION_ROLE;
      delete process.env.MULLION_AGENT_TOKEN;
      delete process.env.PROJECTS_ROOTS;
      if (prevSshAuthSock === undefined) delete process.env.MULLION_SSH_AUTH_SOCK;
      else process.env.MULLION_SSH_AUTH_SOCK = prevSshAuthSock;
      if (prevAmbientSshAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevAmbientSshAuthSock;
    },
  };
}

/** Build a Fastify app and bind it on `127.0.0.1:0` for WebSocket/HTTP proxy tests. */
export async function buildAndListen<
  T extends {
    listen(opts: { port: number; host: string }): Promise<unknown>;
    server: { address(): unknown };
  },
>(buildAppFn: () => Promise<T>): Promise<{ app: T; port: number }> {
  const app = await buildAppFn();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: (address as { port: number }).port };
}
