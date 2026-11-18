import { vi } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { FastifyInstance } from "fastify";

export const TEST_TOKEN = "test-auth-token-0123456789";
export const TEST_SECRET = "test-session-secret-0123456789";
export const TEST_OIDC_ISSUER = "https://idp.test";
export const TEST_OIDC_CLIENT_ID = "test-oidc-client-id";
export const TEST_OIDC_CLIENT_SECRET = "test-oidc-client-secret";
export const TEST_OIDC_REDIRECT_URI = "https://mullion.test/api/auth/oidc/callback";

/**
 * The deadline for a wait that FOLLOWS a 3.2s source-side debounce: the
 * default 5s fires before the debounced event can even arrive, so the
 * test would fail on the ceiling rather than on the behaviour. The tests
 * that wait out a debounce pass this explicitly.
 */
export const DEBOUNCED_WAIT_MS = 20_000;

export const NOT_MINE = {
  ok: false,
  status: 403,
  error: "session-scoped connections may only target their own session or its children",
};

/**
 * Fake `node-pty` child process that records `write` / `resize` calls and
 * lets tests push synthetic PTY output through `emitData`.
 */
export class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<(e: { exitCode: number }) => void> = [];
  writeSpy = vi.fn();
  resizeSpy = vi.fn();

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: (e: { exitCode: number }) => void) {
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
 * Builds a listener-capturing `node-pty` mock for `vi.mock("node-pty", ...)`.
 * Every spawned `FakePty` is appended to `spawnedPtys`; reset `spawnedPtys.length = 0`
 * in `afterEach` so tests stay isolated.
 */
export function createControlSocketPtyMock() {
  const spawnedPtys: FakePty[] = [];
  const spawn = vi.fn(() => {
    const pty = new FakePty();
    spawnedPtys.push(pty);
    return pty;
  });
  return { spawnedPtys, spawn };
}

/**
 * Builds the `node:child_process` replacement object for control-socket tests:
 * fakes `spawn` with an EventEmitter that emits both `"exit"` and `"close"`
 * (needed by both the systemd-run/dtach bootstrap and `agent-detect.ts`'s `probe()`).
 */
export function mockControlSocketChildProcess(actual: typeof ChildProcess): typeof ChildProcess {
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      ee.stdout = new EventEmitter();
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.emit("close", 0);
      });
      return ee as unknown as ChildProcess.ChildProcess;
    }) as unknown as typeof ChildProcess.spawn,
  };
}

class FakeLocator {
  async ariaSnapshot() {
    return "- generic: Hello";
  }
  async all() {
    return [];
  }
}

class FakePage extends EventEmitter {
  currentUrl = "about:blank";
  async goto(url: string) {
    this.currentUrl = url;
  }
  url() {
    return this.currentUrl;
  }
  async title() {
    return "Test Page";
  }
  locator(_selector: string) {
    return new FakeLocator();
  }
  async evaluate(script: string) {
    if (script.includes("data-mullion-ref")) return [];
    return "eval-result";
  }
  getByText() {
    return new FakeLocator();
  }
  getByRole() {
    return new FakeLocator();
  }
  getByLabel() {
    return new FakeLocator();
  }
  getByPlaceholder() {
    return new FakeLocator();
  }
  getByTestId() {
    return new FakeLocator();
  }
}

class FakeBrowser extends EventEmitter {
  isConnected() {
    return true;
  }
  async newContext() {
    return { close: async () => {}, newPage: async () => new FakePage() };
  }
  async close() {}
}

/** Minimal Playwright fake for the browser.* ops. */
export function createControlSocketPlaywrightMock() {
  return {
    chromium: { launch: vi.fn(async () => new FakeBrowser()) },
  };
}

export function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });
}

/**
 * The options of a single `app.inject(...)` call.
 *
 * Fastify's `inject` is overloaded and TypeScript resolves `Parameters<>` to
 * its last no-arg overload, so the options are read through this helper.
 */
export type InjectedOptions = { method?: string; url?: string; payload?: unknown };

export function injectedOptions(spy: { mock: { calls: unknown[][] } }): InjectedOptions[] {
  return spy.mock.calls.map(([opts]) => opts as InjectedOptions);
}

/** Resolves with the first complete newline-terminated line the server writes back, JSON-parsed. */
export function waitForReply(socket: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) resolve(JSON.parse(buffer.slice(0, newlineIndex)));
    });
  });
}

/**
 * Waits until `check` is true, or the wall-clock deadline passes.
 */
export async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (check()) return;
  throw new Error(`condition never became true within ${timeoutMs}ms`);
}

/** Accumulates every complete newline-terminated line the server writes back onto this socket. */
export function collectFrames(socket: net.Socket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      frames.push(JSON.parse(buffer.slice(0, newlineIndex)));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  return frames;
}

/** Clears auth/role/OIDC/preview env vars mutated by control-socket tests. */
export function cleanupControlSocketEnv(): void {
  delete process.env.MULLION_AUTH_TOKEN;
  delete process.env.MULLION_SESSION_SECRET;
  delete process.env.MULLION_ROLE;
  delete process.env.MULLION_OIDC_ISSUER;
  delete process.env.MULLION_OIDC_CLIENT_ID;
  delete process.env.MULLION_OIDC_CLIENT_SECRET;
  delete process.env.MULLION_OIDC_REDIRECT_URI;
  delete process.env.PREVIEW_BASE_HOST;
}

/** Sets `MULLION_AUTH_TOKEN` and `MULLION_SESSION_SECRET` for authenticated control-socket tests. */
export function enableControlSocketAuthEnv(): void {
  process.env.MULLION_AUTH_TOKEN = TEST_TOKEN;
  process.env.MULLION_SESSION_SECRET = TEST_SECRET;
}

/**
 * Creates a real project + session via the REST routes so the DB row exists
 * and `PtyManager` holds the in-memory session and `hookToken`, then emits a
 * session-id-tagged scrollback marker through its `FakePty`.
 */
export async function createRealSession(
  app: FastifyInstance,
  ptyMock: { spawnedPtys: FakePty[] },
  options?: { skipPermissions?: boolean },
): Promise<{ sessionId: number; hookToken: string }> {
  const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: authHeaders,
    payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
  });
  const before = ptyMock.spawnedPtys.length;
  const created = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: authHeaders,
    payload: {
      projectId: project.json().id,
      command: "bash",
      ...(options?.skipPermissions !== undefined
        ? { skipPermissions: options.skipPermissions }
        : {}),
    },
  });
  const sessionId = created.json().id as number;
  const hookToken = app.pty.get(String(sessionId))!.hookToken;
  await waitUntil(() => ptyMock.spawnedPtys.length > before);
  ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1].emitData(
    `scrollback-marker-${sessionId}\r\n`,
  );
  return { sessionId, hookToken };
}

/** Opens a full-scope authenticated control-socket connection. */
export async function fullScopeSocket(app: FastifyInstance): Promise<net.Socket> {
  const socket = await connect(app.pty.controlSocketPath);
  socket.write(`${JSON.stringify({ token: TEST_TOKEN })}\n`);
  return socket;
}

/** Opens a session-scoped authenticated control-socket connection. */
export async function sessionScopeSocket(
  app: FastifyInstance,
  hookToken: string,
): Promise<net.Socket> {
  const socket = await connect(app.pty.controlSocketPath);
  socket.write(`${JSON.stringify({ token: hookToken })}\n`);
  return socket;
}

/** Spawns a child of the session behind `hookToken` through `sessions.spawn_child`. */
export async function spawnChildOf(
  app: FastifyInstance,
  hookToken: string,
  command = "bash",
): Promise<{ childId: number; childToken: string }> {
  const socket = await sessionScopeSocket(app, hookToken);
  socket.write(`${JSON.stringify({ id: 1, op: "sessions.spawn_child", body: { command } })}\n`);
  const reply = await waitForReply(socket);
  socket.destroy();
  if (reply.ok !== true) {
    throw new Error(`spawnChildOf failed: ${JSON.stringify(reply)}`);
  }
  const childId = (reply.result as { id: number }).id;
  return { childId, childToken: app.pty.get(String(childId))!.hookToken };
}

/** Sends a single control-socket request and awaits its reply frame. */
export async function ask(
  socket: net.Socket,
  op: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  socket.write(`${JSON.stringify({ id: 1, op, body })}\n`);
  return waitForReply(socket);
}
