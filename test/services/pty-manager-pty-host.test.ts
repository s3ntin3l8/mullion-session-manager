import { describe, it, expect, afterEach, vi } from "vitest";
// The two helper imports must come before any import of "node-pty" or
// "node:child_process" — see test/services/pty-manager-file-change-ignore.test.ts's
// header for why the order matters to vitest's module mocking.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as IpcPath from "../../src/cli/ipc-path.mjs";
import type * as UnixSocket from "../../src/services/unix-socket.js";

// Issue #1728 — a Session whose endpoint is a named pipe (Windows) attaches
// through the in-process pty-host client, not `dtach -a`, and drives it
// exactly like a dtach client: output in, input/resize out, detach on kill(),
// and the "exited" path when the master goes away.
//
// Endpoints are pipes here because ipcPath is mocked to produce pipe names on
// any platform; nothing real is spawned (node-pty and node:child_process are
// mocked, and the scope backend is a stub), and the pty-host client is a
// fake recording what the Session does to it.

vi.mock("node-pty", () => plainNodePtyMock());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

vi.mock("../../src/cli/ipc-path.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcPath>();
  return {
    ...actual,
    ipcPath: (p: string) => `\\\\.\\pipe\\mullion-test-${path.basename(p, ".sock")}`,
  };
});

// The session's master is "already running": attach straight away.
vi.mock("../../src/services/unix-socket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof UnixSocket>();
  return { ...actual, probeSocket: vi.fn(async () => "live") };
});

type Listener<T> = (value: T) => void;
interface FakeClient {
  endpoint: string;
  size: { cols: number; rows: number };
  token: string;
  writes: string[];
  resizes: Array<[number, number]>;
  killed: number;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
}
const clients: FakeClient[] = [];

vi.mock("../../src/services/pty-host-client.js", () => ({
  attachPtyHost: vi.fn((endpoint: string, size: { cols: number; rows: number }, token: string) => {
    const data = new Set<Listener<string>>();
    const exit = new Set<Listener<{ exitCode: number }>>();
    const record: FakeClient = {
      endpoint,
      size,
      token,
      writes: [],
      resizes: [],
      killed: 0,
      emitData: (d) => data.forEach((l) => l(d)),
      emitExit: (code) => exit.forEach((l) => l({ exitCode: code })),
    };
    clients.push(record);
    return {
      onData: (l: Listener<string>) => (data.add(l), { dispose: () => data.delete(l) }),
      onExit: (l: Listener<{ exitCode: number }>) => (
        exit.add(l),
        { dispose: () => exit.delete(l) }
      ),
      write: (input: string) => record.writes.push(input),
      resize: (cols: number, rows: number) => record.resizes.push([cols, rows]),
      kill: () => {
        record.killed++;
        record.emitExit(0);
      },
    };
  }),
}));

const { PtyManager } = await import("../../src/services/pty-manager.js");
const { attachPtyHost } = await import("../../src/services/pty-host-client.js");
const { createPtyHostToken, readPtyHostToken } =
  await import("../../src/services/pty-host-token.js");

const stubScope = {
  kind: "stub",
  start: vi.fn(async () => undefined),
  isAliveBatch: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, "alive" as const])),
  ),
  stop: vi.fn(async () => undefined),
  listProcesses: vi.fn(async () => []),
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  clients.splice(0);
  vi.mocked(attachPtyHost).mockClear();
});

function mkSession(id: string, prepare?: (sessionsDir: string) => void) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-manager-pty-host-"));
  prepare?.(sessionsDir);
  const manager = new PtyManager({ sessionsDir, scope: stubScope });
  cleanups.push(() => {
    manager.killAll();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });
  const session = manager.getOrCreate({
    id,
    cwd: sessionsDir,
    command: "bash",
    cols: 90,
    rows: 30,
  });
  return { manager, session, sessionsDir };
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Session on a named-pipe endpoint (pty-host)", () => {
  it("attaches through the pty-host client at the session's pipe, at its size, with its token", async () => {
    const { session, sessionsDir } = mkSession("41", (dir) => createPtyHostToken(dir, "41"));
    await waitUntil(() => clients.length === 1);
    expect(clients[0].endpoint).toBe("\\\\.\\pipe\\mullion-test-41");
    expect(clients[0].size).toEqual({ cols: 90, rows: 30 });
    expect(clients[0].token).toBe(readPtyHostToken(sessionsDir, "41"));
    expect(clients[0].token).not.toBe("");
    expect(stubScope.start).not.toHaveBeenCalled();
    expect(session.isAlive).toBe(true);
  });

  it("feeds output to listeners, and sends input and resizes to the master", async () => {
    const { session } = mkSession("42");
    await waitUntil(() => clients.length === 1);
    const seen: string[] = [];
    session.onData((chunk: Buffer | string) => seen.push(String(chunk)));
    clients[0].emitData("hello from the master");
    await waitUntil(() => seen.join("").includes("hello from the master"));

    session.write("ls\r");
    session.resize(120, 40);
    expect(clients[0].writes.join("")).toContain("ls\r");
    expect(clients[0].resizes).toContainEqual([120, 40]);
  });

  it("detaches on kill() without stopping the scope", async () => {
    const { session } = mkSession("43");
    await waitUntil(() => clients.length === 1);
    session.kill();
    expect(clients[0].killed).toBe(1);
    expect(session.isAlive).toBe(false);
    expect(stubScope.stop).not.toHaveBeenCalled();
  });

  it("reports the session exited when the master goes away", async () => {
    const { session } = mkSession("44");
    await waitUntil(() => clients.length === 1);
    let exited = 0;
    session.onExit(() => exited++);
    clients[0].emitExit(3);
    expect(exited).toBe(1);
    expect(session.isAlive).toBe(false);
  });
});
