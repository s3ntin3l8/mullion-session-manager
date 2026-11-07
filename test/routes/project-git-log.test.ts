// The git log and commit routes, and the remote-host git round trip.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git.ts. The Git route block left
// projects.ts, and the test tree mirrors the source tree.
//
// GET /api/projects/:id/git-log and /git-commit read a project's commit
// history; the remote-host cases run the same reads through a second,
// agent-role app.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";

// The relay's landed-check memo (issue #1630) — cleared per test so one
// test's answer is not the next one's.
import { gitEnv } from "../../src/services/git-env.js";

import type { FastifyInstance } from "fastify";

import { buildTestApp, buildTeardownApp } from "../helpers/app.js";
import { uniqueSessionsDir } from "../helpers/sessions-dir.js";

// Session creation spawns a real OS process (systemd-run, bootstrapping a
// dtach master) via PtyManager — faked here the same way as
// test/services/pty-manager.test.ts and test/routes/sessions.test.ts, so
// this file exercises the route/DB layer without depending on a real
// `systemd --user` session existing in CI. This file is the one place
// `POST /api/sessions` was still hitting a real spawn: CI's runner can't
// complete `systemd-run --user --scope` (`master bootstrap exited with
// code 1`), and the failed session's app instance then fails to release
// its `hooks.sock` listener cleanly, which cascades into
// `SocketAlreadyListeningError` for every later test in this file that
// builds its own `buildApp()`.
//
// Unlike sessions.test.ts (which fakes every non-`git` command), this file
// also exercises real `docker` (docker-service-detect.ts, via the dock
// route) and real `git`/shell subprocesses well beyond worktree setup —
// faking anything broader than the one command that's actually
// CI-unreliable would either skip real coverage these tests are meant to
// exercise, or (as `docker-service-detect.ts`'s `child.kill()` timeout
// found out the hard way) break code that expects a real ChildProcess
// shape from `spawn`. So only `systemd-run` itself is faked; `systemctl`
// (pty-manager.ts's stopScope/isMasterAlive — never actually reaches a
// real scope once systemd-run is faked, and doesn't `.kill()` its child)
// and everything else passes through to the real `spawn`.
vi.mock("node-pty", () => plainNodePtyMock());

// Passthrough wrapper so a test can assert which token scopes a route asks
// for, while every other test still gets the real resolver.
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn(actual.resolveGitHubToken) };
});

// The same trick for the review relay's run lookup (issue #1630): the route
// asks "does this Mullion know a review run for this PR?", and a test can
// answer that without dispatching a real run.
vi.mock("../../src/services/hermes-review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HermesReview>();
  return {
    ...actual,
    getReviewRunForPr: vi.fn(actual.getReviewRunForPr),
    // Epic #1965 A6 — the issue list/detail ask the same index for a triage run.
    getRunForTarget: vi.fn(actual.getRunForTarget),
    // #1790 — the re-review route's dispatch, so a test can hand back a result
    // without a real Hermes.
    assertReviewerConfigured: vi.fn(actual.assertReviewerConfigured),
    requestHermesReview: vi.fn(actual.requestHermesReview),
  };
});

// Passthrough wrapper so a test can make the sidebar merge's task bookkeeping
// throw without touching the real implementation for every other test.
vi.mock("../../src/services/task-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TaskReconciler>();
  return { ...actual, finishTaskForMergedPr: vi.fn(actual.finishTaskForMergedPr) };
});

// Marker substring a target cwd can contain to make runGitInit's own `git
// init` spawn fail deterministically (real `git init` essentially never
// fails on a fresh, writable directory) — Hermes review, PR #620: the
// route-level gitInit-failure wiring (`gitInitialized = result.success`)
// was only covered at the service level (git-init.test.ts's own mocked
// spawn), not through POST/PATCH /api/projects itself. Everything else
// still passes through to the real `git` binary — see this file's own
// `execFileSync("git", ["init", ...])` fixture setup elsewhere, unaffected
// since that's a different child_process API than the mocked `spawn`.
const GIT_INIT_FAIL_MARKER = "route-git-init-fail";

// Not converted to mock-spawn.ts's mockChildProcessSpawn — that helper's
// own header deliberately excludes files needing command-specific
// conditional behavior beyond a static fake/passthrough command list
// (e.g. this file's GIT_INIT_FAIL_MARKER, which fakes a `git init` failure
// only for one specific target path, while every other `git` invocation
// passes through to the real binary). Forcing this into the shared helper
// would need a per-args predicate the helper doesn't support.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (
        command === "git" &&
        args?.includes("init") &&
        args?.some((a) => a.includes(GIT_INIT_FAIL_MARKER))
      ) {
        const ee = new EventEmitter();
        setImmediate(() => ee.emit("close", 1));
        return ee;
      }
      if (command !== "systemd-run") return actual.spawn(command, args, options);
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside this file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file), so
// their hooksPlugin listeners (registered for both roles) would collide on
// the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.

describe("projects route", () => {
  describe("git log and remote-host git routes", () => {
    // Same containment as the "dock" describe block above: this block's own
    // SESSIONS_DIR plus an afterEach that closes every tracked app
    // unconditionally, confining any leak to this block instead of poisoning
    // the rest of the file's buildApp() calls.
    let previousSessionsDir: string | undefined;
    const sessionsDir = uniqueSessionsDir("projects");

    beforeAll(() => {
      previousSessionsDir = process.env.SESSIONS_DIR;
      process.env.SESSIONS_DIR = sessionsDir;
    });

    afterAll(() => {
      if (previousSessionsDir === undefined) delete process.env.SESSIONS_DIR;
      else process.env.SESSIONS_DIR = previousSessionsDir;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    });

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();

      // github-integration's `integrations` row is a singleton shared
      // across this whole test file's DB — reset it after every test in
      // this block so a connected token doesn't leak into an unrelated
      // "no token" case (same reasoning as github-integration.test.ts).
      const teardownApp = await buildTeardownApp("projects-git-teardown");
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(teardownApp);
      await teardownApp.close();
    });

    describe("git log routes", () => {
      const gitIn = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          env: {
            ...gitEnv(),
            GIT_AUTHOR_NAME: "T",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "T",
            GIT_COMMITTER_EMAIL: "t@example.com",
          },
        }).trim();

      async function repoProject(app: FastifyInstance) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-gitlog-"));
        gitIn(dir, "init", "-q", "-b", "main");
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        gitIn(dir, "add", ".");
        gitIn(dir, "commit", "-q", "-m", "first");
        fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
        gitIn(dir, "commit", "-q", "-am", "second");
        const created = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { createDir: true, allowDuplicate: true, name: "gitlog", cwd: dir },
        });
        return { dir, id: created.json().id as number, head: gitIn(dir, "rev-parse", "HEAD") };
      }

      it("lists commits, then serves one commit's files and a file diff", async () => {
        const app = await buildTestApp();
        const { dir, id, head } = await repoProject(app);

        const log = await app.inject({ method: "GET", url: `/api/projects/${id}/git-log?limit=1` });
        expect(log.statusCode).toBe(200);
        expect(log.json().commits).toHaveLength(1);
        expect(log.json().commits[0]).toMatchObject({ sha: head, subject: "second" });
        expect(log.json().hasMore).toBe(true);
        const head2 = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-log?scope=head`,
        });
        expect(head2.json().commits).toHaveLength(2);
        expect(head2.json().hasMore).toBe(false);

        const detail = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-commit/${head}`,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().files).toEqual([{ path: "a.txt", additions: 1, deletions: 0 }]);

        const file = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-commit/${head}/file?path=a.txt`,
        });
        expect(file.statusCode).toBe(200);
        expect(file.json().patch).toContain("+two");
        fs.rmSync(dir, { recursive: true, force: true });
      });

      it("validates ids, paging, scope, sha and path; 404s unknown project/commit", async () => {
        const app = await buildTestApp();
        const { dir, id } = await repoProject(app);
        const get = (url: string) => app.inject({ method: "GET", url });

        expect((await get("/api/projects/x/git-log")).statusCode).toBe(400);
        expect((await get("/api/projects/999999/git-log")).statusCode).toBe(404);
        expect((await get(`/api/projects/${id}/git-log?skip=-1`)).statusCode).toBe(400);
        expect((await get(`/api/projects/${id}/git-log?limit=0`)).statusCode).toBe(400);
        expect((await get(`/api/projects/${id}/git-log?scope=nope`)).statusCode).toBe(400);
        expect((await get(`/api/projects/${id}/git-commit/--output=x`)).statusCode).toBe(400);
        expect((await get(`/api/projects/${id}/git-commit/0000000`)).statusCode).toBe(404);
        expect((await get(`/api/projects/${id}/git-commit/abc1234/file`)).statusCode).toBe(400);
        expect(
          (await get(`/api/projects/${id}/git-commit/abc1234/file?path=../x`)).statusCode,
        ).toBe(400);
        fs.rmSync(dir, { recursive: true, force: true });
      });

      it("accepts a worktree cwd of the project and refuses any other directory", async () => {
        const app = await buildTestApp();
        const { dir, id } = await repoProject(app);
        const wt = `${dir}-wt`;
        gitIn(dir, "worktree", "add", "-q", "-b", "side", wt);
        fs.writeFileSync(path.join(wt, "s.txt"), "s\n");
        gitIn(wt, "add", ".");
        gitIn(wt, "commit", "-q", "-m", "side only");

        const ok = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-log?scope=head&cwd=${encodeURIComponent(wt)}`,
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().commits[0].subject).toBe("side only");

        const bad = await app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-log?cwd=${encodeURIComponent("/tmp")}`,
        });
        expect(bad.statusCode).toBe(400);
        fs.rmSync(wt, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
      });
    });

    describe("on a remote-host project (issue #1969)", () => {
      async function withAgent(
        handler: (url: string) => { status: number; body: unknown },
        run: (ctx: { app: FastifyInstance; id: number; seen: string[] }) => Promise<void>,
      ) {
        vi.unstubAllGlobals();
        const { createServer } = await import("node:http");
        const seen: string[] = [];
        const server = createServer((req, res) => {
          if ((req.url ?? "").startsWith("/internal/git-")) seen.push(req.url ?? "");
          const { status, body } = handler(req.url ?? "");
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as { port: number }).port;
        const app = await buildTestApp();
        try {
          const host = await app.inject({
            method: "POST",
            url: "/api/hosts",
            payload: {
              name: `history-host-${port}`,
              baseUrl: `http://127.0.0.1:${port}`,
              token: "t",
            },
          });
          const project = await app.inject({
            method: "POST",
            url: "/api/projects",
            payload: {
              allowDuplicate: true,
              name: "remote-history",
              cwd: "/x",
              hostId: host.json().id,
            },
          });
          await run({ app, id: project.json().id as number, seen });
        } finally {
          server.close();
        }
      }

      const sha = "a".repeat(40);
      const commit = { sha, parents: [], author: "T", time: 1, subject: "s", refs: [] };

      it("proxies git-log, git-commit and git-commit/file to the host agent", async () => {
        await withAgent(
          (url) => {
            if (url.startsWith("/internal/git-log"))
              return { status: 200, body: { commits: [commit] } };
            if (url.startsWith("/internal/git-commit-file"))
              return { status: 200, body: { patch: "+x" } };
            return {
              status: 200,
              body: { detail: { ...commit, email: "t@e", message: "m", files: [] } },
            };
          },
          async ({ app, id, seen }) => {
            const log = await app.inject({
              method: "GET",
              url: `/api/projects/${id}/git-log?limit=5&scope=head&cwd=${encodeURIComponent("/x/wt")}`,
            });
            expect(log.statusCode).toBe(200);
            expect(log.json().commits).toEqual([commit]);
            expect(seen[0]).toContain("scope=head");
            expect(seen[0]).toContain("limit=5");
            expect(seen[0]).toContain("worktree=%2Fx%2Fwt");

            const detail = await app.inject({
              method: "GET",
              url: `/api/projects/${id}/git-commit/${sha}`,
            });
            expect(detail.statusCode).toBe(200);
            expect(detail.json().message).toBe("m");
            expect(seen[1]).not.toContain("worktree=");

            const file = await app.inject({
              method: "GET",
              url: `/api/projects/${id}/git-commit/${sha}/file?path=a.txt`,
            });
            expect(file.json()).toEqual({ patch: "+x" });
          },
        );
      });

      it("204s when the log is empty and 404s a missing commit or diff", async () => {
        await withAgent(
          (url) =>
            url.startsWith("/internal/git-log")
              ? { status: 200, body: { commits: null } }
              : url.startsWith("/internal/git-commit-file")
                ? { status: 200, body: { patch: null } }
                : { status: 200, body: { detail: null } },
          async ({ app, id }) => {
            expect(
              (await app.inject({ method: "GET", url: `/api/projects/${id}/git-log` })).statusCode,
            ).toBe(204);
            expect(
              (await app.inject({ method: "GET", url: `/api/projects/${id}/git-commit/${sha}` }))
                .statusCode,
            ).toBe(404);
            expect(
              (
                await app.inject({
                  method: "GET",
                  url: `/api/projects/${id}/git-commit/${sha}/file?path=a.txt`,
                })
              ).statusCode,
            ).toBe(404);
          },
        );
      });

      it("400s a worktree the agent refuses", async () => {
        await withAgent(
          (url) =>
            url.startsWith("/internal/git-log")
              ? { status: 200, body: { commits: null, forbidden: true } }
              : { status: 200, body: { detail: null, forbidden: true, patch: null } },
          async ({ app, id }) => {
            const q = `cwd=${encodeURIComponent("/etc")}`;
            for (const url of [
              `/api/projects/${id}/git-log?${q}`,
              `/api/projects/${id}/git-commit/${sha}?${q}`,
              `/api/projects/${id}/git-commit/${sha}/file?path=a.txt&${q}`,
            ]) {
              expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
            }
          },
        );
      });

      it("204s for an agent that predates the routes", async () => {
        await withAgent(
          () => ({ status: 404, body: { message: "no such route" } }),
          async ({ app, id }) => {
            expect(
              (await app.inject({ method: "GET", url: `/api/projects/${id}/git-log` })).statusCode,
            ).toBe(204);
          },
        );
      });

      it("502s, not 'unreachable', when the agent rejects the request with a 4xx", async () => {
        await withAgent(
          () => ({ status: 400, body: { message: "cwd is outside PROJECTS_ROOTS" } }),
          async ({ app, id }) => {
            const res = await app.inject({ method: "GET", url: `/api/projects/${id}/git-log` });
            expect(res.statusCode).toBe(502);
            expect(res.body).toContain("rejected the request");
            expect(res.body).not.toContain("is unreachable");
          },
        );
      });

      it("503s when the host is unreachable", async () => {
        vi.unstubAllGlobals();
        const app = await buildTestApp();
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "history-down", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-history-down",
            cwd: "/x",
            hostId: host.json().id,
          },
        });
        const id = project.json().id;
        for (const url of [
          `/api/projects/${id}/git-log`,
          `/api/projects/${id}/git-commit/${sha}`,
          `/api/projects/${id}/git-commit/${sha}/file?path=a.txt`,
        ]) {
          expect((await app.inject({ method: "GET", url })).statusCode).toBe(503);
        }
      });
    });
  });
});
