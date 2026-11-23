/**
 * Shared harness for the sessions-route test suites (test/routes/sessions*.test.ts).
 *
 * What lives here: the fixtures every one of those suites needs — a
 * throwaway project, a whole-interface `SessionBackend` double, the
 * scrollback/transcript helpers, the mock modules the suites install, and
 * the per-file database lifecycle. What deliberately does NOT live here:
 * the `vi.mock(...)` CALLS themselves. Those stay in each test file, one
 * line each, because a `vi.mock` factory is hoisted above every import in
 * its file and can only close over bindings that file owns (see
 * test/helpers/mock-pty.ts's header for the empirically confirmed
 * hoisting/ordering failure mode).
 *
 * Import-order constraint: this module must NOT gain a runtime `src/` import
 * at module top level. The suites import it BEFORE their `vi.mock("node-pty",
 * ...)` / `vi.mock("node:child_process", ...)` factories run, so a `src/`
 * module loaded from here could pull in the real node-pty before the mock is
 * registered. Everything from `src/` is therefore imported dynamically inside
 * the lifecycle hooks below.
 */
import { vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { SessionBackend } from "../../src/services/session-backend.js";
import type { buildApp } from "../../src/app.js";
import { mockChildProcessSpawn } from "./mock-spawn.js";
import { nullTaskFileReads } from "./null-task-file-reads.js";

/**
 * The `node:child_process` module the sessions-route suites install: the
 * systemd-run/dtach bootstrap spawn is faked, while `git` passes through to
 * the real binary (issue #271's worktree tests need real git subprocesses).
 *
 * Called from inside each suite's own hoisted `vi.mock("node:child_process",
 * ...)` factory — a hoisted mock factory can only close over the file's own
 * bindings, so the CALL stays in the test file and only the module it builds
 * lives here.
 */
export function mockSpawnModule(actual: unknown): typeof ChildProcess {
  return mockChildProcessSpawn(actual as typeof ChildProcess, { passthrough: ["git"] });
}

/**
 * The `opencode-session-transfer.js` module the sessions-route suites
 * install. Issue #271 follow-up — opencode-session-transfer.ts's own
 * subprocess calls (`opencode export`/`import`) would otherwise hit the
 * generic mockChildProcessSpawn fake above, which emits "exit" not "close"
 * and so would hang runOpencode() until its own internal timeout. Mocked one
 * layer up instead: the promote route tests only need to verify the ROUTE's
 * own decision logic (call the transfer, wire a success into the spawn argv,
 * surface a failure as a warning and fall back to the ordinary seed) — the
 * transfer service's own internals (id rewriting, subprocess handling) are
 * already covered directly in opencode-session-transfer.test.ts.
 */
export function opencodeTransferMock() {
  return { transferOpencodeSession: vi.fn() };
}

/** The Fastify instance `buildApp()` returns — the type every fixture takes. */
export type SessionsRouteApp = Awaited<ReturnType<typeof buildApp>>;

// Real PNG signature bytes — POST /api/sessions/:id/uploads now checks the
// body's actual magic bytes against the declared mime (issue #68
// hardening), not just the Content-Type header, so a happy-path upload test
// needs a real signature, not an arbitrary string.
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/**
 * `resolveBackend` returns the WHOLE SessionBackend interface, so a fake
 * remote backend has to satisfy all of it — a fake missing members would
 * fail at runtime with a TypeError that reads like a product bug rather
 * than a test-double gap. The members these tests never exercise are inert
 * stubs; the ones they do are passed in as overrides.
 */
export function fakeSessionBackend(overrides: Partial<SessionBackend>): SessionBackend {
  return {
    spawn: vi.fn().mockResolvedValue({}),
    liveStatus: vi.fn().mockResolvedValue({}),
    liveness: vi.fn().mockResolvedValue({}),
    compareWorktreePaths: vi.fn().mockResolvedValue([]),
    terminate: vi.fn().mockResolvedValue(undefined),
    getScrollback: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    getRenderedScrollback: vi.fn().mockResolvedValue(""),
    getTranscript: vi.fn().mockResolvedValue({ ok: false, status: 404, error: "not running" }),
    listSessionProcesses: vi.fn().mockResolvedValue([]),
    uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload.png" }),
    uploadFile: vi.fn().mockResolvedValue({ path: "/remote/upload.bin" }),
    resolveReviewGate: vi.fn().mockResolvedValue(false),
    acknowledgeAttention: vi.fn().mockResolvedValue(false),
    prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
    waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
    createWorktree: vi.fn().mockResolvedValue({ created: false, reason: "not-a-repo" }),
    checkoutBranchWorktree: vi.fn().mockResolvedValue(null),
    removeWorktree: vi.fn().mockResolvedValue(false),
    syncWorktree: vi.fn().mockResolvedValue(false),
    resumeTaskWorktree: vi.fn().mockResolvedValue(null),
    listTaskWorktreeDirs: vi.fn().mockResolvedValue([]),
    stashSeed: vi.fn().mockResolvedValue(undefined),
    resolvePendingPromote: vi.fn().mockResolvedValue(false),
    removeWorktreeIfClean: vi.fn().mockResolvedValue({ removed: false, reason: "not-a-repo" }),
    pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
    clearOrphanedTaskWorktree: vi.fn().mockResolvedValue({ cleared: true }),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: false, reason: "no-such-branch" }),
    checkoutBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    createBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    rebaseBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    pullBranch: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" }),
    removeListedWorktree: vi.fn().mockResolvedValue({ removed: false, reason: "not-listed" }),
    pruneWorktreeMetadata: vi.fn().mockResolvedValue({ pruned: false }),
    readTaskReviewFindings: vi.fn().mockResolvedValue(null),
    deleteTaskReviewFindings: vi.fn().mockResolvedValue(undefined),
    resolveSessionsDir: vi.fn().mockResolvedValue("/remote/sessions"),
    ...nullTaskFileReads(),
    ...overrides,
  };
}

/** Poll `check` on `setImmediate` ticks until it returns true or 50 ticks elapse. */
export async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

/** The browser-binding target a session on the local host reports. */
export const localTarget = (projectId: number) =>
  ({ projectId, hostId: "local", checkoutRoot: "/tmp", legacy: true }) as const;

/**
 * node's `spawn` is typed as returning a ChildProcess, but the fake child
 * the spawn-failure tests install is an EventEmitter that only ever emits an
 * event — the code under test (pty-manager.ts's bootstrapMaster) reads
 * nothing else off it. This is the ChildProcess surface, filled in with the
 * values a child that never really spawned would report: no piped stdio, no
 * pid, not connected, and the process-control methods as no-ops.
 */
export function fakeChildProcess(ee: EventEmitter): ChildProcess.ChildProcess {
  const stdio: ChildProcess.ChildProcess["stdio"] = [null, null, null, undefined, undefined];
  return Object.assign(ee, {
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    stdio,
    killed: false,
    pid: undefined,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "",
    kill: () => true,
    send: () => false,
    disconnect: () => {},
    unref: () => {},
    ref: () => {},
    [Symbol.dispose]: () => {},
  });
}

/** Create a throwaway project and return its id. */
export async function createProject(app: SessionsRouteApp): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
  });
  return res.json().id as number;
}

/**
 * A project whose checkout root is `cwd` — the git repo the worktree/promote
 * suites create first (see git-fixture-repo.ts's createGitRepo) and then
 * register as a project, so the route has a repo to make a worktree of.
 */
export async function createProjectWithGitRepo(
  app: SessionsRouteApp,
  cwd: string,
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "worktree-p", cwd },
  });
  return res.json().id as number;
}

/**
 * Register the beforeAll/afterAll/beforeEach/afterEach hooks every
 * sessions-route suite needs:
 *
 * - an isolated SQLite database of its own (one per suite, never shared
 *   with another suite — the slug keeps the file name unique even when two
 *   suites land in the same worker process);
 * - a per-test reset of the rows these suites create, so no test can see
 *   another's sessions, projects, previews, hosts or settings;
 * - a per-test reset of the recorded `node:child_process` spawn calls; and
 * - `vi.restoreAllMocks()` after every test, so a `vi.spyOn` a test installs
 *   on a `src/` module cannot leak into the next one (a leaked
 *   `resolveBackend` spy breaks the next test's session creation with a 502).
 *
 * The spawn reset requires the importing suite to have installed the
 * `node:child_process` mock: `vi.mocked(spawn).mockClear()` throws when
 * `spawn` is not a mock, so a suite that wants only the database lifecycle
 * must mock that module too.
 */
export function setupSessionsRouteLifecycle(suiteSlug: string): void {
  const dbPath = path.join(os.tmpdir(), `sessions-route-${suiteSlug}-${process.pid}.db`);
  let dbTablesReady = false;

  // SQLite's write-ahead log leaves two sidecar files next to the database;
  // a stale one from an earlier run would be a second copy of the data this
  // suite is about to reset, so they go with the database itself.
  const removeDbFiles = () => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  beforeAll(() => {
    removeDbFiles();
    process.env.DATABASE_URL = `file:${dbPath}`;
  });

  afterAll(async () => {
    const { closeDb } = await import("../../src/db/client.js");
    closeDb();
    removeDbFiles();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    const { getDb } = await import("../../src/db/client.js");
    const { hosts, previews, projects, sessions, settings } =
      await import("../../src/db/schema.js");
    const db = getDb();
    try {
      // Children first: `previews` and `sessions` both point at `projects`
      // (ON DELETE CASCADE), and `projects`/`sessions` point at `hosts`
      // WITHOUT a cascade, so the parents have to go last.
      db.delete(previews).run();
      db.delete(sessions).run();
      db.delete(projects).run();
      db.delete(hosts).run();
      db.delete(settings).run();
      dbTablesReady = true;
    } catch (err) {
      // The first beforeEach runs before buildApp() has migrated the file, so
      // the tables do not exist yet; any other error is real.
      if (!dbTablesReady && err instanceof Error && err.message.includes("no such table")) {
        return;
      }
      throw err;
    }
    // Clear the spawn call log too, so a test that inspects the spawns it
    // triggered never sees the ones an earlier test triggered. The module is
    // imported dynamically so this helper does not drag `node:child_process`
    // into the harness's own import graph (and with it the mock-factory
    // ordering constraint the suites' import order has to respect).
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
