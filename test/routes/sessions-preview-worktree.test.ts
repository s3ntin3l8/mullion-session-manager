// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  fakeSessionBackend,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("preview-worktree");

describe("sessions route: the dock preview worktree", () => {
  // env: gitEnv() (issue #205) — this test file runs as a subprocess of
  // `npm test`, itself sometimes invoked from inside a git hook (e.g. the
  // pre-push hook that runs this very suite): a leaked GIT_DIR/
  // GIT_INDEX_FILE/etc. from that outer git operation would otherwise
  // redirect these fixture-repo commands onto the REAL repo's .git
  // instead of the temp dir passed via `cwd` — exactly the corruption
  // class gitEnv() exists to prevent (see git-refs.test.ts's identical
  // guard on its own git() helper).
  function git(cwd: string, args: string[]) {
    execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
  }

  function createGitRepo(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-worktree-test-"));
    git(cwd, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", "initial", "--no-verify"]);
    return cwd;
  }

  async function createProjectWithGitRepo(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "worktree-p", cwd },
    });
    return res.json().id as number;
  }

  describe("option 3 — dock preview worktree", () => {
    it("creates a dock preview worktree and starts a session inside it", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          projectId,
          command: "bash",
          worktree: { branch: "main" },
          worktreeRefresh: true,
        },
      });

      expect(created.statusCode).toBe(201);
      const session = created.json();
      // Dock preview worktrees live under .mullion-worktrees/dock-preview-*
      expect(session.cwd).toMatch(/\.mullion-worktrees\/dock-preview-main-/);
      expect(fs.existsSync(session.cwd)).toBe(true);
      // Detached preview worktrees don't tell the frontend which branch
      // they preview via `cwd` or git — this field is the only seam
      // (Dock.tsx's selector resolves a running preview session through it).
      expect(session.previewBranch).toBe("main");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("exposes previewBranch on a GET /api/sessions re-fetch too, and null for a plain session", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const preview = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", worktree: { branch: "main" } },
      });
      expect(preview.statusCode).toBe(201);
      const previewId = preview.json().id as number;

      const plain = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      expect(plain.statusCode).toBe(201);
      const plainId = plain.json().id as number;
      expect(plain.json().previewBranch).toBeNull();

      // This is what makes the Dock's <select> resolve correctly after a
      // page reload, where the frontend's own worktreePaths state is gone
      // — the list endpoint must carry the same field the POST response did.
      const listed = await app.inject({ method: "GET", url: "/api/sessions" });
      const rows = listed.json() as Array<{ id: number; previewBranch: string | null }>;
      expect(rows.find((s) => s.id === previewId)?.previewBranch).toBe("main");
      expect(rows.find((s) => s.id === plainId)?.previewBranch).toBeNull();

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("cleans up the preview worktree on DELETE /:id without disturbing the primary checkout", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        env: gitEnv(),
      }).toString();
      const statusBefore = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        env: gitEnv(),
      }).toString();

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", worktree: { branch: "main" } },
      });
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().id as number;
      const worktreePath = created.json().cwd as string;
      expect(fs.existsSync(worktreePath)).toBe(true);

      await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

      // After kill, the preview worktree directory should be removed
      expect(fs.existsSync(worktreePath)).toBe(false);
      // The primary checkout — which shares "main" with the (now-removed)
      // detached preview — must be completely unaffected throughout.
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd, env: gitEnv() }).toString()).toBe(
        headBefore,
      );
      expect(
        execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv() }).toString(),
      ).toBe(statusBefore);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses an empty worktree intent with no branch or baseRef", async () => {
      const app = await buildApp();
      const cwd = createGitRepo();
      const projectId = await createProjectWithGitRepo(app, cwd);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", worktree: {} },
      });

      // oneOf validation in worktreeIntentSchema should reject this
      expect(created.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    describe("on a remote-hosted project (issue #345)", () => {
      async function createRemotePreviewProject(app: Awaited<ReturnType<typeof buildApp>>) {
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          // Deliberately unreachable — resolveBackend is spied per-test to
          // return a fake backend, so this baseUrl is never actually hit.
          payload: { name: "preview-remote", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const hostId = host.json().id as string;
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-preview-p",
            cwd: "/remote/project",
            hostId,
          },
        });
        return { projectId: project.json().id as number, hostId };
      }

      it("checks out the branch through the backend and starts the session, instead of the old 502 refusal", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const { projectId } = await createRemotePreviewProject(app);

        const fakeBackend = fakeSessionBackend({
          spawn: vi.fn().mockResolvedValue({}),
          checkoutBranchWorktree: vi.fn().mockResolvedValue({
            path: "/remote/project/.mullion-worktrees/dock-preview-main-abc123",
            branch: "main",
          }),
          removeWorktree: vi.fn().mockResolvedValue(true),
          syncWorktree: vi.fn().mockResolvedValue(true),
        });
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });

        // Before #345 this hit the `project.hostId !== LOCAL_HOST_ID`
        // guard and 502'd with reason "worktree-failed" — the same
        // reason a genuine checkoutBranchWorktree failure returns, so
        // asserting on the fake backend's own call (not just the status
        // code) is what actually distinguishes "guard removed" from
        // "guard replaced by a coincidentally-passing failure."
        expect(created.statusCode).toBe(201);
        expect(fakeBackend.checkoutBranchWorktree).toHaveBeenCalledWith("/remote/project", "main");
        expect(fakeBackend.spawn).toHaveBeenCalled();
        const body = created.json();
        expect(body.cwd).toBe("/remote/project/.mullion-worktrees/dock-preview-main-abc123");
        expect(body.previewBranch).toBe("main");

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("wires a sync closure that routes worktreeRefresh through the backend's syncWorktree, not local git", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const gitWorktreeModule = await import("../../src/services/git-worktree.js");
        const { projectId } = await createRemotePreviewProject(app);
        const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

        const fakeBackend = fakeSessionBackend({
          spawn: vi.fn().mockResolvedValue({}),
          checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: worktreePath, branch: "main" }),
          removeWorktree: vi.fn().mockResolvedValue(true),
          syncWorktree: vi.fn().mockResolvedValue(true),
        });
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: {
            projectId,
            command: "bash",
            worktree: { branch: "main" },
            worktreeRefresh: true,
          },
        });
        expect(created.statusCode).toBe(201);
        const sessionId = created.json().id as number;

        // The 5s sync tick itself isn't exercised here (too slow for a
        // unit test — see git-worktree.ts's SYNC_INTERVAL_MS) but the
        // closure it would call is: this is the wiring Hermes/a reviewer
        // would otherwise have to trust unverified.
        const info = gitWorktreeModule.getPreviewWorktree(sessionId);
        expect(info?.sync).toBeDefined();
        await expect(info!.sync!()).resolves.toBe(true);
        expect(fakeBackend.syncWorktree).toHaveBeenCalledWith(worktreePath, "main");

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("the remove/sync closures resolve false and still log a diagnostic when the backend call throws SYNCHRONOUSLY, not just on a rejection (independent review, this PR)", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const gitWorktreeModule = await import("../../src/services/git-worktree.js");
        const { projectId, hostId } = await createRemotePreviewProject(app);
        const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

        // Same shape as RemoteBackend.removeWorktree/syncWorktree's real
        // failure mode: their `client` getter can throw synchronously
        // (e.g. a hosts row deleted mid-lifetime) rather than returning a
        // rejected promise. A `.catch()` chained on the bare call can't
        // rescue that — only a try/catch wrapping the call itself can,
        // which is also what makes logPreviewWorktreeHostError still run.
        const removeWorktree = vi.fn(() => {
          throw new Error("host row deleted mid-request");
        });
        const syncWorktree = vi.fn(() => {
          throw new Error("host row deleted mid-request");
        });
        const fakeBackend = fakeSessionBackend({
          spawn: vi.fn().mockResolvedValue({}),
          checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: worktreePath, branch: "main" }),
          removeWorktree,
          syncWorktree,
        });
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);
        const warnSpy = vi.spyOn(app.log, "warn");

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: {
            projectId,
            command: "bash",
            worktree: { branch: "main" },
            worktreeRefresh: true,
          },
        });
        expect(created.statusCode).toBe(201);
        const sessionId = created.json().id as number;
        const info = gitWorktreeModule.getPreviewWorktree(sessionId);

        await expect(info!.remove!()).resolves.toBe(false);
        await expect(info!.sync!()).resolves.toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ hostId, worktreePath }),
          expect.stringContaining("preview worktree remove: host unreachable"),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ hostId, worktreePath }),
          expect.stringContaining("preview worktree sync: host unreachable"),
        );

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("routes DELETE cleanup through the backend's removeWorktree, not local git", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const { projectId } = await createRemotePreviewProject(app);
        const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

        const fakeBackend = fakeSessionBackend({
          spawn: vi.fn().mockResolvedValue({}),
          checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: worktreePath, branch: "main" }),
          removeWorktree: vi.fn().mockResolvedValue(true),
          syncWorktree: vi.fn().mockResolvedValue(true),
        });
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });
        expect(created.statusCode).toBe(201);
        const sessionId = created.json().id as number;

        await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });

        expect(fakeBackend.removeWorktree).toHaveBeenCalledWith(worktreePath, "/remote/project");

        resolveBackendSpy.mockRestore();
        await app.close();
      });

      it("502s (not 500) when the remote host is genuinely unreachable, no resolveBackend mock", async () => {
        const app = await buildApp();
        // No fake backend this time — the real RemoteBackend hits the
        // unreachable baseUrl and rejects (HostUnreachableError). Before
        // this was wrapped in try/catch, that rejection escaped
        // createSessionRecord and Fastify's default error handler turned
        // it into a 500 — this was unreachable before #345 removed the
        // local-only guard, since the guard rejected first for every
        // remote host.
        const { projectId } = await createRemotePreviewProject(app);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });

        expect(created.statusCode).toBe(502);

        await app.close();
      });

      it("502s (not 500) and still deletes the DB row when the spawn-failure worktree rollback itself throws SYNCHRONOUSLY (independent review, this PR)", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const { projectId } = await createRemotePreviewProject(app);
        const worktreePath = "/remote/project/.mullion-worktrees/dock-preview-main-abc123";

        // Simulates RemoteBackend.removeWorktree's real failure mode: its
        // `client` getter (getRemoteHostClient) can throw SYNCHRONOUSLY
        // (e.g. a hosts row deleted mid-request) before ever returning a
        // promise — `.catch(() => {})` chained on the call can't rescue
        // that, only a real try/catch around the call itself can. A
        // `vi.fn()` that throws (not rejects) reproduces exactly that
        // shape without needing a real deleted-host race.
        const removeWorktree = vi.fn(() => {
          throw new Error("host row deleted mid-request");
        });
        const fakeBackend = fakeSessionBackend({
          checkoutBranchWorktree: vi.fn().mockResolvedValue({ path: worktreePath, branch: "main" }),
          spawn: vi.fn().mockRejectedValue(new Error("spawn failed")),
          removeWorktree,
          syncWorktree: vi.fn().mockResolvedValue(true),
        });
        const resolveBackendSpy = vi
          .spyOn(sessionBackendModule, "resolveBackend")
          .mockReturnValue(fakeBackend);

        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash", worktree: { branch: "main" } },
        });

        // The clean spawn-failed contract, not an unhandled-rejection 500
        // — proves createSessionRecord's own rollback try/catch (not just
        // the outer spawn try/catch) survives the synchronous throw.
        expect(created.statusCode).toBe(502);
        expect(removeWorktree).toHaveBeenCalledWith(worktreePath, "/remote/project");

        // The rest of the catch block after the throwing rollback call
        // still ran — no orphaned "active" row for a session that was
        // never actually spawned anywhere.
        const list = await app.inject({
          method: "GET",
          url: `/api/sessions?projectId=${projectId}`,
        });
        expect(list.json()).toEqual([]);

        resolveBackendSpy.mockRestore();
        await app.close();
      });
    });
  });
});
