/**
 * Shared mock factories, lifecycle hooks, and git/GitHub fixtures for the
 * `test/routes/tasks.test.ts` split suites (`tasks.test.ts` and the sibling
 * `tasks-*.test.ts` files extracted from it).
 *
 * Import order constraint: `taskPromoteMocks` is a plain module-level object
 * (not `vi.hoisted`), which works because this file has no runtime `src/`
 * imports (only `import type` and `./null-task-file-reads.js`). Suites must
 * import this harness before any `src/` module, and this file must not gain
 * runtime `src/` imports at module top level.
 */
import { vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { buildApp } from "../../src/app.js";
import type { SessionBackend } from "../../src/services/session-backend.js";
import { nullTaskFileReads } from "./null-task-file-reads.js";

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

export const taskPromoteMocks = {
  promoteTaskToPR: vi.fn(),
  closeDraftPRForTask: vi.fn(),
};

export function mockTaskPromoteFactory() {
  return {
    promoteTaskToPR: taskPromoteMocks.promoteTaskToPR,
    closeDraftPRForTask: taskPromoteMocks.closeDraftPRForTask,
  };
}

// `resolveBackend` returns the WHOLE SessionBackend interface, so a fake
// remote backend has to satisfy all of it — a fake missing members would
// fail at runtime with a TypeError that reads like a product bug rather
// than a test-double gap. The members these tests never exercise are inert
// stubs; the ones they do are passed in as overrides.
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
    uploadImage: vi.fn().mockResolvedValue({ path: "/remote/upload" }),
    uploadFile: vi.fn().mockResolvedValue({ path: "/remote/upload.bin" }),
    resolveReviewGate: vi.fn().mockResolvedValue(false),
    acknowledgeAttention: vi.fn().mockResolvedValue(false),
    prompt: vi.fn().mockResolvedValue({ ok: true, outputOffset: 0 }),
    waitOutput: vi.fn().mockResolvedValue({ notRunning: true }),
    createWorktree: vi.fn().mockResolvedValue(null),
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

// Claiming a task spawns a real session (routes/tasks.ts's claim endpoint
// reuses session-lifecycle.ts's createSessionRecord) — faked the same way
// test/routes/sessions-worktree.test.ts fakes node-pty/systemd-run/dtach for its own
// worktree-isolation tests, so route tests exercise the route/DB layer
// without depending on a real systemd --user session existing in CI.
export function mockNodePtyFactory() {
  return {
    spawn: vi.fn(() => {
      const listeners: Array<(data: string) => void> = [];
      return {
        onData: (cb: (data: string) => void) => {
          listeners.push(cb);
          return { dispose: () => {} };
        },
        onExit: () => ({ dispose: () => {} }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
      };
    }),
  };
}

// `git` subprocesses (worktree creation, resolveDefaultBaseRef) are left real;
// everything else (`systemd-run`, `systemctl`, `dtach`) is faked.
export async function mockChildProcessFactory(importOriginal: () => Promise<typeof ChildProcess>) {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
}

let cachedGitEnv: (() => NodeJS.ProcessEnv) | null = null;
let cachedExecFileSync: typeof ChildProcess.execFileSync | null = null;

function getGitHelpers() {
  if (!cachedGitEnv || !cachedExecFileSync) {
    throw new Error("git() called before setupTasksRouteTestLifecycle() initialized git helpers");
  }
  return { gitEnv: cachedGitEnv, execFileSync: cachedExecFileSync };
}

export function git(cwd: string, args: string[]) {
  const { gitEnv, execFileSync } = getGitHelpers();
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

// #746 — unlike git() above (void, used for state-changing commands),
// this captures stdout for the clear-done branch-delete tests' own
// post-condition checks (did the branch actually survive/disappear).
export function gitOutput(cwd: string, args: string[]): string {
  const { gitEnv, execFileSync } = getGitHelpers();
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
}

const createdRepoDirs: string[] = [];

export function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-route-test-repo-"));
  createdRepoDirs.push(cwd);
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

// #729 — same shape as webhooks.test.ts's own createMatchingGitRepo: an
// `origin` remote pointing at owner/repo, so `resolveRepoRef` (parseGitRemote
// under the hood) resolves this project to a real repo the DELETE route's
// isIssueStillTrackable check can query.
export function createGitRepoWithRemote(owner: string, repo: string): string {
  const cwd = createGitRepo();
  git(cwd, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  return cwd;
}

// #729 — a stubbed PAT connection (real network call spied out), same
// pattern as webhooks.test.ts's own connectPat, so resolveGitHubToken has
// something to hand back before isIssueStillTrackable's getIssueState spy
// takes over.
export async function connectPat(app: TestApp, token: string) {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const { setPat } = await import("../../src/services/github-integration.js");
  await setPat(app, token);
  global.fetch = originalFetch;
}

export async function createTaskProject(
  app: TestApp,
  cwd: string,
  name = "local-crud-p",
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name, cwd },
  });
  return res.json().id as number;
}

/**
 * Registers beforeAll/afterAll/beforeEach/afterEach for a tasks route
 * test suite: isolated SQLite DB, CODEX_HOME/HOME scratch dirs, per-test
 * DB table resets, and mock defaults/resets.
 */
export function setupTasksRouteTestLifecycle(suiteSlug: string): void {
  const tmpDb = path.join(os.tmpdir(), `${suiteSlug}-${process.pid}.db`);
  let codexHome = "";
  let fakeHome = "";
  let dbTablesReady = false;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;

  beforeAll(async () => {
    const { gitEnv } = await import("../../src/services/git-env.js");
    const { execFileSync } = await import("node:child_process");
    cachedGitEnv = gitEnv;
    cachedExecFileSync = execFileSync;
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    // Claiming is flag-gated (independent review, PR #471 — see
    // routes/tasks.ts's own comment on POST /api/tasks/:id/claim); on for
    // claim tests, toggled off explicitly in tests that verify flag-off.
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    // Raised high so unrelated tests don't hit 429; cap enforcement has its own test.
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-tasks-codex-home-"));
    process.env.CODEX_HOME = codexHome;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-tasks-fake-home-"));
    process.env.HOME = fakeHome;
  });

  afterAll(async () => {
    const { closeDb } = await import("../../src/db/client.js");
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
    delete process.env.MULLION_TASK_MAX_CONCURRENT;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    while (createdRepoDirs.length > 0) {
      const dir = createdRepoDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
    process.env.MULLION_TASK_MAX_CONCURRENT = "1000";
    taskPromoteMocks.promoteTaskToPR.mockReset().mockResolvedValue({
      ok: true,
      prUrl: "https://github.com/test-owner/test-repo/pull/1",
      prNumber: 1,
    });
    taskPromoteMocks.closeDraftPRForTask.mockReset().mockResolvedValue(undefined);

    const { getDb } = await import("../../src/db/client.js");
    const { tasks, sessions, projects, hosts, settings, integrations } =
      await import("../../src/db/schema.js");
    const db = getDb();
    if (!dbTablesReady) {
      try {
        db.delete(tasks).run();
        db.delete(sessions).run();
        db.delete(projects).run();
        db.delete(hosts).run();
        db.delete(settings).run();
        db.delete(integrations).run();
        dbTablesReady = true;
      } catch (err) {
        // First beforeEach runs before buildApp() migrates tmpDb; any other error is real.
        if (!(err instanceof Error) || !err.message.includes("no such table")) {
          throw err;
        }
      }
    } else {
      db.delete(tasks).run();
      db.delete(sessions).run();
      db.delete(projects).run();
      db.delete(hosts).run();
      db.delete(settings).run();
      db.delete(integrations).run();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}
