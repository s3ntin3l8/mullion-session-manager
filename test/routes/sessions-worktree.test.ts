// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  createProjectWithGitRepo,
  fakeChildProcess,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
// AFTER sessions-routes.js: this helper imports node:child_process, so
// importing it earlier would run the node:child_process mock factory before
// mockSpawnModule is initialised (see mock-pty.ts's header).
import { createGitRepo, fixtureGit as git } from "../helpers/git-fixture-repo.js";
import { describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { spawn as spawnChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/services/pty-manager.test.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test in test/routes/sessions-read.test.ts.
// `ptyMock.spawnedPtys[n].emitData(...)` (mock-pty.ts's listener-capturing
// variant) replaces the pre-split file's hand-rolled `fakePtyListeners` array.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Issue #1733 — the agent's own argv reaches the dtach MASTER's spawn (the
// child_process one), not the attach client's node-pty spawn, so the mock's
// calls have to be reachable from the test.
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

// Issue #271 follow-up — the opencode session transfer's own subprocess
// calls would otherwise hang; see mockSpawnModule's and opencodeTransferMock's
// doc comments in test/helpers/sessions-routes.ts.
vi.mock("../../src/services/opencode-session-transfer.js", () => opencodeTransferMock());

const { buildApp } = await import("../../src/app.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("worktree");

describe("sessions route: worktree isolation (launcher toggle and child cwd)", () => {
  describe("child spawn cwd containment (issue #1332)", () => {
    async function spawnChild(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      cwd: string,
    ) {
      const parent = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      return app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd, parentSessionId: parent.json().id },
      });
    }

    it("allows a child cwd that is a registered sibling worktree of the project's repo", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sibling = `${cwd}-sibling`;
      git(cwd, ["worktree", "add", sibling, "-b", "sibling-branch"]);

      const res = await spawnChild(app, projectId, sibling);
      expect(res.statusCode).toBe(201);
      expect(res.json().cwd).toBe(sibling);

      fs.rmSync(sibling, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("still rejects an arbitrary outside path, even another git repo or an unregistered sibling", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const foreign = createGitRepo();
      const unregistered = `${cwd}-unregistered`;
      fs.mkdirSync(unregistered);

      for (const outside of [foreign, unregistered, os.tmpdir()]) {
        const res = await spawnChild(app, projectId, outside);
        expect(res.statusCode).toBe(400);
      }

      fs.rmSync(foreign, { recursive: true, force: true });
      fs.rmSync(unregistered, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("option 1 — launcher worktree toggle", () => {
    it("spawns the session inside a fresh worktree when a worktree intent is given", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          worktree: { baseRef: "main", branchName: "feature/toggle" },
        },
      });

      expect(created.statusCode).toBe(201);
      const sessionCwd = created.json().cwd as string;
      expect(sessionCwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-toggle"));
      expect(fs.existsSync(sessionCwd)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("502s and creates no session row when the worktree fails to create (bad baseRef)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", worktree: { baseRef: "no-such-ref" } },
      });
      expect(created.statusCode).toBe(502);
      // Issue #677 (Hermes review) — the actual reason forwarded from
      // CreateWorktreeResult.detail, not just the hardcoded generic
      // fallback string every failure used to show.
      expect(created.json().message).toMatch(/invalid reference/i);

      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      expect(list.json()).toEqual([]);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("plain session creation (no worktree intent) is unaffected", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().cwd).toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // B6 — a failed LOCAL spawn used to return 201 with a live-looking
    // row and a created-but-never-cleaned-up worktree, because
    // LocalBackend.spawn() never actually rejected (see
    // session-backend.ts/pty-manager.ts's Session.spawn()). Forcing the
    // underlying `systemd-run` bootstrap to fail here proves the fix: the
    // spawn now genuinely rejects, this route's existing rollback catch
    // block (createSessionRecord, session-lifecycle.ts) actually runs, and
    // nothing — row or worktree — is left behind.
    it("rolls back the DB row and the worktree when the local spawn genuinely fails (B6)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
      vi.mocked(spawnChildProcess).mockImplementation(
        (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
          // Simulate a real local-spawn failure — missing systemd-run, a
          // scope-name collision, whatever the real cause — by making the
          // master-bootstrap subprocess exit non-zero. Everything else
          // (git for the worktree, systemctl elsewhere) behaves normally.
          if (command === "systemd-run") {
            const ee = new EventEmitter();
            setImmediate(() => ee.emit("exit", 1));
            return fakeChildProcess(ee);
          }
          return originalSpawnImpl!(command, args, options);
        },
      );

      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: {
            projectId,
            command: "bash",
            worktree: { baseRef: "main", branchName: "feature/spawn-fail" },
          },
        });

        // Not 201 with a dead session — the route surfaces the failure.
        expect(created.statusCode).toBe(502);

        // No orphaned DB row.
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        expect(list.json()).toEqual([]);

        // No orphaned worktree directory either — rolled back alongside
        // the row, not left registered nowhere for cleanup.
        const worktreePath = path.join(cwd, ".mullion-worktrees", "feature-spawn-fail");
        expect(fs.existsSync(worktreePath)).toBe(false);
      } finally {
        vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      }
    });

    // Fresh-review finding (Hermes, this PR): the DB-row rollback above
    // (B6) isn't the only thing this catch block needs to undo —
    // PtyManager.getOrCreate() (called internally by LocalBackend.spawn()
    // before the spawn it awaits) already inserted a Session into its own
    // in-memory `sessions` map and hook-token registry by the time spawn()
    // rejects.
    // Without an explicit eviction, that Session object (and its
    // hookToken -> id entry, which resolveToken() could still match
    // against) leaks for the lifetime of the process — the DB row is gone
    // but PtyManager still half-believes this session exists.
    it("evicts the failed session from PtyManager's in-memory map, not just the DB row", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      // A throwaway successful session first, purely to learn what id
      // SQLite will assign the NEXT inserted row — autoincrement rowids
      // only ever go up within this DB connection, and nothing else
      // writes to the `sessions` table between these two requests.
      const control = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(control.statusCode).toBe(201);
      const nextId = (control.json().id as number) + 1;

      const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
      vi.mocked(spawnChildProcess).mockImplementation(
        (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
          if (command === "systemd-run") {
            const ee = new EventEmitter();
            setImmediate(() => ee.emit("exit", 1));
            return fakeChildProcess(ee);
          }
          return originalSpawnImpl!(command, args, options);
        },
      );

      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(created.statusCode).toBe(502);

        // Not just "no DB row" (already covered above) — no leaked
        // in-memory Session either.
        expect(app.pty.get(String(nextId))).toBeUndefined();
      } finally {
        vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      }
    });

    // B9 — this catch block's app.pty.kill() eviction (above) deliberately
    // does NOT clear a stashed promote seed on its own (kill() is also
    // reached via killAll() on a redeploy, where that would be wrong — see
    // PtyManager.discardPendingSeed's own doc comment); this rollback path
    // is one of the genuinely-terminal callers that explicitly discards
    // it, alongside deleting the row. A real seed wouldn't normally exist
    // yet for a session that never spawned successfully, but the map key
    // is independent of whether a Session object exists — stash directly
    // against the predicted next id to exercise the same cleanup call.
    it("also discards any (defensively) stashed seed for the failed session's id", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const control = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(control.statusCode).toBe(201);
      const nextId = (control.json().id as number) + 1;
      app.pty.stashSeed(String(nextId), "some initial prompt");

      const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
      vi.mocked(spawnChildProcess).mockImplementation(
        (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
          if (command === "systemd-run") {
            const ee = new EventEmitter();
            setImmediate(() => ee.emit("exit", 1));
            return fakeChildProcess(ee);
          }
          return originalSpawnImpl!(command, args, options);
        },
      );

      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        expect(created.statusCode).toBe(502);
        expect(app.pty.consumeSeed(String(nextId))).toBeNull();
      } finally {
        vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      }
    });
  });
});
