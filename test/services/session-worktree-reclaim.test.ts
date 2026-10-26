import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { clearGitStatusCacheForTests } from "../../src/services/git-status.js";

// Never lets a real systemd-run fire (#1137).
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  // Real git: the point of these tests is what git itself reports.
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});

// The REAL execFileSync, for the fixtures: this module is mocked above.
const { execFileSync } = await vi.importActual<typeof ChildProcess>("node:child_process");

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects, sessions } = await import("../../src/db/schema.js");
const { reclaimSessionWorktree, sweepSessionWorktrees, sessionsAwaitingReclaim } =
  await import("../../src/services/session-worktree-reclaim.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const hostGitModule = await import("../../src/services/host-git.js");

// Issue #1964 — an isolated session's worktree is reclaimed once it ends, but
// only when that cannot lose anything: not in use, branch pushed or merged,
// tree clean. The branch is never deleted. These run against real repositories
// (a bare origin, a clone, real `git worktree`s) so the gates are checked
// against what git actually reports, not a stub of it.

const tmpDb = path.join(os.tmpdir(), `session-worktree-reclaim-${process.pid}.db`);

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();
}

function commit(cwd: string, file: string, message: string) {
  fs.writeFileSync(path.join(cwd, file), message);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", message, "--no-verify"]);
}

describe("reclaiming an ended session's worktree (issue #1964)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let origin: string;
  let repo: string;
  let projectId: number;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    clearGitStatusCacheForTests();
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-test-")));
    origin = path.join(base, "origin.git");
    repo = path.join(base, "repo");
    fs.mkdirSync(origin);
    git(origin, ["init", "--bare", "-b", "main"]);
    git(base, ["clone", origin, repo]);
    git(repo, ["checkout", "-b", "main"]);
    commit(repo, "README.md", "init");
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    const [project] = app.db
      .insert(projects)
      .values({ name: `reclaim-${Math.random()}`, cwd: repo, hostId: "local" })
      .returning()
      .all();
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** A worktree on its own `--no-track` branch, as Mullion creates them. */
  function addWorktree(slug: string): { dir: string; branch: string } {
    const dir = path.join(repo, ".mullion-worktrees", slug);
    const branch = `mullion/${slug}`;
    git(repo, ["worktree", "add", "--no-track", "-b", branch, dir, "origin/main"]);
    return { dir, branch };
  }

  /** A session row that owns `dir`, in the given state. */
  function sessionOwning(
    dir: string | null,
    branch: string | null,
    over: Partial<typeof sessions.$inferInsert> = {},
  ) {
    const [row] = app.db
      .insert(sessions)
      .values({
        projectId,
        command: "bash",
        cwd: dir,
        status: "killed",
        hostId: "local",
        worktreeBranch: branch,
        worktreeRepoCwd: branch === null ? null : repo,
        ...over,
      })
      .returning()
      .all();
    return row;
  }

  const rowOf = (id: number) =>
    app.db.select().from(sessions).where(eq(sessions.id, id)).get() as typeof sessions.$inferSelect;
  const branchExists = (branch: string) =>
    git(repo, ["branch", "--list", branch]).trim().length > 0;

  describe("what is reclaimed", () => {
    it("removes a clean worktree whose branch is pushed, and keeps the branch", async () => {
      const { dir, branch } = addWorktree("pushed");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });

      expect(fs.existsSync(dir)).toBe(false);
      // The commits survive: only the directory went.
      expect(branchExists(branch)).toBe(true);
      expect(rowOf(session.id).worktreeReclaimedAt).toBeInstanceOf(Date);
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
    });

    it("removes a worktree whose pushed branch was since deleted upstream (a merged PR)", async () => {
      const { dir, branch } = addWorktree("gone");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      git(origin, ["branch", "-D", branch]);
      git(repo, ["fetch", "--prune"]);
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("removes a worktree whose branch was merged, though it was never pushed", async () => {
      const { dir, branch } = addWorktree("merged");
      commit(dir, "work.txt", "work");
      git(repo, ["merge", "--no-edit", branch]);
      git(repo, ["push", "origin", "main"]);
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("removes a worktree that holds no commits of its own", async () => {
      const { dir, branch } = addWorktree("empty");
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("finds the branch when the recorded repo path is a subdirectory of the repository", async () => {
      // A monorepo project, or a session whose cwd was a package: the path has
      // no `.git` of its own, so it reads as "not a repository".
      const { dir, branch } = addWorktree("monorepo");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
      const session = sessionOwning(dir, branch, {
        worktreeRepoCwd: path.join(repo, "packages", "app"),
      });

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("counts a worktree as reclaimed when neither it nor its repository exists any more", async () => {
      // Removed by hand, or the project moved or was deleted: both branch
      // lookups come back empty. Not `branch-missing` forever.
      const gone = path.join(base, "no-such-repo");
      const session = sessionOwning(path.join(gone, ".mullion-worktrees", "x"), "mullion/x", {
        worktreeRepoCwd: gone,
      });

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(rowOf(session.id).worktreeReclaimedAt).toBeInstanceOf(Date);
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
    });

    it("counts a worktree already gone from disk as reclaimed, and touches nothing", async () => {
      const { dir, branch } = addWorktree("vanished");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      const session = sessionOwning(dir, branch);
      git(repo, ["worktree", "remove", "--force", dir]);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(rowOf(session.id).worktreeReclaimedAt).toBeInstanceOf(Date);
    });
  });

  describe("what is left in place, with the reason on the row", () => {
    it("keeps a worktree whose branch has commits that were never pushed or merged", async () => {
      const { dir, branch } = addWorktree("unpushed");
      commit(dir, "work.txt", "work");
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "unpushed",
      });

      expect(fs.existsSync(dir)).toBe(true);
      expect(rowOf(session.id).worktreeKeptReason).toBe("unpushed");
      expect(rowOf(session.id).worktreeReclaimedAt).toBeNull();
    });

    it("keeps a worktree pushed WITHOUT -u (no upstream to prove it by)", async () => {
      const { dir, branch } = addWorktree("no-upstream");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "origin", branch]);
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toMatchObject({
        status: "kept",
        reason: "unpushed",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("keeps a pushed worktree that has commits made since the push", async () => {
      const { dir, branch } = addWorktree("ahead");
      commit(dir, "one.txt", "one");
      git(dir, ["push", "-u", "origin", branch]);
      commit(dir, "two.txt", "two");
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toMatchObject({
        status: "kept",
        reason: "unpushed",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("never removes a worktree with uncommitted changes, even when its branch is pushed", async () => {
      const { dir, branch } = addWorktree("dirty");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      fs.writeFileSync(path.join(dir, "scratch.txt"), "not committed");
      const session = sessionOwning(dir, branch);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "dirty",
      });
      expect(fs.existsSync(path.join(dir, "scratch.txt"))).toBe(true);
      expect(rowOf(session.id).worktreeKeptReason).toBe("dirty");
    });

    it("keeps a worktree another active session is working in", async () => {
      const { dir, branch } = addWorktree("busy");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      const session = sessionOwning(dir, branch);
      // e.g. a reviewer opened in a subdirectory of it.
      sessionOwning(path.join(dir, "packages"), null, { status: "active" });

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "in-use",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("is not blocked by an active session in an unrelated directory", async () => {
      const { dir, branch } = addWorktree("alone");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      const session = sessionOwning(dir, branch);
      // A sibling whose path merely starts with the same characters.
      sessionOwning(`${dir}-other`, null, { status: "active" });

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
    });

    it("keeps a worktree whose branch no longer exists", async () => {
      const { dir, branch } = addWorktree("branchless");
      const session = sessionOwning(dir, branch);
      git(dir, ["checkout", "--detach"]);
      git(repo, ["branch", "-D", branch]);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "branch-missing",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("clears the reason once a later attempt succeeds", async () => {
      const { dir, branch } = addWorktree("later");
      commit(dir, "work.txt", "work");
      const session = sessionOwning(dir, branch);
      await reclaimSessionWorktree(app, session.id);
      expect(rowOf(session.id).worktreeKeptReason).toBe("unpushed");

      git(dir, ["push", "-u", "origin", branch]);
      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
    });
  });

  describe("what it does not touch", () => {
    it("skips a session that is still active", async () => {
      const { dir, branch } = addWorktree("live");
      const session = sessionOwning(dir, branch, { status: "active" });
      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "skipped",
        reason: "active",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("skips a session that owns no worktree, one already reclaimed, and an unknown id", async () => {
      const plain = sessionOwning(repo, null);
      await expect(reclaimSessionWorktree(app, plain.id)).resolves.toEqual({
        status: "skipped",
        reason: "no-worktree",
      });
      const { dir, branch } = addWorktree("done");
      const done = sessionOwning(dir, branch, { worktreeReclaimedAt: new Date() });
      await expect(reclaimSessionWorktree(app, done.id)).resolves.toEqual({
        status: "skipped",
        reason: "already-reclaimed",
      });
      await expect(reclaimSessionWorktree(app, 987654)).resolves.toEqual({
        status: "skipped",
        reason: "not-found",
      });
      expect(fs.existsSync(dir)).toBe(true);
    });

    it("does not run twice for one session at once", async () => {
      const { dir, branch } = addWorktree("racing");
      commit(dir, "work.txt", "work");
      git(dir, ["push", "-u", "origin", branch]);
      const session = sessionOwning(dir, branch);

      const [a, b] = await Promise.all([
        reclaimSessionWorktree(app, session.id),
        reclaimSessionWorktree(app, session.id),
      ]);

      expect([a.status, b.status].sort()).toEqual(["reclaimed", "skipped"]);
    });
  });

  describe("on a host that is not this one", () => {
    const REMOTE = "remote-host-1";

    function remoteSession() {
      return sessionOwning("/srv/proj/.mullion-worktrees/child", "mullion/child", {
        hostId: REMOTE,
        worktreeRepoCwd: "/srv/proj",
      });
    }

    type Liveness = "alive" | "dead" | "unknown";
    function fakeBackend(
      removal: { removed: boolean; reason?: string },
      // One answer for every session, or one per session id.
      liveness: Liveness | ((id: string) => Liveness) = "dead",
    ) {
      const removeWorktreeIfClean = vi.fn().mockResolvedValue(removal);
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        removeWorktreeIfClean,
        liveness: vi.fn(async (ids: string[]) =>
          Object.fromEntries(
            ids.map((id) => [id, typeof liveness === "function" ? liveness(id) : liveness]),
          ),
        ),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
      return removeWorktreeIfClean;
    }

    /** An ENDED session that worked inside the remote child's worktree. */
    function endedSibling(status: "killed" | "exited" = "killed") {
      return sessionOwning("/srv/proj/.mullion-worktrees/child/packages/app", null, {
        hostId: REMOTE,
        status,
      });
    }

    const pushed = {
      ok: true as const,
      value: [{ name: "mullion/child", isCurrent: false, upstream: "origin/mullion/child" }],
    };

    it("reads the branch and removes the worktree through that host, not the primary", async () => {
      const removeWorktreeIfClean = fakeBackend({ removed: true });
      const branchesSpy = vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue({
        ok: true,
        value: [{ name: "mullion/child", isCurrent: false, upstream: "origin/mullion/child" }],
      });
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });

      expect(branchesSpy).toHaveBeenCalledWith(expect.anything(), REMOTE, "/srv/proj");
      expect(sessionBackendModule.resolveBackend).toHaveBeenCalledWith(expect.anything(), REMOTE);
      expect(removeWorktreeIfClean).toHaveBeenCalledWith(
        "/srv/proj/.mullion-worktrees/child",
        "/srv/proj",
      );
    });

    it("defers, recording nothing, when the host cannot be asked", async () => {
      const removeWorktreeIfClean = fakeBackend({ removed: true });
      vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue({
        ok: false,
        reason: "unreachable",
        detail: "ECONNREFUSED",
      });
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "deferred",
      });

      expect(removeWorktreeIfClean).not.toHaveBeenCalled();
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
      expect(rowOf(session.id).worktreeReclaimedAt).toBeNull();
    });

    it("defers rather than throwing when the host fails mid-removal", async () => {
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        removeWorktreeIfClean: vi.fn().mockRejectedValue(new Error("socket hang up")),
        liveness: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "dead"]))),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
      vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue({
        ok: true,
        value: [{ name: "mullion/child", isCurrent: false, upstream: "origin/mullion/child" }],
      });
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "deferred",
      });
    });

    it("never removes a worktree whose session's process is still running", async () => {
      // A kill whose `terminate` failed still marks the row ended.
      const removeWorktreeIfClean = fakeBackend({ removed: true }, "alive");
      const branchesSpy = vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue({
        ok: true,
        value: [{ name: "mullion/child", isCurrent: false, isMerged: true }],
      });
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "still-running",
      });

      expect(removeWorktreeIfClean).not.toHaveBeenCalled();
      expect(branchesSpy).not.toHaveBeenCalled();
      expect(rowOf(session.id).worktreeKeptReason).toBe("still-running");
    });

    it("keeps a worktree a just-killed sibling's process is still exiting inside", async () => {
      // A cascade kill marks the children killed while their agents may still be
      // running in the parent's directory.
      const session = remoteSession();
      const sibling = endedSibling();
      const removeWorktreeIfClean = fakeBackend({ removed: true }, (id) =>
        id === String(sibling.id) ? "alive" : "dead",
      );
      const branchesSpy = vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue(pushed);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "in-use",
      });

      expect(removeWorktreeIfClean).not.toHaveBeenCalled();
      expect(branchesSpy).not.toHaveBeenCalled();
    });

    it("defers when it cannot tell whether an ended sibling's process is gone", async () => {
      const session = remoteSession();
      const sibling = endedSibling();
      const removeWorktreeIfClean = fakeBackend({ removed: true }, (id) =>
        id === String(sibling.id) ? "unknown" : "dead",
      );

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "deferred",
      });
      expect(removeWorktreeIfClean).not.toHaveBeenCalled();
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
    });

    it("is not held up by an ended sibling whose process is confirmed gone", async () => {
      const session = remoteSession();
      endedSibling("exited");
      fakeBackend({ removed: true });
      vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue(pushed);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
    });

    it("ignores an ended session on a different host that merely shares the path", async () => {
      const session = remoteSession();
      sessionOwning("/srv/proj/.mullion-worktrees/child/x", null, {
        hostId: "another-host",
        status: "killed",
      });
      // `another-host`'s process would read as alive — but it is another machine.
      fakeBackend({ removed: true }, "dead");
      vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue(pushed);

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "reclaimed",
      });
    });

    it("defers, touching nothing, when it cannot tell whether the process is gone", async () => {
      const removeWorktreeIfClean = fakeBackend({ removed: true }, "unknown");
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "deferred",
      });

      expect(removeWorktreeIfClean).not.toHaveBeenCalled();
      expect(rowOf(session.id).worktreeKeptReason).toBeNull();
    });

    it("keeps it, with the reason, when the host reports the tree is dirty", async () => {
      fakeBackend({ removed: false, reason: "dirty" });
      vi.spyOn(hostGitModule, "resolveHostBranches").mockResolvedValue({
        ok: true,
        value: [{ name: "mullion/child", isCurrent: false, isMerged: true }],
      });
      const session = remoteSession();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "kept",
        reason: "dirty",
      });
      expect(rowOf(session.id).worktreeKeptReason).toBe("dirty");
    });
  });

  describe("the periodic sweep", () => {
    it("reclaims every ended session whose branch has since been pushed, and reports what it did", async () => {
      const ready = addWorktree("ready");
      commit(ready.dir, "a.txt", "a");
      git(ready.dir, ["push", "-u", "origin", ready.branch]);
      const stuck = addWorktree("stuck");
      commit(stuck.dir, "b.txt", "b");
      const readySession = sessionOwning(ready.dir, ready.branch);
      const stuckSession = sessionOwning(stuck.dir, stuck.branch);
      // Not ended, not ours, and already done: none of these are attempted.
      sessionOwning(addWorktree("live").dir, "mullion/live", { status: "active" });
      sessionOwning(repo, null);

      await expect(sweepSessionWorktrees(app)).resolves.toEqual({
        reclaimed: 1,
        kept: 1,
        deferred: 0,
      });

      expect(rowOf(readySession.id).worktreeReclaimedAt).toBeInstanceOf(Date);
      expect(rowOf(stuckSession.id).worktreeKeptReason).toBe("unpushed");
      // The kept one is still waiting; the reclaimed one is not.
      expect(sessionsAwaitingReclaim(app, 10)).toEqual([stuckSession.id]);
    });

    it("stamps every attempt, including one that only deferred", async () => {
      const session = sessionOwning("/srv/proj/.mullion-worktrees/c", "mullion/c", {
        hostId: "remote-host-1",
        worktreeRepoCwd: "/srv/proj",
      });
      vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
        liveness: vi.fn(async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, "unknown"])),
        ),
      } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
      expect(rowOf(session.id).worktreeLastAttemptAt).toBeNull();

      await expect(reclaimSessionWorktree(app, session.id)).resolves.toEqual({
        status: "deferred",
      });

      expect(rowOf(session.id).worktreeLastAttemptAt).toBeInstanceOf(Date);
    });

    it("rotates what it cannot resolve to the back, so a dead host cannot crowd out the rest", async () => {
      const longAgo = new Date("2026-01-01T00:00:00Z");
      const lately = new Date("2026-06-01T00:00:00Z");
      const stuckLong = sessionOwning(repo, "mullion/a", { worktreeLastAttemptAt: longAgo });
      const stuckLately = sessionOwning(repo, "mullion/b", { worktreeLastAttemptAt: lately });
      const untried = sessionOwning(repo, "mullion/c");

      // Never tried, then the least recently tried - not simply the lowest id.
      expect(sessionsAwaitingReclaim(app, 10)).toEqual([untried.id, stuckLong.id, stuckLately.id]);
      // ...and a window smaller than the backlog still reaches the untried one.
      expect(sessionsAwaitingReclaim(app, 1)).toEqual([untried.id]);
    });

    it("tries sessions it has never attempted before ones already parked, within its limit", async () => {
      const parked = addWorktree("parked");
      commit(parked.dir, "p.txt", "p");
      const parkedSession = sessionOwning(parked.dir, parked.branch);
      await reclaimSessionWorktree(app, parkedSession.id);
      expect(rowOf(parkedSession.id).worktreeKeptReason).toBe("unpushed");

      const fresh = addWorktree("fresh");
      const freshSession = sessionOwning(fresh.dir, fresh.branch);

      // The parked one has the lower id, but the never-tried one goes first.
      expect(sessionsAwaitingReclaim(app, 1)).toEqual([freshSession.id]);
      expect(sessionsAwaitingReclaim(app, 10)).toEqual([freshSession.id, parkedSession.id]);
    });
  });
});
