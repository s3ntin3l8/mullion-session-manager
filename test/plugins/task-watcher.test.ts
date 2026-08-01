import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";

// Boot-time orphan sweep (6.8/#283) — this file only exercises the
// plugin's onReady wiring (does it call the sweep, on the right project,
// with the right delete list). The sweep's own removal/prune mechanics
// are covered directly by test/services/git-worktree.test.ts.
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects, tasks } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `task-watcher-plugin-test-${process.pid}.db`);

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-watcher-plugin-test-repo-"));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial", "--no-verify"]);
  return cwd;
}

// The boot sweep is fire-and-forget from onReady (Hermes review, PR #476 —
// awaiting it there would delay listen() itself), so app.ready() resolving
// doesn't mean the sweep has finished. Polls for its effect instead of a
// fixed delay.
async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

describe("taskWatcherPlugin: boot-time orphan worktree sweep (6.8/#283)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ROLE = "primary";
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  it("removes an orphan task worktree with no task row pointing at it, but keeps one an active task still references", async () => {
    const cwd = createGitRepo();
    const { createWorktree } = await import("../../src/services/git-worktree.js");
    const orphan = await createWorktree({ cwd, baseRef: "main", seed: "mullion/task-orphan" });
    const active = await createWorktree({ cwd, baseRef: "main", seed: "mullion/task-active" });
    expect(orphan).not.toBeNull();
    expect(active).not.toBeNull();

    // Inserted directly via app.db, never through app.inject(...) — inject()
    // itself triggers fastify's ready lifecycle, which would fire this
    // plugin's onReady sweep before a project created through it existed
    // yet (chicken-and-egg: the very first inject() call both creates the
    // project AND races the sweep that's supposed to see it).
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "boot-sweep-p", cwd })
      .returning()
      .all();
    app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "active task",
        status: "claimed",
        worktreePath: active!.path,
      })
      .run();

    await app.ready();
    await waitUntil(() => !fs.existsSync(orphan!.path));

    expect(fs.existsSync(orphan!.path)).toBe(false);
    expect(fs.existsSync(active!.path)).toBe(true);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("never touches a dock-preview worktree — only the mullion-task- naming prefix is in scope", async () => {
    const cwd = createGitRepo();
    const { checkoutBranchWorktree, createWorktree } =
      await import("../../src/services/git-worktree.js");
    const preview = await checkoutBranchWorktree(cwd, "main");
    expect(preview).not.toBeNull();
    // An actual orphan in the same project, used purely as a completion
    // signal for the fire-and-forget sweep (see waitUntil's own comment) —
    // its removal proves the sweep has run and finished for this project,
    // so a still-existing preview afterward is a real assertion, not a
    // race that happened to pass.
    const orphan = await createWorktree({ cwd, baseRef: "main", seed: "mullion/task-sentinel" });
    expect(orphan).not.toBeNull();

    const app = await buildApp();
    app.db.insert(projects).values({ name: "boot-sweep-preview-p", cwd }).run();

    await app.ready();
    await waitUntil(() => !fs.existsSync(orphan!.path));

    expect(fs.existsSync(preview!.path)).toBe(true);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});
