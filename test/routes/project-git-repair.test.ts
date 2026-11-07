// The git health check and repair routes.
//
// Moved out of test/routes/projects.test.ts (issue #2475), alongside the
// routes themselves: src/routes/project-git-writes.ts. The Git route block
// left projects.ts, and the test tree mirrors the source tree.
//
// The health check is read-only; the repair is a deliberate,
// operator-run action.

import { describe, it, expect, vi } from "vitest";
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

const { buildApp } = await import("../../src/app.js");

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside this file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file), so
// their hooksPlugin listeners (registered for both roles) would collide on
// the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.

describe("projects route", () => {
  describe("POST /api/projects/:id/git-repair (issue #1896)", () => {
    /** A clone carrying the #1836 damage: a zero-byte file where a loose
     * object should be. */
    const damagedClone = async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-repair-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
      fs.writeFileSync(path.join(cwd, "a.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-q", "-m", "one"], {
        cwd,
        stdio: "pipe",
        env: {
          ...gitEnv(),
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
      // Stage a change and damage the TREE the index names — the #1836 case,
      // where the index's cache-tree points at an object that went missing.
      // HEAD's own tree is left intact: a damaged HEAD tree would fail
      // `git read-tree HEAD` and the index rebuild with it, which is a
      // different scenario.
      fs.writeFileSync(path.join(cwd, "a.txt"), "changed\n");
      execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
      const tree = execFileSync("git", ["write-tree"], {
        cwd,
        encoding: "utf8",
        env: gitEnv(),
      }).trim();
      const objectPath = path.join(cwd, ".git", "objects", tree.slice(0, 2), tree.slice(2));
      // A loose object is written read-only, so remove it and put the empty
      // file in its place — the #1836 damage.
      fs.rmSync(objectPath, { force: true });
      fs.writeFileSync(objectPath, "");
      return { cwd, tree, objectPath };
    };

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-repair" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns a plan without changing anything", async () => {
      const { cwd, tree, objectPath } = await damagedClone();
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "repair-plan-repo", cwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-repair`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.quarantine).toEqual([tree]);
      expect(body.actionable).toBe(true);
      expect(body.indexesToRebuild).toHaveLength(1);

      // The plan is a READ: the damaged object is still exactly where it was.
      expect(fs.existsSync(objectPath)).toBe(true);
      expect(fs.statSync(objectPath).size).toBe(0);
      expect(
        fs.readdirSync(path.join(cwd, ".git")).some((n) => n.startsWith("gc-quarantine-")),
      ).toBe(false);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("repairs the clone when confirmed, and reports what it did", async () => {
      const { cwd, tree, objectPath } = await damagedClone();
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "repair-run-repo", cwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-repair`,
        payload: { confirm: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.quarantined).toEqual([tree]);
      expect(body.quarantine).toContain("gc-quarantine-");
      expect(body.indexesRebuilt).toHaveLength(1);

      // The damaged object was MOVED out of objects/ — never deleted.
      expect(fs.existsSync(objectPath)).toBe(false);
      const quarantine = body.quarantine as string;
      expect(fs.existsSync(path.join(quarantine, tree.slice(0, 2), tree.slice(2)))).toBe(true);
      expect(fs.statSync(path.join(quarantine, tree.slice(0, 2), tree.slice(2))).size).toBe(0);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // The CLONE is the resource, not the project: two project rows can point
    // at the same directory, and the background auto-fetch sweep runs
    // `git fetch` on the same clone — a fetch landing inside the repair's own
    // fetch window would fail its ref update and make a healthy clone look
    // broken.
    it("refuses a repair while a git operation is already running on that clone", async () => {
      const { cwd } = await damagedClone();
      const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
      const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "repair-busy-repo", cwd },
      });

      // Stand in for the auto-fetch sweep, which claims the same clone.
      markCloneBusy(LOCAL_HOST_ID, cwd);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${created.json().id}/git-repair`,
          payload: { confirm: true },
        });
        expect(res.statusCode).toBe(409);
      } finally {
        releaseClone(LOCAL_HOST_ID, cwd);
      }

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    // The manual Fetch and Pull write to the same clone the repair does, so
    // they claim it too — a manual Fetch landing inside a repair's fetch
    // window is the exact failure the registry exists to prevent.
    it("refuses a manual fetch or pull while a git operation is running on that clone", async () => {
      const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
      const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
      const app = await buildApp();
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-busy-"));
      execFileSync("git", ["init", "-q", projectCwd], { env: gitEnv() });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "busy-repo", cwd: projectCwd },
      });

      markCloneBusy(LOCAL_HOST_ID, projectCwd);
      try {
        const fetchRes = await app.inject({
          method: "POST",
          url: `/api/projects/${created.json().id}/git-fetch`,
        });
        expect(fetchRes.statusCode).toBe(409);

        const pullRes = await app.inject({
          method: "POST",
          url: `/api/projects/${created.json().id}/git-pull`,
        });
        expect(pullRes.statusCode).toBe(409);
      } finally {
        releaseClone(LOCAL_HOST_ID, projectCwd);
      }

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses a second repair for the same project while one is running", async () => {
      const { cwd } = await damagedClone();
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "repair-concurrent-repo", cwd },
      });
      const url = `/api/projects/${created.json().id}/git-repair`;

      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url, payload: { confirm: true } }),
        app.inject({ method: "POST", url, payload: { confirm: true } }),
      ]);

      // Two repairs for one clone would mean two quarantine directories and
      // two index rebuilds over the same tree, so exactly one of them is
      // refused.
      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-repair-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-repair",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-repair`,
        payload: { confirm: true },
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("is unreachable");

      await app.close();
    });

    // The remote PLAN: the plan is computed by the agent that owns the
    // clone, exactly like the check.
    it("asks a remote host for the plan, without confirming anything", async () => {
      const { createServer } = await import("node:http");
      const bodies: unknown[] = [];
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw || "{}"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              gitDir: "/remote/.git",
              quarantine: ["abcdef"],
              willFetch: true,
              indexesToRebuild: ["/remote"],
              indexesToSkip: [],
              actionable: true,
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const app = await buildApp();
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: {
            name: "git-repair-plan-host",
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
          },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-git-repair-plan",
            cwd: "/x",
            hostId: host.json().id,
          },
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${project.json().id}/git-repair`,
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(
          expect.objectContaining({ quarantine: ["abcdef"], actionable: true }),
        );
        // The agent was asked for the PLAN — nothing was confirmed.
        expect(bodies).toContainEqual({ cwd: "/x", confirm: false });
        expect(bodies.every((b) => (b as { confirm?: boolean }).confirm !== true)).toBe(true);

        await app.close();
      } finally {
        server.close();
      }
    });

    it("503s when the plan for a remote host cannot be fetched", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-repair-plan-dead-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-repair-plan-dead",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-repair`,
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain("is unreachable");

      await app.close();
    });

    it("says the host REJECTED the repair when the agent answers with an error", async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "no such route" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const app = await buildApp();
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: {
            name: "git-repair-old-host",
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
          },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-git-repair-404",
            cwd: "/x",
            hostId: host.json().id,
          },
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${project.json().id}/git-repair`,
          payload: { confirm: true },
        });
        expect(res.statusCode).toBe(503);
        expect(res.body).toContain("rejected the repair");
        expect(res.body).not.toContain("is unreachable");

        await app.close();
      } finally {
        server.close();
      }
    });
  });

  describe("POST /api/projects/:id/git-health (issue #1851)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-health" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("reports a healthy local repository as healthy", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-health-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-q", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "health-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-health`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({
          healthy: true,
          zeroByteObjects: [],
          fsckErrors: [],
        }),
      );

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("reports a damaged repository without changing it", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-health-bad-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-q", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-q", "-m", "one"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: {
          ...gitEnv(),
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });

      // The #1836 damage: a zero-byte file where a loose object should be.
      const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: projectCwd,
        encoding: "utf8",
        env: gitEnv(),
      }).trim();
      const objectPath = path.join(projectCwd, ".git", "objects", tree.slice(0, 2), tree.slice(2));
      // A loose object is written read-only, so remove it and put the empty
      // file in its place — the #1836 damage.
      fs.rmSync(objectPath, { force: true });
      fs.writeFileSync(objectPath, "");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "health-damaged", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-health`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.healthy).toBe(false);
      expect(body.zeroByteObjects).toContain(`${tree.slice(0, 2)}/${tree.slice(2)}`);
      expect(body.fsckErrors.length).toBeGreaterThan(0);

      // READ-ONLY: the empty object is still where it was, untouched.
      expect(fs.statSync(objectPath).size).toBe(0);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-health-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-health",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-health`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    // The happy path for a REMOTE project: the clone is checked on the host
    // that owns it, and the answer comes back from there. The 503 case above
    // alone would not have caught a proxy timeout or a wrong URL.
    it("reports a remote project's clone health, from that host", async () => {
      const { createServer } = await import("node:http");
      const seen: string[] = [];
      const server = createServer((req, res) => {
        seen.push(req.url ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            gitDir: "/remote/.git",
            zeroByteObjects: [],
            otherZeroByteFiles: [],
            fsckErrors: [],
            healthy: true,
            timedOut: false,
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const app = await buildApp();
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: {
            name: "git-health-live-host",
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
          },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-git-health-ok",
            cwd: "/x",
            hostId: host.json().id,
          },
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${project.json().id}/git-health`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(
          expect.objectContaining({ healthy: true, gitDir: "/remote/.git" }),
        );
        // It really went to that host, for that clone.
        expect(seen.some((url) => url.includes("/internal/git-health"))).toBe(true);
        expect(seen.some((url) => url.includes("%2Fx"))).toBe(true);

        await app.close();
      } finally {
        server.close();
      }
    });

    // An agent that REJECTED the request is alive and answering — a 404 from
    // an agent that predates /internal/git-health, say. Calling that host
    // "unreachable" is a different (and wrong) fact.
    it("says the host REJECTED the check when the agent answers with an error", async () => {
      const { createServer } = await import("node:http");
      const server = createServer((_req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "no such route" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const app = await buildApp();
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: {
            name: "git-health-old-host",
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
          },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-git-health-404",
            cwd: "/x",
            hostId: host.json().id,
          },
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${project.json().id}/git-health`,
        });
        expect(res.statusCode).toBe(503);
        expect(res.body).toContain("rejected the health check");
        expect(res.body).not.toContain("is unreachable");

        await app.close();
      } finally {
        server.close();
      }
    });
  });
});
