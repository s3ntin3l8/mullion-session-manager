import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
// These three helper imports must come before any import of "node-pty" or
// "node:child_process" below (including transitively, e.g. via
// "node:child_process"'s own `execFileSync` import) — Vitest intercepts a
// mocked module at the position of its FIRST static import in the file's
// (transformed, sequential) evaluation order, and the mock factories below
// close over these helpers. If a "node:child_process" import appeared
// first, the factory would run before this binding was initialized
// (`ReferenceError: Cannot access '...' before initialization`) — see
// test/routes/ws-tasks.test.ts's identical header comment, the file this
// one's fix was modeled on.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { uniqueDir } from "../helpers/tmpdir.js";

// This file's whole point is exercising a REAL `git check-ignore` shell-out
// (Part B's isPathGitIgnored, wired into Session.emitHookEvent's file_change
// case). It used to run with NO mocks at all, reasoning that
// pty-manager.test.ts/sessions.test.ts's unconditional node:child_process
// mock would make a real "is this path ignored" check hang rather than ever
// seeing genuine git output, and that a real PTY spawn "isn't needed" since
// emitHookEvent's file_change filtering never touches the underlying pty
// process.
//
// That reasoning covered whether the test NEEDS a real spawn, not whether
// leaving one unmocked is safe. `manager.getOrCreate()` below unconditionally
// fires `session.spawn()`, which — with node:child_process/node-pty left
// unmocked — bootstraps a REAL `systemd-run --user --scope --collect`
// (pty-manager.ts's bootstrapMaster()) and a real `dtach -a` attach. Every
// run of this file left one or two genuine `crs-session-1.scope` units
// running forever: dtach never exits because the spawned `bash` never
// exits, and `--collect` only reaps a scope once its whole process tree is
// gone — see issue #1137, which traced a scratch dev instance's spawn
// failure to exactly one of these surviving for hours and squatting on the
// low session id a fresh SQLite DB reuses.
//
// This file's own `afterEach` (below) can't fix that by also stopping the
// scope: `killAll()` only kills the tracked attach-client and explicitly
// leaves the dtach master + scope running (PtyManager.kill()'s own doc
// comment) — only `PtyManager.terminate()` calls `stopScope()`, and calling
// terminate() here would trade one bug for a worse one. Scope names are a
// single Unix-user-global namespace (session-process.ts's
// scopeUnitName(id) doc comment) while `sessions.id` is per-database, so
// terminate()-ing this file's fixed test ids could stop a **different,
// real** Mullion instance's own low-numbered session on the same host.
//
// The actual fix is not creating the scope at all: `mockChildProcessSpawn`'s
// `passthrough` option (see its own header for this exact worked example,
// and test/routes/ws-tasks.test.ts for a working file that already combines
// it with a real git shell-out) fakes every command except `git`, so the
// real `git check-ignore` this file exists to test still runs, but the
// `systemd-run`/`dtach` spawns bootstrapMaster() and attachClient() make
// resolve instantly against a fake instead of touching the real OS.
vi.mock("node-pty", () => plainNodePtyMock());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

const { PtyManager } = await import("../../src/services/pty-manager.js");

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

// A single source of truth for the tmp-dir prefix, used by BOTH mkManager()
// (below) and the leak-detection afterAll() at the end of this file — issue
// #1137's fix would go silently vacuous if a future rename touched one
// without the other, since the afterAll assertion greps systemd unit
// descriptions for this exact string.
const SESSIONS_DIR_PREFIX = "pty-manager-filechange-test-";

let nextId = 1;

const tmpDirs: string[] = [];
const managers: InstanceType<typeof PtyManager>[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function mkManager(): InstanceType<typeof PtyManager> {
  const sessionsDir = uniqueDir(SESSIONS_DIR_PREFIX);
  tmpDirs.push(sessionsDir);
  const manager = new PtyManager({ sessionsDir });
  managers.push(manager);
  return manager;
}

// Regression guard for issue #1137: with node-pty/node:child_process mocked
// above, this file's spawns should never reach a real `systemd-run`, so no
// `crs-session-*.scope` unit should ever exist whose description names this
// file's own tmp-dir prefix. Skipped (not failed) when `systemctl --user`
// itself isn't available, matching this repo's existing
// `cond ? describe : describe.skip` idiom
// (test/e2e/opencode-permission-merge.e2e.test.ts) rather than the
// `describe.skipIf` form — CI's stock ubuntu-latest runners have no user
// systemd/dtach at all (see ci-cd.yml's own comment on this), so this must
// degrade to a no-op there rather than fail or hang.
function systemctlUserAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// File-scoped (not nested in a describe), so it runs once after every test
// below has finished, regardless of which describe block they're in.
if (systemctlUserAvailable()) {
  afterAll(() => {
    const listing = execFileSync(
      "systemctl",
      [
        "--user",
        "list-units",
        "--type=scope",
        "--all",
        "--no-legend",
        "--plain",
        "crs-session-*.scope",
      ],
      { encoding: "utf8" },
    );
    const leaked = listing.split("\n").filter((line) => line.includes(SESSIONS_DIR_PREFIX));
    expect(leaked).toEqual([]);
  });
}

describe("Session.emitHookEvent file_change git-ignore filtering (issue: sidebar worktree display, Part B)", () => {
  it("drops a file_change event for a path matched by .gitignore", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-ignored-project-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(projectCwd, ".claude"));

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: projectCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, ".claude", "plan.md"),
      action: "modify",
    });
    // A sentinel event, sent right after — once IT lands, the ignored one
    // (queued first, on the same serialized fileChangeQueue) has already
    // been checked and either emitted or dropped.
    session.emitHookEvent({ kind: "progress", phase: "done" });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "status_change"));

    const fileChangeEvents = session.getEvents().filter((e) => e.kind === "file_change");
    expect(fileChangeEvents).toHaveLength(0);
  });

  it("keeps a file_change event for a tracked (non-ignored) path", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-tracked-project-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: projectCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, "src", "index.ts"),
      action: "modify",
    });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "file_change"));

    const fileChangeEvents = session.getEvents().filter((e) => e.kind === "file_change");
    expect(fileChangeEvents).toHaveLength(1);
    expect(fileChangeEvents[0].payload).toEqual({
      path: path.join(projectCwd, "src", "index.ts"),
      action: "modify",
      agentId: null,
    });
  });

  it("resolves a relative Codex-style path against the session's cwd before checking", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-relative-project-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(projectCwd, ".claude"));

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: projectCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    // Relative path, as Codex's apply_patch-derived payload would send.
    session.emitHookEvent({ kind: "file_change", path: ".claude/plan.md", action: "modify" });
    session.emitHookEvent({ kind: "progress", phase: "done" });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "status_change"));

    expect(session.getEvents().filter((e) => e.kind === "file_change")).toHaveLength(0);
  });

  it("keeps the event for a session whose cwd isn't a git repo at all", async () => {
    const nonRepoCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-nonrepo-"));
    tmpDirs.push(nonRepoCwd);

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: nonRepoCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({ kind: "file_change", path: "whatever.ts", action: "modify" });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "file_change"));

    expect(session.getEvents().filter((e) => e.kind === "file_change")).toHaveLength(1);
  });

  // Perf audit finding B8(3) — Session.gitIgnoreDirCache memoizes by
  // directory, so a SECOND ignored file in the same already-checked
  // directory must still correctly land as dropped (served from the
  // cache, not a fresh `git check-ignore` this time) rather than the
  // memoization accidentally breaking the ignore filter for anything past
  // the first file in a directory.
  it("drops file_change events for MULTIPLE files in the same ignored directory (memoized path)", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-multi-ignored-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(projectCwd, ".claude"));

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: projectCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, ".claude", "plan.md"),
      action: "modify",
    });
    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, ".claude", "notes.md"),
      action: "create",
    });
    session.emitHookEvent({ kind: "progress", phase: "done" });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "status_change"));

    expect(session.getEvents().filter((e) => e.kind === "file_change")).toHaveLength(0);
  });

  it("preserves per-session event order across a rapid ignored-then-tracked pair", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-order-project-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(projectCwd, ".claude"));

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: String(nextId++),
      cwd: projectCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, ".claude", "plan.md"),
      action: "modify",
    });
    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, "a.ts"),
      action: "create",
    });
    session.emitHookEvent({
      kind: "file_change",
      path: path.join(projectCwd, "b.ts"),
      action: "create",
    });
    await waitUntil(() => session.getEvents().filter((e) => e.kind === "file_change").length >= 2);

    const paths = session
      .getEvents()
      .filter((e) => e.kind === "file_change")
      .map((e) => (e.payload as { path: string }).path);
    // The ignored one is dropped; the two tracked ones survive IN ORDER —
    // confirms fileChangeQueue's serialization doesn't just drop the ignored
    // path but also doesn't reorder the ones that do land.
    expect(paths).toEqual([path.join(projectCwd, "a.ts"), path.join(projectCwd, "b.ts")]);
  });
});
