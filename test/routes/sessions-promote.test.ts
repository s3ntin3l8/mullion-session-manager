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
  waitUntil,
} from "../helpers/sessions-routes.js";
// AFTER sessions-routes.js: this helper imports node:child_process, so
// importing it earlier would run the node:child_process mock factory before
// mockSpawnModule is initialised (see mock-pty.ts's header).
import { createGitRepo } from "../helpers/git-fixture-repo.js";
import { describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { execFileSync, spawn as spawnChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { gitEnv } from "../../src/services/git-env.js";
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
const { buildAgentGuideBlock, sessionAgentGuidePath } =
  await import("../../src/services/agent-guide.js");
const { transferOpencodeSession } = await import("../../src/services/opencode-session-transfer.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("promote");

describe("sessions route: promoting a session into a worktree", () => {
  describe("option 2 — POST /:id/promote", () => {
    async function createActiveSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
    ) {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      return created.json().id as number;
    }

    it("creates a worktree, spawns a new session there, and kills the source", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", branchName: "feature/promoted", seedPrompt: "pick up here" },
      });

      expect(res.statusCode).toBe(201);
      const newSession = res.json();
      expect(newSession.id).not.toBe(sourceId);
      expect(newSession.command).toBe("bash");
      expect(newSession.cwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-promoted"));
      expect(fs.existsSync(newSession.cwd)).toBe(true);
      // Phase 5 (Track B, issue #193 5.3b) — promote is a REPLACEMENT
      // (creates then kills the source), never a child; a promoted
      // session must not carry parentSessionId.
      expect(newSession.parentSessionId).toBe(null);

      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
      expect(sourceRow.status).toBe("killed");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a concurrent promote of the same session with 409 and releases the lock afterwards", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);
      const promote = (branchName: string) =>
        app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName },
        });

      const [a, b] = await Promise.all([promote("feature/race-a"), promote("feature/race-b")]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([201, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().message).toBe("Session is already being promoted");

      // Lock released in `finally`: a later call reaches the normal
      // not-active check (source was killed by the winner) instead.
      const later = await promote("feature/race-c");
      expect(later.statusCode).toBe(409);
      expect(later.json().message).toBe("Session is not active");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("inherits skipPermissions from the source session", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", skipPermissions: true },
      });
      const sourceId = created.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", branchName: "feature/promoted-skip" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        command: "bash",
        skipPermissions: true,
      });
      expect(res.json().id).not.toBe(sourceId);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("409s promoting a session that isn't active", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);
      await app.inject({ method: "DELETE", url: `/api/sessions/${sourceId}` });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });
      expect(res.statusCode).toBe(409);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("409s promoting a kind:'dock' session and creates no replacement row (#1233)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "docker compose up",
          kind: "dock",
          name: "docker-stack:demo-project",
        },
      });
      const sourceId = created.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main" },
      });
      expect(res.statusCode).toBe(409);

      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      expect(list.json()).toHaveLength(1);
      const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
      expect(sourceRow.status).toBe("active");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s promoting an unknown session", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/promote",
        payload: { baseRef: "main" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("502s and leaves the source session alive when the worktree fails to create", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "no-such-ref" },
      });
      expect(res.statusCode).toBe(502);

      const list = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}`,
      });
      const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
      expect(sourceRow.status).toBe("active");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // This route pre-resolves worktreePath itself (resolveWorktreeCwd,
    // above the createSessionRecord call) rather than passing a
    // `worktree` intent into createSessionRecord — unlike the B6 test
    // above (POST /api/sessions with `worktree: {...}`), so
    // createSessionRecord's OWN spawn-failure rollback never fires here
    // (its `if (worktree && cwd && cwd !== params.cwd)` guard is
    // unconditionally false: `worktree` is never passed). Before this
    // fix, a failed spawn left the worktree — and its branch — on disk;
    // proves the route's own explicit cleanup on the `!created.ok` path
    // now does what createSessionRecord's rollback would have.
    it("removes the worktree AND its branch when the promoted session's spawn fails, so a retry with the same branch name succeeds (Hermes review, PR #680)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);

      const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
      let failNextSpawn = true;
      vi.mocked(spawnChildProcess).mockImplementation(
        (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
          if (command === "systemd-run" && failNextSpawn) {
            failNextSpawn = false;
            const ee = new EventEmitter();
            setImmediate(() => ee.emit("exit", 1));
            return fakeChildProcess(ee);
          }
          return originalSpawnImpl!(command, args, options);
        },
      );

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName: "feature/promote-spawn-fail" },
        });
        expect(res.statusCode).toBe(502);

        const worktreePath = path.join(cwd, ".mullion-worktrees", "feature-promote-spawn-fail");
        expect(fs.existsSync(worktreePath)).toBe(false);

        // The branch half of the leak — removeWorktree alone never
        // deletes it (git-worktree.ts's own doc comment on why). Left
        // behind, a retry with the same branch name fails
        // "branch already exists" even after the directory is gone.
        const branches = execFileSync("git", ["branch", "--list", "feature/promote-spawn-fail"], {
          cwd,
          env: gitEnv(),
        }).toString();
        expect(branches.trim()).toBe("");

        // The source session is untouched — promote's own kill only runs
        // after a successful spawn, well past this failure.
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        const sourceRow = list.json().find((s: { id: number }) => s.id === sourceId);
        expect(sourceRow.status).toBe("active");

        // The actual point of the fix: a retry with the identical branch
        // name now succeeds instead of hitting a leftover-branch collision.
        const retry = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName: "feature/promote-spawn-fail" },
        });
        expect(retry.statusCode).toBe(201);
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      }
    });

    // Regression test for the reported 502 — the promote route used to
    // anchor `createWorktree`'s cwd on the SOURCE session's own cwd
    // (`row.cwd ?? project.cwd`). A source session whose cwd had been
    // removed out from under it (its own worktree deleted, e.g. by a
    // prior promote's cleanup or an out-of-band `git worktree remove`)
    // made every future promote fail with `git`'s raw
    // "fatal: cannot change to '<dir>': No such file or directory",
    // surfaced verbatim as a 502. Anchoring at `project.cwd` instead
    // (this fix) means a promote never depends on the source session's
    // cwd still existing.
    it("still promotes when the source session's own cwd has been deleted out from under it", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      // Give the source session a cwd that looks like a previous
      // promote's worktree, then delete it — reproducing a session whose
      // recorded cwd no longer resolves on disk.
      const deadCwd = path.join(cwd, ".mullion-worktrees", "gone");
      fs.mkdirSync(deadCwd, { recursive: true });
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: deadCwd },
      });
      const sourceId = created.json().id as number;
      fs.rmSync(deadCwd, { recursive: true, force: true });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", branchName: "feature/from-dead-cwd" },
      });

      expect(res.statusCode).toBe(201);
      const newSession = res.json();
      expect(newSession.cwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-from-dead-cwd"));
      expect(fs.existsSync(newSession.cwd)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, this PR — `createSessionRecord`'s `cwd-outside-project`
    // guard only applies to a CHILD spawn (a nonzero `parentSessionId`);
    // a plain top-level session (this test's shape) can carry an
    // arbitrary `cwd` in a completely different repo. Anchoring
    // unconditionally at `project.cwd` would silently promote such a
    // session into the WRONG repository instead of the one it actually
    // pointed at. Only a source cwd that resolves INSIDE the project gets
    // substituted — this proves the substitution is skipped otherwise.
    it("promotes from the source session's own (different) repo when its cwd is outside the project", async () => {
      const app = await buildApp();
      const projectCwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, projectCwd);

      const foreignCwd = createGitRepo();
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: foreignCwd },
      });
      const sourceId = created.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", branchName: "feature/from-foreign-repo" },
      });

      expect(res.statusCode).toBe(201);
      const newSession = res.json();
      // Landed under the FOREIGN repo's own .mullion-worktrees/, not the
      // project's — the pre-fix behavior, preserved for this case.
      expect(newSession.cwd).toBe(
        path.join(foreignCwd, ".mullion-worktrees", "feature-from-foreign-repo"),
      );
      expect(fs.existsSync(newSession.cwd)).toBe(true);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(foreignCwd, { recursive: true, force: true });
      await app.close();
    });

    // Companion to the dead-cwd case above: a source session that's
    // already INSIDE a worktree (e.g. a chained promote, or opencode's own
    // worktree feature moving it there) must not nest the new worktree
    // inside the old one. Before this fix, `createWorktree`'s `baseDir`
    // defaulted to `<row.cwd>/.mullion-worktrees` — anchoring at
    // `project.cwd` keeps every promote's worktree a direct sibling under
    // the project root's `.mullion-worktrees/`, regardless of where the
    // source session's own cwd happens to be.
    it("does not nest the new worktree inside the source session's own worktree", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const sourceCreated = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          worktree: { baseRef: "main", branchName: "feature/source-worktree" },
        },
      });
      const sourceId = sourceCreated.json().id as number;
      const sourceCwd = sourceCreated.json().cwd as string;
      expect(sourceCwd).toBe(path.join(cwd, ".mullion-worktrees", "feature-source-worktree"));

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", branchName: "feature/promoted-from-worktree" },
      });

      expect(res.statusCode).toBe(201);
      const newSession = res.json();
      // Directly under the project's own .mullion-worktrees/, not nested
      // under the source session's worktree.
      expect(newSession.cwd).toBe(
        path.join(cwd, ".mullion-worktrees", "feature-promoted-from-worktree"),
      );
      expect(newSession.cwd.startsWith(sourceCwd)).toBe(false);
      expect(fs.existsSync(newSession.cwd)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Same rollback guarantee as the "removes the worktree AND its
    // branch" test above, but from a source session whose cwd is already
    // gone — proving the rollback's own `removeWorktree`/`deleteBranch`
    // calls are anchored at `project.cwd` too, not just the initial
    // `resolveWorktreeCwd` call. Before this fix, both rollback calls
    // reused `row.cwd ?? project.cwd`, so a failed spawn from a dead
    // source cwd leaked the worktree AND its branch with no cleanup.
    it("still rolls back the worktree and branch on spawn failure when the source cwd is gone", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const deadCwd = path.join(cwd, ".mullion-worktrees", "gone-2");
      fs.mkdirSync(deadCwd, { recursive: true });
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: deadCwd },
      });
      const sourceId = created.json().id as number;
      fs.rmSync(deadCwd, { recursive: true, force: true });

      const originalSpawnImpl = vi.mocked(spawnChildProcess).getMockImplementation();
      let failNextSpawn = true;
      vi.mocked(spawnChildProcess).mockImplementation(
        (command: string, args: readonly string[], options: ChildProcess.SpawnOptions) => {
          if (command === "systemd-run" && failNextSpawn) {
            failNextSpawn = false;
            const ee = new EventEmitter();
            setImmediate(() => ee.emit("exit", 1));
            return fakeChildProcess(ee);
          }
          return originalSpawnImpl!(command, args, options);
        },
      );

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", branchName: "feature/promote-from-dead-cwd-fail" },
        });
        expect(res.statusCode).toBe(502);

        const worktreePath = path.join(
          cwd,
          ".mullion-worktrees",
          "feature-promote-from-dead-cwd-fail",
        );
        expect(fs.existsSync(worktreePath)).toBe(false);

        const branches = execFileSync(
          "git",
          ["branch", "--list", "feature/promote-from-dead-cwd-fail"],
          { cwd, env: gitEnv() },
        ).toString();
        expect(branches.trim()).toBe("");
      } finally {
        vi.mocked(spawnChildProcess).mockImplementation(originalSpawnImpl!);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("delivers the seed prompt to the new session's SessionStart hook", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", seedPrompt: "resume the refactor" },
      });
      const newSessionId = res.json().id as number;

      const session = app.pty.get(String(newSessionId));
      expect(session).toBeDefined();
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session!.hookToken })}\n`);
      const replyPromise = new Promise<string>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const idx = buffer.indexOf("\n");
          if (idx !== -1) resolve(buffer.slice(0, idx));
        });
      });
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
      // Issue #405 — composed with the guide pointer (default settings,
      // and this repo checkout ships docs/agent-guide.md), never in place
      // of the seed itself.
      const guidePath = sessionAgentGuidePath(
        path.dirname(app.pty.hookSocketPath),
        String(newSessionId),
      );
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: `resume the refactor\n\n${buildAgentGuideBlock(guidePath, false)}`,
      });
      socket.destroy();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, this PR — the fix's actual headline behavior: for a
    // source command with a matched adapter that has `initialPromptArgs`
    // (opencode's `--prompt`, verified against the real CLI in
    // hook-adapters/opencode.ts's own comment), the seed must reach the
    // replacement session as a SUBMITTED FIRST TURN (argv), not as
    // context injected via the SessionStart round trip above — the whole
    // point of this fix is that the old context-only delivery left the
    // replacement sitting idle with an unsubmitted seed.
    it("delivers the promote seed as initialPrompt argv for a seed-capable source command (opencode), not the SessionStart channel", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "opencode" },
      });
      const sourceId = created.json().id as number;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", seedPrompt: "resume the refactor" },
      });
      expect(res.statusCode).toBe(201);
      const newSessionId = res.json().id as number;

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([command]) => command === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("opencode --standalone --prompt 'resume the refactor'");

      // Never delivered a second time via the SessionStart channel too —
      // the never-both guard means this session has no stashed seed at
      // all, so a manual session_start only gets the guide pointer.
      const session = app.pty.get(String(newSessionId));
      expect(session).toBeDefined();
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session!.hookToken })}\n`);
      const replyPromise = new Promise<string>((resolve) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const idx = buffer.indexOf("\n");
          if (idx !== -1) resolve(buffer.slice(0, idx));
        });
      });
      socket.write(`${JSON.stringify({ kind: "session_start" })}\n`);
      const guidePath = sessionAgentGuidePath(
        path.dirname(app.pty.hookSocketPath),
        String(newSessionId),
      );
      expect(JSON.parse(await replyPromise)).toEqual({
        additionalContext: buildAgentGuideBlock(guidePath, false),
      });
      socket.destroy();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Issue #678 — the test above fires SessionStart manually AFTER the
    // promote POST has already fully returned, so it proves the seed is
    // consumable but doesn't exercise the actual race createSessionRecord
    // used to have: the previous code stashed the seed only AFTER the new
    // session's spawn had already been kicked off, so a fast-starting
    // agent's own SessionStart could in principle fire before the stash
    // landed. This asserts the real ordering fix directly — stashSeed
    // must be called before the new session's spawn is ever attempted,
    // not just "both eventually get called."
    it("stashes the seed BEFORE spawning the new session (issue #678 — the actual race fix)", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const sourceId = await createActiveSession(app, projectId);

      const callOrder: string[] = [];
      const originalStashSeed = app.pty.stashSeed.bind(app.pty);
      const originalGetOrCreate = app.pty.getOrCreate.bind(app.pty);
      const stashSeedSpy = vi
        .spyOn(app.pty, "stashSeed")
        .mockImplementation((id: string, seed: string) => {
          callOrder.push("stashSeed");
          return originalStashSeed(id, seed);
        });
      const getOrCreateSpy = vi
        .spyOn(app.pty, "getOrCreate")
        .mockImplementation((opts: Parameters<typeof originalGetOrCreate>[0]) => {
          callOrder.push("getOrCreate");
          return originalGetOrCreate(opts);
        });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sourceId}/promote`,
        payload: { baseRef: "main", seedPrompt: "resume the refactor" },
      });
      expect(res.statusCode).toBe(201);
      expect(callOrder).toEqual(["stashSeed", "getOrCreate"]);

      stashSeedSpy.mockRestore();
      getOrCreateSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // Issue #271 follow-up — full-context transfer. transferOpencodeSession
    // is mocked (see this file's own top-of-file comment on that mock) so
    // these tests exercise only the route's own decision logic: when to
    // attempt a transfer, and how its result changes what gets spawned.
    describe("opencode full-context transfer (issue #271 follow-up)", () => {
      async function createOpencodeSessionWithAgentSessionId(
        app: Awaited<ReturnType<typeof buildApp>>,
        projectId: number,
        agentSessionId: string,
      ): Promise<number> {
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "opencode" },
        });
        const sourceId = created.json().id as number;
        const session = app.pty.get(String(sourceId))!;

        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(app.pty.hookSocketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
        socket.write(`${JSON.stringify({ kind: "agent_session", sessionId: agentSessionId })}\n`);
        await waitUntil(() => session.agentSessionId === agentSessionId);
        socket.destroy();
        return sourceId;
      }

      it("wires a successful transfer's new session id into --session argv with no --prompt, and surfaces a note instead of a nudge", async () => {
        // Empirically, opencode's bare TUI silently drops `--prompt` when
        // paired with `--session`/`--continue` (see hook-adapters/
        // opencode.ts's `resumeSessionArgs` comment) — so a successful
        // transfer must NOT synthesize a continuation nudge as
        // `initialPrompt`; it must ship `--session` alone and tell the
        // user via `warnings[]` instead.
        vi.mocked(transferOpencodeSession).mockReset().mockResolvedValue({
          transferred: true,
          newSessionId: "ses_transferred_abc",
        });
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createOpencodeSessionWithAgentSessionId(
          app,
          projectId,
          "ses_source_live",
        );

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", seedPrompt: "resume the refactor" },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().warnings).toEqual([
          "Full conversation history was carried over — the new session is picking up right where you left off and is waiting for your next message.",
        ]);

        // Runs from `repoCwd` (the project root), not the source
        // session's own `row.cwd` — #693's fix exists precisely because
        // that directory can be a prior promote's now-deleted worktree.
        expect(transferOpencodeSession).toHaveBeenCalledWith(
          expect.objectContaining({ agentSessionId: "ses_source_live", sourceCwd: cwd }),
        );

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([command]) => command === "systemd-run");
        const args = call?.[1] as string[];
        const finalCommand = args[args.length - 1]!;
        expect(finalCommand).toContain("--session 'ses_transferred_abc'");
        expect(finalCommand).not.toContain("--prompt");
        // The original seed text must NOT be resubmitted — it's already
        // part of the transferred history, and --prompt would be dropped
        // silently on resume anyway.
        expect(finalCommand).not.toContain("resume the refactor");
        expect(finalCommand).not.toContain("Continue where you left off");

        // Hermes review, PR #696 — the caller's seedPrompt must not be
        // silently discarded outright just because a transfer succeeded:
        // it still has a live, resume-safe channel (opencode's static
        // per-session seed file, NOT the CLI --prompt mechanism the
        // assertions above correctly keep it out of).
        const newSessionId = res.json().id as number;
        const seedFilePath = path.join(
          path.dirname(app.pty.hookSocketPath),
          `${newSessionId}.opencode-seed.md`,
        );
        expect(fs.readFileSync(seedFilePath, "utf8")).toBe("resume the refactor");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("falls back to the ordinary seed and surfaces a warning when the transfer fails", async () => {
        vi.mocked(transferOpencodeSession)
          .mockReset()
          .mockResolvedValue({ transferred: false, reason: "opencode export failed" });
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createOpencodeSessionWithAgentSessionId(
          app,
          projectId,
          "ses_source_live",
        );

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", seedPrompt: "resume the refactor" },
        });
        expect(res.statusCode).toBe(201);
        // Hermes review, PR #696 — wording now depends on whether the
        // caller actually supplied a seedPrompt (this test does).
        expect(res.json().warnings).toEqual([
          "Couldn't carry over the full conversation history — the new session started with your seed prompt instead.",
        ]);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([command]) => command === "systemd-run");
        const args = call?.[1] as string[];
        const finalCommand = args[args.length - 1]!;
        expect(finalCommand).toContain("--prompt 'resume the refactor'");
        expect(finalCommand).not.toContain("--session");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      // Hermes review, PR #696 — "started with a summary instead" was
      // wrong when the caller supplied no seedPrompt at all: there's no
      // summary in that case, just a cold start.
      it("uses cold-start wording (not 'a summary') when the transfer fails and no seedPrompt was supplied", async () => {
        vi.mocked(transferOpencodeSession)
          .mockReset()
          .mockResolvedValue({ transferred: false, reason: "opencode export failed" });
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const sourceId = await createOpencodeSessionWithAgentSessionId(
          app,
          projectId,
          "ses_source_live",
        );

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main" },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().warnings).toEqual([
          "Couldn't carry over the full conversation history — the new session started fresh, with no prior context.",
        ]);

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });

      it("never attempts a transfer when this session has no known live agentSessionId", async () => {
        vi.mocked(transferOpencodeSession).mockReset();
        const app = await buildApp();
        const cwd = createGitRepo();
        const projectId = await createProjectWithGitRepo(app, cwd);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "opencode" },
        });
        const sourceId = created.json().id as number;

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${sourceId}/promote`,
          payload: { baseRef: "main", seedPrompt: "resume the refactor" },
        });
        expect(res.statusCode).toBe(201);
        expect(transferOpencodeSession).not.toHaveBeenCalled();

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });
});
