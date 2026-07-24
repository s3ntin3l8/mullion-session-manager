import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { PtyManager } from "../../src/services/pty-manager.js";
import { gitEnv } from "../../src/services/git-env.js";

// Deliberately does NOT mock node-pty or node:child_process, unlike
// pty-manager.test.ts and test/routes/sessions.test.ts — this file's whole
// point is exercising a REAL `git check-ignore` shell-out (Part B's
// isPathGitIgnored, wired into Session.emitHookEvent's file_change case).
// Those other files' child_process mock intercepts every spawn() call
// unconditionally (only special-casing `systemctl is-active`), which would
// make a real "is this path ignored" check hang until its own timeout rather
// than ever seeing genuine git output. A real dtach/systemd-run PTY spawn
// isn't needed for this: emitHookEvent's file_change filtering only reads
// Session's own in-memory cwd/liveCwd state and shells out to `git`
// directly — it doesn't touch the underlying pty process at all, so this
// test doesn't wait for (or depend on) the spawn succeeding, only on
// `manager.getOrCreate` returning a constructed Session.

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
}

// Each check may be waiting on a genuine `git` subprocess (isPathGitIgnored
// is a real spawn, not mocked in this file — see the file-level comment) —
// a plain setImmediate-loop poll doesn't give the OS enough real wall-clock
// time to complete more than one or two of those, so this uses a short real
// delay per iteration instead, generous enough for a handful of real `git
// check-ignore` invocations.
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

const tmpDirs: string[] = [];
const managers: InstanceType<typeof PtyManager>[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function mkManager(): InstanceType<typeof PtyManager> {
  const sessionsDir = path.join(
    os.tmpdir(),
    `pty-manager-filechange-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  tmpDirs.push(sessionsDir);
  const manager = new PtyManager({ sessionsDir });
  managers.push(manager);
  return manager;
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
      id: "1",
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
      id: "1",
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
      id: "1",
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
      id: "1",
      cwd: nonRepoCwd,
      command: "bash",
      cols: 80,
      rows: 24,
    });

    session.emitHookEvent({ kind: "file_change", path: "whatever.ts", action: "modify" });
    await waitUntil(() => session.getEvents().some((e) => e.kind === "file_change"));

    expect(session.getEvents().filter((e) => e.kind === "file_change")).toHaveLength(1);
  });

  it("preserves per-session event order across a rapid ignored-then-tracked pair", async () => {
    const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "filechange-order-project-"));
    tmpDirs.push(projectCwd);
    initRepo(projectCwd);
    fs.writeFileSync(path.join(projectCwd, ".gitignore"), ".claude/\n");
    fs.mkdirSync(path.join(projectCwd, ".claude"));

    const manager = mkManager();
    const session = manager.getOrCreate({
      id: "1",
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
