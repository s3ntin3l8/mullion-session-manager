import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
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
const { closeDb } = await import("../../src/db/client.js");

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside this file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file), so
// their hooksPlugin listeners (registered for both roles) would collide on
// the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `projects-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Captured before any test stubs globalThis.fetch — lets the remote-host
// success test (issue #222) delegate real loopback calls to its own
// in-process agent server through the same fetchMock that mocks
// api.github.com, instead of needing genuine internet access.
const realFetch = globalThis.fetch;

const tmpDb = path.join(os.tmpdir(), `projects-test-${process.pid}.db`);

describe("projects route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("creates and lists projects", async () => {
    const app = await buildApp();

    // A plain temp dir, not a hardcoded personal home path — the original
    // "/home/bjoern" only ever worked on the one machine it was authored on;
    // real CI runners (a different user, no such path, no write access to
    // create it) hit EACCES on the best-effort mkdir in POST /api/projects,
    // which doesn't fail this request itself but corrupts later assertions
    // in this file that batch git-status/dev-server-detect across every
    // project row still in the DB. Matches this file's own dominant
    // `fs.mkdtempSync(path.join(os.tmpdir(), ...))` pattern used everywhere
    // else here.
    const homeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-home-"));

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "home", cwd: homeCwd },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "home", cwd: homeCwd });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    // Always present, even with no dock session to detect from — see the
    // "detectedDevServerPort" describe block below for the detection cases.
    expect(listed.json()[0].detectedDevServerPort).toBeNull();
    // Not a git repo — see the "currentBranch" describe block below for the
    // git-repo case.
    expect(listed.json()[0].currentBranch).toBeNull();

    await app.close();
    fs.rmSync(homeCwd, { recursive: true, force: true });
  });

  it("lists projects in case-insensitive alphabetical order", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "zeta", cwd: "/tmp/z" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "Alpha", cwd: "/tmp/a" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "beta", cwd: "/tmp/b" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "Gamma", cwd: "/tmp/g" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    const names = listed.json().map((p: { name: string }) => p.name);
    const sorted = [...names].sort((a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    expect(names).toEqual(sorted);

    await app.close();
  });

  it("expands a leading ~ in cwd before validating, on create", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "tilde", cwd: "~/definitely-not-here/my-project" },
    });
    // Proves expandHome() still runs before directory validation, with zero
    // filesystem side effects — the error message carries the *expanded*
    // path, not the literal `~/...` one. Not `cwd: "~"` itself: that would
    // register the developer's real $HOME and push it through
    // maybeRegisterProjectWebhook (reads a git remote) — live-fire on a
    // dev box.
    expect(created.statusCode).toBe(400);
    expect(created.json().code).toBe("PROJECT_PARENT_MISSING");
    expect(created.json().message).toContain(path.join(os.homedir(), "definitely-not-here"));
    await app.close();
  });

  it("only creates the directory when createDir is set, on create", async () => {
    const app = await buildApp();
    const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-create-")), "project");
    expect(fs.existsSync(cwd)).toBe(false);

    const withoutFlag = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-test", cwd },
    });
    expect(withoutFlag.statusCode).toBe(400);
    expect(withoutFlag.json().code).toBe("PROJECT_DIR_MISSING");
    expect(fs.existsSync(cwd)).toBe(false);
    // No orphan row from the rejected create.
    const listedAfterReject = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listedAfterReject.json().some((p: { cwd: string }) => p.cwd === cwd)).toBe(false);

    const withFlag = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-test", cwd, createDir: true },
    });
    expect(withFlag.statusCode).toBe(201);
    expect(withFlag.json()).toMatchObject({ dirCreated: true, gitInitialized: false });
    expect(fs.existsSync(cwd)).toBe(true);
    await app.close();
  });

  it("400s when the path exists as a file, on create", async () => {
    const app = await buildApp();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-fail-create-"));
    const cwd = path.join(parent, "project");
    fs.writeFileSync(cwd, "i am a file, not a directory", "utf-8");

    const withoutFlag = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-fail", cwd },
    });
    expect(withoutFlag.statusCode).toBe(400);
    expect(withoutFlag.json().code).toBe("PROJECT_PATH_NOT_A_DIRECTORY");

    const withFlag = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-fail", cwd, createDir: true },
    });
    expect(withFlag.statusCode).toBe(400);
    expect(withFlag.json().code).toBe("PROJECT_PATH_NOT_A_DIRECTORY");
    await app.close();
  });

  it("400s with PROJECT_PARENT_MISSING (not PROJECT_DIR_MISSING) when the parent is also missing, even with createDir — the leaf-only guarantee", async () => {
    const app = await buildApp();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-only-"));
    const cwd = path.join(base, "a", "b");

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "leaf-only", cwd, createDir: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PROJECT_PARENT_MISSING");
    // Only the leaf may ever be created — never an ancestor tree.
    expect(fs.existsSync(path.join(base, "a"))).toBe(false);
    await app.close();
  });

  it("createDir against an already-existing directory is idempotent (dirCreated: false), on create", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-existing-"));

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "mkdir-existing", cwd, createDir: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dirCreated).toBe(false);
    await app.close();
  });

  it("400s PROJECT_PATH_IS_SYMLINK for a dangling symlink even with createDir, and never creates a directory at the symlink's target", async () => {
    const app = await buildApp();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dangling-symlink-"));
    const cwd = path.join(parent, "project");
    const target = path.join(parent, "nonexistent-target");
    fs.symlinkSync(target, cwd, "dir");

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "dangling", cwd, createDir: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PROJECT_PATH_IS_SYMLINK");
    expect(fs.existsSync(target)).toBe(false);
    await app.close();
  });

  it("createDir on a remote hostId 400s with PROJECT_DIR_REMOTE_UNSUPPORTED", async () => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-createdir", baseUrl: "http://127.0.0.1:59999", token: "t" },
    });
    const hostId = host.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-createdir", cwd: "/remote/path", hostId, createDir: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PROJECT_DIR_REMOTE_UNSUPPORTED");
    await app.close();
  });

  it("gitInit runs git init only on a freshly-created directory, on create", async () => {
    const app = await buildApp();
    const cwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "git-init-")), "project");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "git-init-fresh", cwd, createDir: true, gitInit: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dirCreated: true, gitInitialized: true });
    expect(fs.existsSync(path.join(cwd, ".git"))).toBe(true);
    await app.close();
  });

  it("gitInit does not run on an already-existing directory, on create", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-init-existing-"));

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "git-init-existing", cwd, createDir: true, gitInit: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dirCreated: false, gitInitialized: false });
    expect(fs.existsSync(path.join(cwd, ".git"))).toBe(false);
    await app.close();
  });

  it("still 201s with gitInitialized: false when git init itself fails, on create — Hermes review, PR #620", async () => {
    const app = await buildApp();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `${GIT_INIT_FAIL_MARKER}-`));
    const cwd = path.join(base, "project");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "git-init-fails", cwd, createDir: true, gitInit: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dirCreated: true, gitInitialized: false });
    // The directory itself still exists — a failed git init doesn't undo
    // the directory creation or the project row.
    expect(fs.existsSync(cwd)).toBe(true);
    await app.close();
  });

  it("gitInit without createDir 400s with PROJECT_GIT_INIT_WITHOUT_CREATE_DIR, on create — Hermes review, PR #620", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-init-no-createdir-create-"));

    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "git-init-no-createdir", cwd, gitInit: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PROJECT_GIT_INIT_WITHOUT_CREATE_DIR");
    await app.close();
  });

  it("rejects a project missing cwd", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "no-cwd" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s deleting an unknown project", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/projects/999999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("deletes a project with no sessions", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "throwaway", cwd: "/tmp" },
    });
    const { id } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(deleted.statusCode).toBe(204);

    await app.close();
  });

  describe("PATCH /api/projects/:id", () => {
    it("updates name and cwd", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "before", cwd: "/tmp/before" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { createDir: true, name: "after", cwd: "/tmp/after" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ id, name: "after", cwd: "/tmp/after" });

      await app.close();
    });

    it("expands a leading ~ in cwd before validating, on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "tilde-edit", cwd: "/tmp/tilde-edit" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: "~/definitely-not-here-update/edited-project" },
      });
      // Same rationale as the create-side version of this test: proves
      // expandHome() runs before validation, with zero filesystem side
      // effects, rather than registering a directory under the real $HOME.
      expect(patched.statusCode).toBe(400);
      expect(patched.json().code).toBe("PROJECT_PARENT_MISSING");
      expect(patched.json().message).toContain(
        path.join(os.homedir(), "definitely-not-here-update"),
      );

      await app.close();
    });

    it("only creates the directory when createDir is set, on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "mkdir-update", cwd: "/tmp/mkdir-update-init" },
      });
      const { id } = created.json();
      const newCwd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-update-")), "project");
      expect(fs.existsSync(newCwd)).toBe(false);

      const withoutFlag = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: newCwd },
      });
      expect(withoutFlag.statusCode).toBe(400);
      expect(withoutFlag.json().code).toBe("PROJECT_DIR_MISSING");
      expect(fs.existsSync(newCwd)).toBe(false);

      const withFlag = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: newCwd, createDir: true },
      });
      expect(withFlag.statusCode).toBe(200);
      expect(withFlag.json()).toMatchObject({ dirCreated: true, gitInitialized: false });
      expect(fs.existsSync(newCwd)).toBe(true);

      await app.close();
    });

    it("400s when the path exists as a file, on update", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "mkdir-fail-update", cwd: "/tmp/mkdir-fail-update-init" },
      });
      const { id } = created.json();
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mkdir-fail-update-"));
      const newCwd = path.join(parent, "project");
      fs.writeFileSync(newCwd, "i am a file, not a directory", "utf-8");

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { cwd: newCwd, createDir: true },
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().code).toBe("PROJECT_PATH_NOT_A_DIRECTORY");

      await app.close();
    });

    it("createDir without cwd 400s with PROJECT_DIR_FLAG_WITHOUT_CWD", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "flag-without-cwd", cwd: "/tmp/flag-without-cwd" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { createDir: true },
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().code).toBe("PROJECT_DIR_FLAG_WITHOUT_CWD");

      await app.close();
    });

    it("does not re-validate cwd when it's unchanged, so a project whose directory was since deleted can still be renamed", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "unchanged-cwd-"));
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "rename-me", cwd },
      });
      const { id } = created.json();
      fs.rmSync(cwd, { recursive: true, force: true });

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { name: "renamed", cwd },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ id, name: "renamed", cwd });

      await app.close();
    });

    it("400s (not 500) when the body contains only createDir/gitInit and no updatable field — Hermes review, PR #620", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flags-only-"));
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "flags-only", cwd },
      });
      const { id } = created.json();

      const gitInitOnly = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { gitInit: true },
      });
      expect(gitInitOnly.statusCode).toBe(400);

      const createDirFalseOnly = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { createDir: false },
      });
      expect(createDirFalseOnly.statusCode).toBe(400);

      await app.close();
    });

    it("gitInit without createDir 400s with PROJECT_GIT_INIT_WITHOUT_CREATE_DIR, on update", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-init-no-createdir-"));
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "git-init-no-createdir", cwd },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { name: "renamed", gitInit: true },
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().code).toBe("PROJECT_GIT_INIT_WITHOUT_CREATE_DIR");

      await app.close();
    });

    it("supports a partial update (name only)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "partial-before", cwd: "/tmp/partial" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { name: "partial-after" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ name: "partial-after", cwd: "/tmp/partial" });

      await app.close();
    });

    it("sets, then clears, devServerUrl (issue #28)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "dev-server", cwd: "/tmp/dev-server" },
      });
      const { id } = created.json();

      const withPort = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "5173" },
      });
      expect(withPort.statusCode).toBe(200);
      expect(withPort.json().devServerUrl).toBe("5173");

      const withUrl = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "http://localhost:5173/base" },
      });
      expect(withUrl.statusCode).toBe(200);
      expect(withUrl.json().devServerUrl).toBe("http://localhost:5173/base");

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().devServerUrl).toBeNull();

      await app.close();
    });

    it("sets, then clears, defaultAgent/defaultReviewAgent (6.2/#215)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "agent-defaults", cwd: "/tmp/agent-defaults" },
      });
      const { id } = created.json();
      expect(created.json().defaultAgent).toBeNull();
      expect(created.json().defaultReviewAgent).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { defaultAgent: "codex", defaultReviewAgent: "agy" },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ defaultAgent: "codex", defaultReviewAgent: "agy" });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { defaultAgent: null, defaultReviewAgent: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().defaultAgent).toBeNull();
      expect(cleared.json().defaultReviewAgent).toBeNull();

      await app.close();
    });

    it("rejects an unrecognized defaultAgent name", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "bad-agent-default", cwd: "/tmp/bad-agent-default" },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { defaultAgent: "not-a-real-agent" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("rejects an out-of-range port and a non-http(s) devServerUrl", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "bad-dev-server", cwd: "/tmp/bad-dev-server" },
      });
      const { id } = created.json();

      const badPort = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "99999" },
      });
      expect(badPort.statusCode).toBe(400);

      const badScheme = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { devServerUrl: "ftp://localhost:5173" },
      });
      expect(badScheme.statusCode).toBe(400);

      await app.close();
    });

    it("404s updating an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/projects/999999",
        payload: { name: "nope" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("rejects an empty body", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "empty-body", cwd: "/tmp/empty-body" },
      });
      const { id } = created.json();

      const res = await app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: {} });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /api/projects/discover", () => {
    let root: string;

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-discover-root-"));
      fs.mkdirSync(path.join(root, "git-repo", ".git"), { recursive: true });
      fs.mkdirSync(path.join(root, "plain-dir"), { recursive: true });
      fs.writeFileSync(path.join(root, "not-a-dir.txt"), "");
      process.env.PROJECTS_ROOTS = root;
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
      delete process.env.PROJECTS_ROOTS;
    });

    it("returns candidate subdirectories, flagging git repos and skipping files", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(res.statusCode).toBe(200);

      const byName = Object.fromEntries(res.json().map((c: { name: string }) => [c.name, c]));
      expect(byName["git-repo"]).toMatchObject({
        cwd: path.join(root, "git-repo"),
        isGitRepo: true,
        isRegistered: false,
      });
      expect(byName["plain-dir"]).toMatchObject({ isGitRepo: false, isRegistered: false });
      expect(byName["not-a-dir.txt"]).toBeUndefined();

      await app.close();
    });

    it("flags a candidate already registered as a project", async () => {
      const app = await buildApp();
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "git-repo", cwd: path.join(root, "git-repo") },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      const byName = Object.fromEntries(res.json().map((c: { name: string }) => [c.name, c]));
      expect(byName["git-repo"].isRegistered).toBe(true);

      await app.close();
    });

    it("ignores a PROJECTS_ROOTS entry that doesn't exist", async () => {
      process.env.PROJECTS_ROOTS = path.join(root, "does-not-exist");
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      process.env.PROJECTS_ROOTS = root;
      await app.close();
    });

    it("prefers settings.projectRoots (Settings -> Projects & discovery) over the PROJECTS_ROOTS env var", async () => {
      const settingsRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-discover-settings-root-"),
      );
      fs.mkdirSync(path.join(settingsRoot, "from-settings"), { recursive: true });

      const app = await buildApp();
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { projectRoots: [settingsRoot] },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      const names = res.json().map((c: { name: string }) => c.name);
      // Only the settings-configured root is scanned — the env-configured
      // root's "git-repo"/"plain-dir" candidates must NOT appear.
      expect(names).toEqual(["from-settings"]);

      // Clearing the array falls back to the env var again.
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { projectRoots: [] },
      });
      const fallback = await app.inject({ method: "GET", url: "/api/projects/discover" });
      expect(
        fallback
          .json()
          .map((c: { name: string }) => c.name)
          .sort(),
      ).toEqual(["git-repo", "plain-dir"]);

      fs.rmSync(settingsRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/dock", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/dock" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns [] for a project with no .crs/dock.json", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-empty-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-dock", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/dock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("reads the project's own .crs/dock.json controls", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-with-controls-"));
      fs.mkdirSync(path.join(projectCwd, ".crs"));
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({
          controls: [
            { id: "dev-server", title: "Dev Server", command: "npm run dev", height: 200 },
          ],
        }),
      );

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "with-dock", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/dock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { id: "dev-server", title: "Dev Server", command: "npm run dev", height: 200 },
      ]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/github (issue #27)", () => {
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
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
    });

    it("400s for a non-integer project id (loadProjectRepoContext's own validation)", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/not-a-number/github" });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s for a project with a github remote but no GitHub account connected", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-no-token-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-token", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(204);
      expect(fetchMock).not.toHaveBeenCalled();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns issue/PR status for a project with a connected token and github remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-github-connected-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        if (url === "https://api.github.com/repos/acme/widgets/issues?state=open&per_page=100") {
          return Promise.resolve(
            jsonResponse(200, [
              {
                number: 1,
                title: "a bug",
                html_url: "https://github.com/acme/widgets/issues/1",
                user: { login: "a" },
              },
              {
                number: 2,
                title: "a PR",
                html_url: "https://github.com/acme/widgets/pull/2",
                user: { login: "b" },
                pull_request: {},
              },
            ]),
          );
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_connected" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "connected", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        repo: { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" },
        openIssues: 1,
        openPRs: 1,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      // Unlike every other test in this block, this needs a real (failing)
      // network connection to 127.0.0.1:1, not the api.github.com fetch
      // mock this describe's beforeEach installs — same pattern the
      // existing "503s actions/dock" test below relies on.
      vi.unstubAllGlobals();

      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "github-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-github", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("GET /api/projects/:id/github/prs (issue #102)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/github/prs" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project with no github.com remote", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-remote-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-remote", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s for a project with a github remote but empty cache (poller hasn't run yet)", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-no-cache-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:o/r.git\n',
      );
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "no-cache", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("204s when the poller cache is populated but has no PRs", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-empty-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:empty/prs.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "empty-prs", cwd: projectCwd },
      });

      // Prime the cache as the poller would.
      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("empty", "prs", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns per-PR status from the warm cache for a connected project", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-cached-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:cached/pr-repo.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "cached-prs", cwd: projectCwd },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("cached", "pr-repo", {
        prs: [
          {
            number: 7,
            title: "Add CI badge",
            htmlUrl: "https://github.com/cached/pr-repo/pull/7",
            author: "dev",
            headSha: "abc",
            headBranch: "add-badge",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [
              {
                name: "CI",
                status: "completed",
                conclusion: "success",
                htmlUrl: "https://github.com/cached/pr-repo/actions/runs/1",
                headSha: "abc",
              },
            ],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prs).toHaveLength(1);
      expect(body.prs[0].number).toBe(7);
      expect(body.prs[0].ciStatus).toBe("success");
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("?branch= filters the cached PR list down to that branch's PR (issue #202)", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-branch-filter-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:branch/filter.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_prs_token" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "branch-filter-prs", cwd: projectCwd },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      const prA = {
        number: 1,
        title: "PR A",
        htmlUrl: "https://github.com/branch/filter/pull/1",
        author: "dev",
        headSha: "a1",
        headBranch: "feature/a",
        baseBranch: "main",
        ciStatus: "success" as const,
        actionsRuns: [],
      };
      const prB = {
        number: 2,
        title: "PR B",
        htmlUrl: "https://github.com/branch/filter/pull/2",
        author: "dev",
        headSha: "b1",
        headBranch: "feature/b",
        baseBranch: "main",
        ciStatus: "failure" as const,
        actionsRuns: [],
      };
      setRepoPRsStatus("branch", "filter", {
        prs: [prA, prB],
        prSummary: { total: 2, pass: 1, fail: 1, pending: 0, unknown: 0 },
      });

      const projectId = created.json().id;

      const filtered = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs?branch=feature/a`,
      });
      expect(filtered.statusCode).toBe(200);
      const filteredBody = filtered.json();
      expect(filteredBody.prs).toHaveLength(1);
      expect(filteredBody.prs[0].number).toBe(1);
      expect(filteredBody.prSummary).toEqual({
        total: 1,
        pass: 1,
        fail: 0,
        pending: 0,
        unknown: 0,
      });

      const noMatch = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs?branch=no-such-branch`,
      });
      expect(noMatch.statusCode).toBe(204);

      const unfiltered = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/github/prs`,
      });
      expect(unfiltered.statusCode).toBe(200);
      expect(unfiltered.json().prs).toHaveLength(2);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host (issue #222)", async () => {
      // Same pattern as the /github route's own unreachable-host test above:
      // a real (failing) connection attempt to 127.0.0.1:1, not the
      // api.github.com fetch mock this describe's beforeEach installs.
      vi.unstubAllGlobals();

      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "prs-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-prs", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("returns per-PR status for a remote-hosted project via the agent (issue #222)", async () => {
      // Full round trip: a real listening agent resolves owner/repo from
      // its own filesystem via /internal/github-repo, the primary reads the
      // warm prsCache (populated here the same way the poller would) keyed
      // by that owner/repo, and returns it — same as the local-project test
      // above, but with the repoRef resolved over the wire instead of via
      // parseGitRemote(project.cwd) directly. fetchMock still handles the
      // github.com token-validation call (like every other test here), but
      // delegates real 127.0.0.1 calls to the actual fetch so the primary's
      // RemoteHostClient can genuinely reach the agent below.
      fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        if (url.startsWith("http://127.0.0.1:")) {
          return realFetch(input, init);
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const remoteCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prs-remote-"));
      fs.mkdirSync(path.join(remoteCwd, ".git"));
      fs.writeFileSync(
        path.join(remoteCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:remote/pr-repo.git\n',
      );

      const AGENT_TOKEN = "prs-remote-agent-token";
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const primary = await buildApp();
      await primary.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_remote_prs_token" },
      });
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "prs-remote-success-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: AGENT_TOKEN,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-prs-success", cwd: remoteCwd, hostId: host.json().id },
      });

      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("remote", "pr-repo", {
        prs: [
          {
            number: 3,
            title: "Remote PR",
            htmlUrl: "https://github.com/remote/pr-repo/pull/3",
            author: "dev",
            headSha: "def",
            headBranch: "remote-branch",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/github/prs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.prs).toHaveLength(1);
      expect(body.prs[0].number).toBe(3);
      expect(body.prSummary).toEqual({ total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 });

      fs.rmSync(remoteCwd, { recursive: true, force: true });
      await primary.close();
      await agentApp.close();
    });
  });

  describe("GET /api/projects/:id/github/actions/:runId/jobs (issue #221)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
    });

    it("returns jobs as a bare array for a connected project with a matching run", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-jobs-connected-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(
        path.join(projectCwd, ".git", "config"),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
      );

      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://api.github.com/user") {
          return Promise.resolve(jsonResponse(200, { login: "octocat" }));
        }
        if (url.startsWith("https://api.github.com/repos/acme/widgets/actions/runs/42/jobs")) {
          return Promise.resolve(
            jsonResponse(200, {
              total_count: 2,
              jobs: [
                {
                  id: 101,
                  name: "lint",
                  status: "completed",
                  conclusion: "success",
                  started_at: "2025-01-01T00:00:00Z",
                  completed_at: "2025-01-01T00:01:00Z",
                  html_url: "https://github.com/acme/widgets/actions/runs/42/jobs/101",
                  steps: [
                    { name: "prettier", status: "completed", conclusion: "success", number: 1 },
                  ],
                },
                {
                  id: 102,
                  name: "test",
                  status: "completed",
                  conclusion: "failure",
                  started_at: "2025-01-01T00:00:00Z",
                  completed_at: "2025-01-01T00:02:00Z",
                  html_url: "https://github.com/acme/widgets/actions/runs/42/jobs/102",
                  steps: [
                    { name: "vitest", status: "completed", conclusion: "failure", number: 1 },
                  ],
                },
              ],
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
      });

      const app = await buildApp();
      await app.inject({
        method: "PUT",
        url: "/api/integrations/github/token",
        payload: { token: "ghp_jobs_test" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "jobs-connected", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/github/actions/42/jobs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe("lint");
      expect(body[0].status).toBe("completed");
      expect(body[0].conclusion).toBe("success");
      expect(body[1].name).toBe("test");
      expect(body[1].status).toBe("completed");
      expect(body[1].conclusion).toBe("failure");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/git-statuses (batch, issue #166)", () => {
    it("returns empty projects/sessions maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
      await app.close();
    });

    it("returns empty projects/sessions maps for an empty ids string", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses?ids=" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
      await app.close();
    });

    it("returns git status for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-real-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-real-repo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(projectId)]).toMatchObject({
        branch: "main",
        isClean: true,
        hasConflicts: false,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-not-a-repo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().projects[String(projectId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project with a transient git failure from the response", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-transient-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Break HEAD so `git status` fails while `.git` still exists.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-transiently-broken", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Project is omitted (not in response) because git status failed.
      expect(res.json()).toEqual({ projects: {}, sessions: {} });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a project on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "batch-remote", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Remote host unreachable — project omitted from response.
      expect(res.json()).toEqual({ projects: {}, sessions: {} });

      await app.close();
    });

    it("handles a mix of repo, non-repo, and transient-failure projects", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });

      const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-nonrepo-"));

      const app = await buildApp();
      const repo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-mix-repo", cwd: repoDir },
      });
      const nonRepo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-mix-nonrepo", cwd: nonRepoDir },
      });
      const repoId = repo.json().id as number;
      const nonRepoId = nonRepo.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${repoId},${nonRepoId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.projects[String(repoId)]).toMatchObject({ branch: "main", isClean: true });
      expect(body.projects[String(nonRepoId)]).toBeNull();

      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
      await app.close();
    });

    it("returns per-session git status for a session's worktree cwd, distinct from its project", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // A real linked worktree on a distinct branch, checked out outside
      // the project's own cwd — exactly the "cwd points outside the
      // project root" shape sessions.cwd allows (see
      // resolveSessionCwdTargets's own doc comment). `git worktree add`
      // requires a path that doesn't exist yet, so the parent (not the
      // worktree dir itself) is what mkdtempSync creates securely —
      // unlike a Date.now()-suffixed path, this isn't guessable/racy
      // (CodeQL js/insecure-temporary-file).
      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-worktree-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/x", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(worktreeDir, "b.txt"), "b");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-session-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: worktreeDir },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Project-level status (its own cwd) stays clean/main.
      expect(body.projects[String(projectId)]).toMatchObject({ branch: "main", isClean: true });
      // Session-level status (the worktree's cwd) is a distinct branch with
      // an untracked file — not the same as the project's own status.
      expect(body.sessions[String(sessionId)]).toMatchObject({
        branch: "feature/x",
        isClean: false,
      });

      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("prefers a session's live (OSC-7-announced) cwd over its static launch cwd once one arrives", async () => {
      // Issue: sidebar worktree display. Unlike the worktree test above (a
      // session launched WITH a cwd override), this session is launched with
      // NO cwd override at all — session.cwd stays null, spawned at the
      // project's own root. `app.pty.get(id)?.liveCwd` is stubbed rather than
      // driven through a real spawned shell (this test's actual concern is
      // resolveSessionCwdTargets's merge logic, not PtyManager's OSC-7
      // wiring — already covered by test/services/pty-manager.test.ts's own
      // liveCwd tests — and a real spawn depends on a live systemd --user
      // session, which isn't guaranteed in every test environment).
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-livecwd-wt-"));
      const worktreeDir = path.join(worktreeParent, "wt");
      execFileSync("git", ["worktree", "add", "-b", "feature/live", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-session-livecwd-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      // No `cwd` in the body — session.cwd stays null, spawned at projectCwd.
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: worktreeDir } as ReturnType<typeof app.pty.get>);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "feature/live" });

      getSpy.mockRestore();
      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.rmSync(worktreeParent, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to the static launch cwd when the live cwd isn't a real git repo", async () => {
      // Guards resolveSessionCwdTargets's isGitRepo gate: a `liveCwd` is
      // parsed straight off the PTY byte stream (stale, mid-typo, or a
      // shell-integration bug), so a bogus value must not be trusted as a
      // `git -C` target — it should silently fall back to the session's
      // static cwd instead, same "nothing to show" posture as this
      // endpoint's other gaps, not a crash or a wrong branch.
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-badlive-project-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-session-badlive-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: "/definitely/not/a/real/repo" } as ReturnType<
          typeof app.pty.get
        >);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "main" });

      getSpy.mockRestore();
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null in the sessions map for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-project-"));
      const sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-nonrepo-cwd-"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-session-nonrepo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash", cwd: sessionCwd },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(sessionCwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to the static launch cwd when the live cwd is a real git repo but NOT one of this project's own worktrees", async () => {
      // Issue: worktree/branch detection — a session's live cwd can now be
      // updated by an agent piggybacking its cwd on every hook event (see
      // forwarder-core.mjs's mapClaudeCodeEvent), which means it can wander
      // into ANY repo the agent happens to visit, not just this project's
      // own worktrees. Unlike the "badlive" test above (a bogus, non-repo
      // path), this uses a genuinely separate, unrelated git repository —
      // isGitRepo() alone would accept it, so this guards the additional
      // "is it actually one of THIS project's own worktrees" check.
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-foreign-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // A completely separate repository — same shape as isGitRepo would
      // accept, but not reachable from `git worktree list` on projectCwd.
      const foreignRepo = fs.mkdtempSync(path.join(os.tmpdir(), "batch-session-foreign-repo-"));
      execFileSync("git", ["init", "-b", "unrelated-branch"], {
        cwd: foreignRepo,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: foreignRepo,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: foreignRepo,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(foreignRepo, "c.txt"), "c");
      execFileSync("git", ["add", "-A"], { cwd: foreignRepo, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: foreignRepo,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "batch-session-foreign-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const getSpy = vi
        .spyOn(app.pty, "get")
        .mockReturnValue({ liveCwd: foreignRepo } as ReturnType<typeof app.pty.get>);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      // Falls back to the session's static cwd (the project root, "main"),
      // NOT the foreign repo's "unrelated-branch".
      expect(res.json().sessions[String(sessionId)]).toMatchObject({ branch: "main" });

      getSpy.mockRestore();
      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(foreignRepo, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session with no matching row (already deleted) from the sessions map", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-statuses?sessionIds=999999",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {} });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-status (issue #76)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-status" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branch/hash/isClean for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-real-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "real-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ branch: "main", isClean: true, hasConflicts: false });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, PR #506 — the sidebar's Source Control section and
    // GitPanel both call this route right after a manual "Fetch" to show
    // the result immediately; without a way to bypass git-status.ts's own
    // ~5s in-memory cache, that call would typically just hand back
    // whatever was cached before the fetch ran.
    it("?fresh=1 bypasses the cache and reflects a change made after the first read", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-fresh-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "fresh-status-repo", cwd: projectCwd },
      });
      const projectId = created.json().id;

      const clean = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(clean.json().isClean).toBe(true);

      // Dirties the tree without touching the cache — a plain (no ?fresh)
      // re-read within CACHE_TTL_MS should still report the stale "clean"
      // read, proving the cache is genuinely in play here.
      fs.writeFileSync(path.join(projectCwd, "b.txt"), "b");
      const stillCached = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(stillCached.json().isClean).toBe(true);

      const fresh = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status?fresh=1`,
      });
      expect(fresh.json().isClean).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-status-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-git-status", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    // Distinguishes "not a repo" (204, durable) from "is a repo but git
    // status itself failed" (503, transient) — the fix for the sidebar/
    // GitPanel flicker: a client that treats 503 as "keep my last-known-good"
    // and only clears to empty on 204 stops flickering on a single failed
    // poll tick.
    it("503s (not 204) for a local project that IS a repo but git status fails transiently", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-status-transient-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Break HEAD so `git status` fails while `.git` still exists — the
      // same technique as git-status.test.ts's own transient-failure test.
      fs.unlinkSync(path.join(projectCwd, ".git", "HEAD"));

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "transiently-broken-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-status`,
      });
      expect(res.statusCode).toBe(503);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/:id/git-branches (issue #162)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/git-branches" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("204s for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "not-a-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(204);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns branches and worktrees for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-real-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["branch", "feature/foo"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "real-repo-branches", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // objectContaining, not exact equality — issue #442 adds unconditional
      // enrichment fields (lastCommitRelative etc.) to every branch entry.
      expect(body.branches).toContainEqual(
        expect.objectContaining({ name: "main", isCurrent: true }),
      );
      expect(body.branches).toContainEqual(
        expect.objectContaining({ name: "feature/foo", isCurrent: false }),
      );
      expect(body.branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined)).toBe(
        true,
      );
      expect(body.worktrees).toEqual([{ path: projectCwd, branch: "main", isMain: true }]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("resolves isMerged only when ?detail=1 is set (issue #442)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-detail-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["checkout", "-b", "merged-branch"]);
      run(["checkout", "main"]);
      run(["merge", "merged-branch", "--no-edit"]);
      const remoteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-git-branches-detail-origin-"),
      );
      execFileSync("git", ["init", "--bare", "-b", "main"], {
        cwd: remoteDir,
        stdio: "pipe",
        env: gitEnv(),
      });
      run(["remote", "add", "origin", remoteDir]);
      run(["push", "-u", "origin", "main"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "detail-repo-branches", cwd: projectCwd },
      });

      const withoutDetail = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(
        withoutDetail
          .json()
          .branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined),
      ).toBe(true);

      const withDetail = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches?detail=1`,
      });
      expect(
        withDetail.json().branches.find((b: { name: string }) => b.name === "merged-branch")
          .isMerged,
      ).toBe(true);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-branches-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-git-branches", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-fetch (issue #442 — previously untested)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-fetch" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("runs git fetch for a real local repo with no remote configured, reporting success: false", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-fetch-"));
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "fetch-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-fetch`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ success: expect.any(Boolean) as boolean }),
      );

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-fetch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-git-fetch", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-fetch`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-branch-delete (issue #442)", () => {
    async function makeProjectWithBranch(app: Awaited<ReturnType<typeof buildApp>>) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-delete-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature-x"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "branch-delete-repo", cwd: projectCwd },
      });
      return { projectCwd, projectId: created.json().id as number };
    }

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-branch-delete",
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    // Hermes review on PR #505 — schema-level defense-in-depth.
    it("400s for a name exceeding the schema's maxLength", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "x".repeat(256) },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s and deletes a branch for a real local git repo", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s with a refusal reason (current-branch), not a 4xx, for a git-level refusal", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: false, reason: "current-branch" });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses with reason task-branch when a resumable task claims the branch, and force overrides it", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithBranch(app);
      const { tasks } = await import("../../src/db/schema.js");
      app.db
        .insert(tasks)
        .values({
          projectId,
          title: "in-flight task",
          status: "in_progress",
          branchName: "feature-x",
        })
        .run();

      const refused = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x" },
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toEqual({
        deleted: false,
        reason: "task-branch",
        detail: expect.stringMatching(/^#\d+$/) as string,
      });

      const forced = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-branch-delete`,
        payload: { name: "feature-x", force: true },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toEqual({ deleted: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "branch-delete-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-branch-delete", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-branch-delete`,
        payload: { name: "main" },
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("deletes a branch on a remote-hosted project via the agent (full round trip)", async () => {
      const { execFileSync } = await import("node:child_process");
      const remoteCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-delete-remote-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: remoteCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(remoteCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature-remote"]);

      const AGENT_TOKEN = "branch-delete-remote-agent-token";
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "branch-delete-remote-success-host",
          baseUrl: `http://127.0.0.1:${address.port}`,
          token: AGENT_TOKEN,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-branch-delete-success", cwd: remoteCwd, hostId: host.json().id },
      });

      const res = await primary.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-branch-delete`,
        payload: { name: "feature-remote" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      fs.rmSync(remoteCwd, { recursive: true, force: true });
      await primary.close();
      await agentApp.close();
    });
  });

  describe("POST /api/projects/:id/git-worktree-remove (issue #442)", () => {
    async function makeProjectWithWorktree(app: Awaited<ReturnType<typeof buildApp>>) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-worktree-remove-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(projectCwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "worktree-remove-repo", cwd: projectCwd },
      });
      return { projectCwd, worktreePath, projectId: created.json().id as number };
    }

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-worktree-remove",
        payload: { worktreePath: "/tmp/x" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    // Hermes review on PR #505 — schema-level defense-in-depth.
    it("400s for a worktreePath exceeding the schema's maxLength", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithWorktree(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath: `/${"x".repeat(4096)}` },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s and removes a clean, hand-made worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("200s with reason is-main for the project's own cwd, never sessions-active", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      // An active session under the project's own cwd — if the live-session
      // guard ran unconditionally, this would report "sessions-active"
      // instead of the more specific "is-main" the service itself reports.
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run();

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath: projectCwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: false, reason: "is-main" });
      expect(fs.existsSync(projectCwd)).toBe(true);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("refuses with reason sessions-active when a live session's cwd is under the worktree, and force overrides it", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionInsert = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: worktreePath })
        .run();
      const sessionId = Number(sessionInsert.lastInsertRowid);

      const refused = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toEqual({
        removed: false,
        reason: "sessions-active",
        detail: String(sessionId),
      });
      expect(fs.existsSync(worktreePath)).toBe(true);

      const forced = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath, force: true },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("does not report sessions-active for a done task's stale worktreePath reference (independent review, PR #505)", async () => {
      // sessionsUnderWorktree's task-row match must share the same
      // RESUMABLE_TASK_STATUSES scope branchClaimedByResumableTask already
      // has — tasks.worktreePath is never nulled on a done/cancelled
      // transition, so without this scope a long-finished task would
      // forever misreport an exited session as "active" here.
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { tasks, sessions } = await import("../../src/db/schema.js");
      const sessionInsert = app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: projectCwd, status: "exited" })
        .run();
      const sessionId = Number(sessionInsert.lastInsertRowid);
      app.db
        .insert(tasks)
        .values({
          projectId,
          title: "finished task",
          status: "done",
          worktreePath,
          sessionId,
        })
        .run();

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/git-worktree-remove`,
        payload: { worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "worktree-remove-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-worktree-remove", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-worktree-remove`,
        payload: { worktreePath: "/x/.mullion-worktrees/foo" },
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-worktree-prune (issue #442)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-worktree-prune",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("200s and clears stale worktree metadata for a real local git repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-worktree-prune-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(projectCwd, ".mullion-worktrees", "oob-removed");
      run(["worktree", "add", "-b", "oob-branch", worktreePath, "main"]);
      fs.rmSync(worktreePath, { recursive: true, force: true });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "worktree-prune-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-worktree-prune`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pruned: true });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "worktree-prune-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-worktree-prune", cwd: "/x", hostId: host.json().id },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-worktree-prune`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("GET /api/projects/git-diff-stats (batch, issue #202)", () => {
    it("returns an empty object when no sessionIds are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-diff-stats" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
      await app.close();
    });

    it("returns diff stats for a session's cwd with a modified tracked file", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-project-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\nTWO\nthree\nfour\n");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "diff-stats-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null for a session whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-nonrepo-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "diff-stats-nonrepo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns zero-change stats for a clean repo with no diff against HEAD", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-clean-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "diff-stats-clean", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()[String(sessionId)]).toEqual({
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("omits a session on an unreachable remote host from the response", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "diff-stats-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "diff-stats-remote-project", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      // Seeded straight into the DB, not via POST /api/sessions — a real
      // spawn attempt against this unreachable host would 502 and roll the
      // row back before this test ever gets to exercise the batch endpoint
      // (see the "detectedDevServerPort" describe block's identical
      // seed-straight-into-the-DB pattern for a remote project).
      const { sessions } = await import("../../src/db/schema.js");
      const [created] = app.db
        .insert(sessions)
        .values({ projectId, command: "bash" })
        .returning()
        .all();

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${created.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});

      await app.close();
    });

    it("returns branch-wide diff stats when base is set (issue #262)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-base-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      // Create a feature branch with additional commits
      execFileSync("git", ["checkout", "-b", "feature"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "feature commit", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "diff-stats-base-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      // Without base param: zero (all changes are committed)
      const resNoBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(resNoBase.statusCode).toBe(200);
      expect(resNoBase.json()[String(sessionId)]).toEqual({
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });

      // With base=main: shows feature branch delta
      const resWithBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=main`,
      });
      expect(resWithBase.statusCode).toBe(200);
      expect(resWithBase.json()[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
      });

      // With an invalid base ref pattern: 400
      const resInvalidBase = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=../escape`,
      });
      expect(resInvalidBase.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("auto-derives the base ref when base=AUTO (issue #262 follow-up)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-auto-"));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // Create a remote with origin/main to exercise the AUTO resolution path.
      const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-stats-auto-remote-"));
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["remote", "add", "origin", remoteDir], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["push", "origin", "main", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      // Create a feature branch with additional commits.
      execFileSync("git", ["checkout", "-b", "feature"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "feature commit", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "diff-stats-auto-project", cwd: projectCwd },
      });
      const projectId = created.json().id as number;
      const sessionRes = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = sessionRes.json().id as number;

      // With base=AUTO, the backend should resolve origin/main and compute the
      // feature branch delta vs main.
      const resAuto = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}&base=AUTO`,
      });
      expect(resAuto.statusCode).toBe(200);
      expect(resAuto.json()[String(sessionId)]).toEqual({
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
      });

      fs.rmSync(remoteDir, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("GET /api/projects/git-file-diff (issue #433, projectId variant)", () => {
    async function makeRepoProject(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
      execFileSync("git", ["init", "-b", "main"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\ntwo\nthree\n");
      execFileSync("git", ["add", "-A"], { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "one\nTWO\nthree\n");

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name, cwd: projectCwd },
      });
      return { projectId: created.json().id as number, projectCwd };
    }

    it("returns a patch for a project's own working-tree diff", async () => {
      const app = await buildApp();
      const { projectId, projectCwd } = await makeRepoProject(app, "git-file-diff-project");

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=a.txt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().patch).toContain("TWO");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown projectId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?projectId=999999&path=a.txt",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s when neither sessionId nor projectId is given", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?path=a.txt",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s when both sessionId and projectId are given", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/git-file-diff?sessionId=1&projectId=1&path=a.txt",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s on a path-traversal attempt with projectId", async () => {
      const app = await buildApp();
      const { projectId, projectCwd } = await makeRepoProject(app, "git-file-diff-traversal");

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null patch for a project whose cwd isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "git-file-diff-nonrepo-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "git-file-diff-nonrepo", cwd: projectCwd },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-file-diff?projectId=${projectId}&path=a.txt`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().patch).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("currentBranch (issue #96)", () => {
    it("is the branch name for a local git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-current-branch-"));
      fs.mkdirSync(path.join(projectCwd, ".git"));
      fs.writeFileSync(path.join(projectCwd, ".git", "HEAD"), "ref: refs/heads/feature/foo\n");

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "branchy", cwd: projectCwd },
      });

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === created.json().id);
      expect(project.currentBranch).toBe("feature/foo");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("is null for a project on an unreachable remote host, without failing the whole list", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "branch-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-branch", cwd: "/x", hostId: host.json().id },
      });

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      expect(listed.statusCode).toBe(200);
      const project = listed.json().find((p: { id: number }) => p.id === created.json().id);
      expect(project.currentBranch).toBeNull();
      // Issue #431, Hermes review on PR #458 — currentBranch and ruleFiles
      // now fetch concurrently (Promise.all) instead of in series; each
      // keeps its own independent catch, so one host failure degrades both
      // to their own empty value rather than one masking the other.
      expect(project.ruleFiles).toEqual([]);

      await app.close();
    });

    // Issue #431, Hermes review on PR #458 (round 6) — getRemoteHostClient()
    // throws SYNCHRONOUSLY for a hostId with no matching host row (this
    // repo's hostId FK is deliberately unenforced at the SQLite level — see
    // schema.ts — and DELETE /api/hosts/:id?cascade=true is a real,
    // reachable way to leave a project's hostId dangling like this). The
    // round-4 concurrency refactor hoisted that call outside its own
    // try/catch, so this single project's dangling hostId used to 500 the
    // ENTIRE GET /api/projects list instead of just its own row degrading.
    it("degrades a single project with a dangling hostId instead of 500ing the whole list", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "dangling-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dangling-hostid-project", cwd: "/x", hostId: host.json().id },
      });
      const otherLocal = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          name: "still-fine-local",
          cwd: fs.mkdtempSync(path.join(os.tmpdir(), "dangling-hostid-sibling-")),
        },
      });

      // schema.ts is explicit that projects.hostId's FK isn't enforced at
      // the SQLite level — deleting the host row directly (not via
      // DELETE /api/hosts, whose ?cascade=true also deletes the projects
      // themselves, never leaving one dangling) reproduces the case a
      // stale/corrupted row would: a project whose hostId no longer
      // resolves to any host at all.
      const { hosts } = await import("../../src/db/schema.js");
      const { eq } = await import("drizzle-orm");
      app.db.delete(hosts).where(eq(hosts.id, host.json().id)).run();

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      expect(listed.statusCode).toBe(200);
      const danglingProject = listed.json().find((p: { id: number }) => p.id === created.json().id);
      expect(danglingProject.currentBranch).toBeNull();
      expect(danglingProject.ruleFiles).toEqual([]);
      // The sibling local project's own row must be unaffected.
      const sibling = listed.json().find((p: { id: number }) => p.id === otherLocal.json().id);
      expect(sibling.currentBranch).not.toBeUndefined();

      await app.close();
    });
  });

  describe("multi-host (issue #26)", () => {
    it("rejects creating a project with an unknown hostId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "orphan", cwd: "/x", hostId: "does-not-exist" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("stores a remote project's cwd raw, without local ~-expansion", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote", cwd: "~/on-the-agent", hostId: host.json().id },
      });
      expect(created.statusCode).toBe(201);
      // Expanding against *this* process's home dir would be wrong — issue
      // #26's landmine #3: a remote cwd must resolve on the agent's own
      // filesystem, so the primary stores/forwards it untouched.
      expect(created.json().cwd).toBe("~/on-the-agent");
      await app.close();
    });

    it("keys discovery's isRegistered match by (hostId, cwd), not cwd alone", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box-2", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = host.json().id as string;
      // A *local* project at the same cwd a remote discover candidate would
      // report must not make that remote candidate look already-registered.
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "same-path-local", cwd: "/shared/path" },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/discover?hostId=${hostId}`,
      });
      // The unreachable remote host makes discovery itself fail — 503,
      // never a false "isRegistered" derived from the local project above.
      expect(res.statusCode).toBe(503);
      await app.close();
    });

    it("404s discovery for an unknown hostId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/discover?hostId=does-not-exist",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("503s actions/dock for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "box-3", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-actions", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id;

      const actions = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/actions`,
      });
      expect(actions.statusCode).toBe(503);

      const dock = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(dock.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("detectedDevServerPort (issue #28 phase 7)", () => {
    it("is null for a project with an active dock session this process hasn't tracked in PtyManager", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "untracked-dock", cwd: "/tmp" },
      });
      const projectId = created.json().id as number;

      // Seeded straight into the DB, not via POST /api/sessions: this
      // process's own PtyManager never spawned/attached it (app.pty.get
      // returns undefined either way), so this only exercises the
      // dock-session *query* and grouping, not a real PTY.
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "npm run dev", kind: "dock" }).run();

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });

    it("is null for a remote-hosted project, even with an active local-looking dock session row", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "detect-box", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-dock", cwd: "/x", hostId: host.json().id },
      });
      const projectId = created.json().id as number;

      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "npm run dev", kind: "dock" }).run();

      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });

    it("ignores a killed or terminal-kind session, only ever considering active dock sessions", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "mixed-sessions", cwd: "/tmp" },
      });
      const projectId = created.json().id as number;

      const { sessions } = await import("../../src/db/schema.js");
      app.db
        .insert(sessions)
        .values([
          { projectId, command: "npm run dev", kind: "dock", status: "killed" },
          { projectId, command: "bash", kind: "terminal", status: "active" },
        ])
        .run();

      // Not a security/correctness assertion beyond "the route doesn't
      // crash or misclassify these" — with no *active dock* session at all,
      // the result is still null regardless of what PtyManager itself
      // would have returned.
      const listed = await app.inject({ method: "GET", url: "/api/projects" });
      const project = listed.json().find((p: { id: number }) => p.id === projectId);
      expect(project.detectedDevServerPort).toBeNull();

      await app.close();
    });
  });

  // #490b — enableWebhooks only ever covers the projects that exist when
  // it's called; these cover the immediate-registration paths that close
  // the "project added afterward" gap without waiting for the periodic
  // reconciler (webhook-reconciler.test.ts covers that backstop).
  describe("webhook registration on project create/update/delete (#490b)", () => {
    // Issue #525 — this block builds/closes twice as many apps per test as
    // the rest of the file (the beforeEach DB reset below, plus each test's
    // own), all against the SAME hooks.sock (test/setup.ts sets
    // SESSIONS_DIR once per worker). An unclosed app here — e.g. a thrown
    // assertion between `buildApp()` and `app.close()` — used to leak a
    // live listener that every *later* buildApp() in the whole file
    // (unrelated describe blocks included) would then fail against with a
    // misleading SocketAlreadyListeningError. Giving this block its own
    // SESSIONS_DIR contains that failure mode to this block; makeApp()
    // below (closed unconditionally in afterEach) stops it from leaking at
    // all.
    let previousSessionsDir: string | undefined;
    const sessionsDir = uniqueSessionsDir();

    beforeAll(() => {
      previousSessionsDir = process.env.SESSIONS_DIR;
      process.env.SESSIONS_DIR = sessionsDir;
    });

    afterAll(() => {
      // Not a plain assignment: process.env coerces `undefined` to the
      // string "undefined" rather than deleting the key (same idiom as the
      // "remote host" tests' own env restore above in this file).
      if (previousSessionsDir === undefined) delete process.env.SESSIONS_DIR;
      else process.env.SESSIONS_DIR = previousSessionsDir;
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    });

    let apps: Awaited<ReturnType<typeof buildApp>>[] = [];
    async function makeApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
      const app = await buildApp();
      apps.push(app);
      return app;
    }

    function jsonRes(status: number, body: unknown) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    async function githubRepo(owner: string, repo: string): Promise<string> {
      const { execFileSync } = await import("node:child_process");
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-wiring-test-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], {
        cwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      fs.writeFileSync(path.join(cwd, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      return cwd;
    }

    async function enableWebhooksDirect(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
      const { integrations } = await import("../../src/db/schema.js");
      const { GITHUB_PROVIDER, setPat } = await import("../../src/services/github-integration.js");
      const { eq: eqOp } = await import("drizzle-orm");
      const savedFetch = globalThis.fetch;
      globalThis.fetch = (async () => jsonRes(200, { login: "octocat" })) as typeof fetch;
      await setPat(app, "ghp_wiring_token");
      globalThis.fetch = savedFetch;
      app.db
        .update(integrations)
        .set({
          webhookEnabled: true,
          webhookSecretEnc: app.encryption.encryptString("wiring-secret"),
        })
        .where(eqOp(integrations.provider, GITHUB_PROVIDER))
        .run();
    }

    let originalFetch: typeof fetch;

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      process.env.MULLION_WEBHOOK_BASE_URL = "https://hooks.example.com";
      // Each test builds its own app against the SAME shared DATABASE_URL
      // this file's outer beforeAll set up — without an explicit reset, an
      // earlier test's `integrations.webhookEnabled=true` (and any
      // projects/registrations it created) would leak into the next one.
      const { integrations, webhookRegistrations, projects } =
        await import("../../src/db/schema.js");
      const { GITHUB_PROVIDER } = await import("../../src/services/github-integration.js");
      const { eq: eqOp } = await import("drizzle-orm");
      // Not tracked via makeApp()/afterEach: this app must be fully closed
      // before the test body's own makeApp() call runs (same hooks.sock,
      // same SESSIONS_DIR — see the describe-level comment above), not
      // merely closed *eventually*. try/finally still guarantees the close
      // runs even if one of the deletes below throws.
      const app = await buildApp();
      try {
        app.db.delete(integrations).where(eqOp(integrations.provider, GITHUB_PROVIDER)).run();
        app.db.delete(webhookRegistrations).run();
        app.db.delete(projects).run();
      } finally {
        await app.close();
      }
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      delete process.env.MULLION_WEBHOOK_BASE_URL;
      const toClose = apps;
      apps = [];
      // All tracked apps in this block share one hooks.sock (this block's
      // own SESSIONS_DIR above) — any survivor's path is the same one.
      const hookSocketPath = toClose[0]?.pty.hookSocketPath;
      // allSettled (not all): one app's close() rejecting must not skip
      // closing the rest and re-leak their hooks.sock. Failures are still
      // surfaced (not swallowed) below — issue #525 is specifically about
      // a close silently not happening, so this hook must not repeat that.
      const results = await Promise.allSettled(toClose.map((app) => app.close()));
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        // Hermes review, PR #526 — "[afterEach teardown]" prefix keeps this
        // visually distinct from the test's own assertion failure (if any)
        // in the reporter output, rather than the two being hard to tell
        // apart.
        throw new Error(
          `[afterEach teardown] ${failures.length}/${toClose.length} app.close() call(s) failed: ` +
            failures.map((f) => String(f.reason)).join("; "),
        );
      }

      // Hermes review, PR #526 — deterministic regression guard for #525:
      // a leaked, still-listening app would leave this file behind instead
      // of merely making some *later* buildApp() fail with a misleading
      // SocketAlreadyListeningError.
      if (hookSocketPath) {
        expect(
          fs.existsSync(hookSocketPath),
          `hooks.sock still exists after closing all apps built by this test: ${hookSocketPath}`,
        ).toBe(false);
      }
    });

    it("registers a webhook for a project created while webhooks are enabled", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const cwd = await githubRepo("acme", "wiring-create");

      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/hooks") && (!init || init.method === undefined)) {
          return Promise.resolve(jsonRes(200, []));
        }
        return Promise.resolve(jsonRes(201, { id: 321 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "wiring-create", cwd },
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json().id as number;

      const { webhookRegistrations } = await import("../../src/db/schema.js");
      const { eq: eqOp } = await import("drizzle-orm");
      const [row] = app.db
        .select()
        .from(webhookRegistrations)
        .where(eqOp(webhookRegistrations.projectId, projectId))
        .all();
      expect(row).toMatchObject({ owner: "acme", repo: "wiring-create", hookId: 321 });

      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("does not attempt registration when webhooks are disabled (default)", async () => {
      const app = await makeApp();
      const cwd = await githubRepo("acme", "wiring-disabled");
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "wiring-disabled", cwd },
      });
      expect(created.statusCode).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();

      fs.rmSync(cwd, { recursive: true, force: true });
    });

    it("re-registers when a project's cwd is updated to a different repo", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const originalCwd = await githubRepo("acme", "wiring-before");
      const newCwd = await githubRepo("acme", "wiring-after");

      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/hooks") && (!init || init.method === undefined)) {
          return Promise.resolve(jsonRes(200, []));
        }
        return Promise.resolve(jsonRes(201, { id: 555 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "wiring-patch", cwd: originalCwd },
      });
      const projectId = created.json().id as number;
      fetchMock.mockClear();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { createDir: true, cwd: newCwd },
      });
      expect(patched.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalled();

      const { webhookRegistrations } = await import("../../src/db/schema.js");
      const { eq: eqOp } = await import("drizzle-orm");
      const [row] = app.db
        .select()
        .from(webhookRegistrations)
        .where(eqOp(webhookRegistrations.projectId, projectId))
        .all();
      expect(row).toMatchObject({ owner: "acme", repo: "wiring-after" });

      fs.rmSync(originalCwd, { recursive: true, force: true });
      fs.rmSync(newCwd, { recursive: true, force: true });
    });

    // Hermes review, PR #511 — a cwd change used to register the new
    // repo's hook but never tear down the previous repo's, leaving it live
    // on GitHub and delivering events for a repo this project no longer
    // tracks.
    it("unregisters the previous repo's hook when a project's cwd changes to a different repo", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const originalCwd = await githubRepo("acme", "wiring-move-before");
      const newCwd = await githubRepo("acme", "wiring-move-after");

      const calls: { url: string; method?: string }[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        if (String(url).includes("wiring-move-before")) {
          if (init?.method === "DELETE")
            return Promise.resolve(new Response(null, { status: 204 }));
          // GET existing hooks (registration and unregistration both call
          // this) reports the hook created below as still live on GitHub.
          if (!init || init.method === undefined) {
            return Promise.resolve(
              jsonRes(200, [
                {
                  id: 901,
                  active: true,
                  config: { url: "https://hooks.example.com/api/webhooks/github" },
                },
              ]),
            );
          }
          return Promise.resolve(jsonRes(200, { id: 901 })); // PATCH (already exists)
        }
        if (String(url).includes("wiring-move-after")) {
          if (!init || init.method === undefined) return Promise.resolve(jsonRes(200, []));
          return Promise.resolve(jsonRes(201, { id: 902 }));
        }
        return Promise.resolve(jsonRes(200, []));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "wiring-move", cwd: originalCwd },
      });
      const projectId = created.json().id as number;

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { createDir: true, cwd: newCwd },
      });
      expect(patched.statusCode).toBe(200);

      expect(calls).toContainEqual(
        expect.objectContaining({
          method: "DELETE",
          url: expect.stringContaining("wiring-move-before/hooks/901"),
        }),
      );

      const { webhookRegistrations } = await import("../../src/db/schema.js");
      const { eq: eqOp } = await import("drizzle-orm");
      const [row] = app.db
        .select()
        .from(webhookRegistrations)
        .where(eqOp(webhookRegistrations.projectId, projectId))
        .all();
      expect(row).toMatchObject({ owner: "acme", repo: "wiring-move-after", hookId: 902 });

      fs.rmSync(originalCwd, { recursive: true, force: true });
      fs.rmSync(newCwd, { recursive: true, force: true });
    });

    it("unregisters the hook when a project with a registered webhook is deleted", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const cwd = await githubRepo("acme", "wiring-delete");

      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/hooks") && (!init || init.method === undefined)) {
          return Promise.resolve(jsonRes(200, []));
        }
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(jsonRes(201, { id: 777 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "wiring-delete", cwd },
      });
      const projectId = created.json().id as number;
      fetchMock.mockClear();
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        // The unregister path's own getExistingHooks call.
        return Promise.resolve(
          jsonRes(200, [
            {
              id: 777,
              active: true,
              config: { url: "https://hooks.example.com/api/webhooks/github" },
            },
          ]),
        );
      });

      const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}` });
      expect(deleted.statusCode).toBe(204);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/hooks/777"),
        expect.objectContaining({ method: "DELETE" }),
      );

      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });
});
