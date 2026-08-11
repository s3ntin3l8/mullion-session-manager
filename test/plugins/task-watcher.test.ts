import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { buildTestApp } from "../helpers/app.js";

// Boot-time orphan sweep (6.8/#283, widened to remote hosts by #484) — this
// file only exercises the plugin's onReady wiring (does it call the sweep,
// on the right project, with the right delete list). The sweep's own
// removal/prune mechanics are covered directly by
// test/services/git-worktree.test.ts.
const { closeDb } = await import("../../src/db/client.js");
const { projects, tasks } = await import("../../src/db/schema.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { HostUnreachableError } = await import("../../src/services/remote-host-client.js");

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
    const app = await buildTestApp();
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

    const app = await buildTestApp();
    app.db.insert(projects).values({ name: "boot-sweep-preview-p", cwd }).run();

    await app.ready();
    await waitUntil(() => !fs.existsSync(orphan!.path));

    expect(fs.existsSync(preview!.path)).toBe(true);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("#484 — sweeps a remote-hosted project's orphan worktrees through the SessionBackend proxy, and skips (without throwing) an unreachable host's projects", async () => {
    const app = await buildTestApp();
    const [okProject] = app.db
      .insert(projects)
      .values({ name: "boot-sweep-remote-ok-p", cwd: "/remote/ok", hostId: "remote-host-ok" })
      .returning()
      .all();
    app.db
      .insert(projects)
      .values({
        name: "boot-sweep-remote-down-p",
        cwd: "/remote/down",
        hostId: "remote-host-down",
      })
      .run();
    // A second project on the SAME unreachable host — proves the sweep
    // fails fast on the first error and skips the REST of that host's
    // projects, rather than retrying each one individually.
    app.db
      .insert(projects)
      .values({
        name: "boot-sweep-remote-down-p2",
        cwd: "/remote/down2",
        hostId: "remote-host-down",
      })
      .run();

    const okBackend = {
      listTaskWorktreeDirs: vi
        .fn()
        .mockResolvedValue(["/remote/ok/.mullion-worktrees/mullion-task-orphan"]),
      pruneWorktrees: vi.fn().mockResolvedValue({
        removed: ["/remote/ok/.mullion-worktrees/mullion-task-orphan"],
        skipped: [],
      }),
    };
    // A real HostUnreachableError, not a plain Error — the fail-fast path
    // (Hermes review, PR #590) only aborts the rest of a host's projects
    // for an actual transport-level failure, never for an arbitrary thrown
    // error.
    const downBackend = {
      listTaskWorktreeDirs: vi
        .fn()
        .mockRejectedValue(new HostUnreachableError("remote-host-down", new Error("ECONNREFUSED"))),
      pruneWorktrees: vi.fn(),
    };
    const realResolveBackend = sessionBackendModule.resolveBackend;
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation((appArg, hostId) => {
      if (hostId === "remote-host-ok") return okBackend as never;
      if (hostId === "remote-host-down") return downBackend as never;
      return realResolveBackend(appArg, hostId);
    });

    await app.ready();
    await waitUntil(() => okBackend.pruneWorktrees.mock.calls.length > 0);

    expect(okBackend.listTaskWorktreeDirs).toHaveBeenCalledWith(okProject.cwd);
    expect(okBackend.pruneWorktrees).toHaveBeenCalledWith(okProject.cwd, [
      "/remote/ok/.mullion-worktrees/mullion-task-orphan",
    ]);
    // Only ONE call for the down host's two projects — fail-fast, not a
    // per-project retry.
    expect(downBackend.listTaskWorktreeDirs).toHaveBeenCalledTimes(1);
    expect(downBackend.pruneWorktrees).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("#484, Hermes review PR #590 — a non-transport error (e.g. a local DB glitch) is per-project, never aborting the rest of that host's projects", async () => {
    const app = await buildTestApp();
    const [firstProject] = app.db
      .insert(projects)
      .values({ name: "boot-sweep-local-glitch-p1", cwd: "/local/one", hostId: "local" })
      .returning()
      .all();
    const [secondProject] = app.db
      .insert(projects)
      .values({ name: "boot-sweep-local-glitch-p2", cwd: "/local/two", hostId: "local" })
      .returning()
      .all();

    const localBackend = {
      listTaskWorktreeDirs: vi.fn().mockImplementation((cwd: string) => {
        if (cwd === firstProject.cwd)
          return Promise.reject(new Error("unexpected DB read failure"));
        return Promise.resolve([]);
      }),
      pruneWorktrees: vi.fn().mockResolvedValue({ removed: [], skipped: [] }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(localBackend as never);

    await app.ready();
    await waitUntil(() => localBackend.listTaskWorktreeDirs.mock.calls.length >= 2);

    // Both projects on the SAME host were attempted — the first project's
    // unrelated error didn't skip the second, unlike a real
    // HostUnreachableError/HostRequestError (covered by the test above).
    expect(localBackend.listTaskWorktreeDirs).toHaveBeenCalledWith(firstProject.cwd);
    expect(localBackend.listTaskWorktreeDirs).toHaveBeenCalledWith(secondProject.cwd);

    vi.restoreAllMocks();
  });
});
