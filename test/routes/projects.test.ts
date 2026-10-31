import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";
import type { SessionBackend } from "../../src/services/session-backend.js";
// The relay's landed-check memo (issue #1630) — cleared per test so one
// test's answer is not the next one's.
import { gitEnv } from "../../src/services/git-env.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";
import { resolveGitHubToken } from "../../src/services/github-integration.js";
import { PR_REVIEW_DEFAULTS } from "../helpers/pr-review-defaults.js";

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
      payload: { createDir: true, allowDuplicate: true, name: "home", cwd: homeCwd },
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

  // Issue #1723 / roadmap 8.9 — the placement opt-in. "pinned" is the
  // default, so nothing changes until a user asks for "auto".
  it("defaults a new project to the pinned placement mode", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-placement-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "pinned-project", cwd },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().placement).toBe("pinned");

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.json()[0].placement).toBe("pinned");
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("opts a project into automatic placement on create, and back out of it on PATCH", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-placement-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        createDir: true,
        allowDuplicate: true,
        name: "auto-project",
        cwd,
        placement: "auto",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().placement).toBe("auto");

    const { id } = created.json();
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { placement: "pinned" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().placement).toBe("pinned");

    const optedIn = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { placement: "auto" },
    });
    expect(optedIn.statusCode).toBe(200);
    expect(optedIn.json().placement).toBe("auto");

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // Issue #1724 / roadmap 8.10 — the per-host cwd map. It is what makes a
  // remote host a placement CANDIDATE at all: a session runs in a
  // directory, and this says where the project is on each host.
  it("round-trips the per-host cwd map, and clears it with null", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-hostcwds-"));
    // A REAL host: the map's keys must name hosts we know about, so the
    // test registers one rather than inventing an id.
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-a", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = host.json().id as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "mapped-project",
        cwd,
        placement: "auto",
        hostCwds: { [hostId]: "/srv/repo" },
      },
    });
    expect(created.statusCode).toBe(201);
    // The API speaks the shape it accepts: an object, not the column's
    // JSON encoding.
    expect(created.json().hostCwds).toEqual({ [hostId]: "/srv/repo" });

    const { id } = created.json();
    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    // The list holds every project in this file's shared DB, so find ours
    // by id rather than by position.
    expect(listed.json().find((p: { id: number }) => p.id === id).hostCwds).toEqual({
      [hostId]: "/srv/repo",
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { hostCwds: { [hostId]: "/opt/repo" } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().hostCwds).toEqual({ [hostId]: "/opt/repo" });

    // null clears the map: the project lives on its own host and nowhere
    // else, which is what an absent map means.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { hostCwds: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().hostCwds).toEqual({});

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("round-trips a per-project gitIdentity and clears it with null", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-identity-"));
    const identity = { name: "Ada Lovelace", email: "ada@example.com" };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "ident-project",
        cwd,
        gitIdentity: identity,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().gitIdentity).toEqual(identity);
    const id = created.json().id;

    const half = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { gitIdentity: { name: "only a name" } },
    });
    expect(half.statusCode).toBe(400);

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { gitIdentity: { name: "Grace", email: "grace@example.com" } },
    });
    expect(changed.json().gitIdentity).toEqual({ name: "Grace", email: "grace@example.com" });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { gitIdentity: null },
    });
    expect(cleared.json().gitIdentity).toBeNull();

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // Issue #2241 — placement steering flags.
  it("round-trips placementConstraints, reads back defaults, and clears them with null", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-constraints-"));

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "steered-project",
        cwd,
        placementConstraints: {
          platform: ["darwin"],
          allowBurst: true,
          capabilities: ["xcode"],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().placementConstraints).toEqual({
      platform: ["darwin"],
      allowBurst: true,
      capabilities: ["xcode"],
    });
    const { id } = created.json();

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.json().find((p: { id: number }) => p.id === id).placementConstraints).toEqual({
      platform: ["darwin"],
      allowBurst: true,
      capabilities: ["xcode"],
    });

    // A partial object fills the defaults.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { placementConstraints: { platform: ["linux", "win32"], allowBurst: false } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().placementConstraints).toEqual({
      platform: ["linux", "win32"],
      allowBurst: false,
      capabilities: [],
    });

    // Capabilities alone are a real flag, and an unknown one is rejected.
    const capsOnly = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: {
        placementConstraints: {
          platform: [],
          allowBurst: false,
          capabilities: ["android-emulator"],
        },
      },
    });
    expect(capsOnly.statusCode).toBe(200);
    expect(capsOnly.json().placementConstraints.capabilities).toEqual(["android-emulator"]);
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { placementConstraints: { platform: [], allowBurst: false, capabilities: ["gpu"] } },
    });
    expect(bad.statusCode).toBe(400);

    // null (and default-valued flags) clear them: no flags, the column's default.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/projects/${id}`,
      payload: { placementConstraints: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().placementConstraints).toEqual({
      platform: [],
      allowBurst: false,
      capabilities: [],
    });

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects placementConstraints with an unknown or repeated platform, or a non-boolean allowBurst", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-constraints-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "steer-bad", cwd },
    });
    const { id } = created.json();
    for (const bad of [
      { platform: ["freebsd"] },
      { platform: ["darwin", "darwin"] },
      { platform: [], allowBurst: "yes" },
      { platform: ["darwin"] },
    ]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { placementConstraints: bad },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects a hostCwds path that is not absolute", async () => {
    // The paths become a session's working directory on THAT host, so a
    // relative one would resolve against whatever the agent's cwd
    // happened to be.
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-hostcwds-"));
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "relative-map",
        cwd,
        hostCwds: { "remote-a": "relative/path" },
      },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects a hostCwds key that names no known host", async () => {
    // A typo in a host id would sit in the map forever — the host it
    // names would never become a placement candidate, so the map would
    // look like it had done nothing.
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-hostcwds-"));
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "typo-map",
        cwd,
        hostCwds: { "remtoe-a": "/srv/repo" },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toMatch(/unknown host/i);
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects a hostCwds key that names a host still waiting for its agent", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-hostcwds-"));
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "pending-box" },
    });
    expect(host.statusCode).toBe(201);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "pending-map",
        cwd,
        hostCwds: { [host.json().id]: "/srv/repo" },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toMatch(/hasn't registered yet/i);
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects a hostCwds value that is not a path", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-hostcwds-"));
    // An object cannot be coerced into a path (Fastify coerces a NUMBER to
    // a string, so the value has to be a shape no coercion can rescue).
    const rejected = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        createDir: true,
        name: "bad-map",
        cwd,
        hostCwds: { "remote-a": { nested: "not a path" } },
      },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects an unknown placement mode", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-placement-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        createDir: true,
        allowDuplicate: true,
        name: "bad-placement",
        cwd,
        placement: "whatever",
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // Issue #1726 / roadmap 8.12 — the placement PREVIEW: "where would a new
  // session land right now, and why?" It is the same decision the spawn
  // path makes, so the answer cannot drift from what would happen.
  it("previews the placement of an existing project", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-preview-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        createDir: true,
        allowDuplicate: true,
        name: "preview-project",
        cwd,
        placement: "auto",
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview`,
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.placement).toBe("auto");
    expect(typeof body.hostId).toBe("string");
    expect(body.reason.length).toBeGreaterThan(0);
    // The comparison table rides along, so a UI can show WHY rather than
    // just the winner.
    expect(Array.isArray(body.considered)).toBe(true);
    expect(body.fellBack).toBe(false);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("excludes a host without the CLI of the previewed launch command (#2240)", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-preview-cli-"));
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "no-claude", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = host.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform: "linux",
      logicalCores: 8,
      loadAverage1m: 0,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    app.hostAgentTracker?.record(hostId, {
      capabilities: null,
      agents: ["codex"],
      mullionVersion: null,
    });
    // The primary's own list is read on demand (a real login-shell probe).
    app.hostAgentTracker?.record("local", {
      capabilities: null,
      agents: ["claude"],
      mullionVersion: null,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "preview-cli",
        cwd,
        placement: "auto",
        hostCwds: { [hostId]: "/srv/x" },
      },
    });
    const { id } = created.json();

    const withCommand = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview?command=${encodeURIComponent("claude --model opus")}`,
    });
    expect(withCommand.json().excluded).toContainEqual({
      hostId,
      reason: "no claude CLI on this host",
    });
    const withShell = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview?command=bash`,
    });
    expect(withShell.json().excluded.map((e: { hostId: string }) => e.hostId)).not.toContain(
      hostId,
    );

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("previews a PINNED project as pinned, without scoring anything", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-preview-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "pinned-preview", cwd },
    });
    const { id } = created.json();

    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().placement).toBe("pinned");
    expect(preview.json().hostId).toBe("local");
    expect(preview.json().considered).toEqual([]);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("answers about the mode ASKED about, not the one the project is stored as", async () => {
    // The question a UI asks is "what would happen if this project were
    // AUTO?" — which is usually NOT the stored mode (turning the mode on is
    // the point of the control). Without the override the answer would be
    // about the stored mode: the opposite of what the user is asking.
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-preview-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "mode-override", cwd },
    });
    const { id } = created.json();

    const stored = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview`,
    });
    expect(stored.json().placement).toBe("pinned");

    const asked = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview?placement=auto`,
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().placement).toBe("auto");
    // The auto answer is a SCORED one — the considered table is populated,
    // where the pinned answer scores nothing.
    expect(Array.isArray(asked.json().considered)).toBe(true);
    expect(asked.json().considered.length).toBeGreaterThan(0);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects a GET preview for a mode outside the shared vocabulary", async () => {
    const app = await buildApp();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-preview-"));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "bad-mode-preview", cwd },
    });
    const { id } = created.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${id}/placement-preview?placement=whatever`,
    });
    expect(res.statusCode).toBe(400);

    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("404s a preview for a project that does not exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/projects/999999/placement-preview" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("previews a project that does not exist YET (the create modal's question)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/placement-preview",
      payload: { hostId: "local", placement: "auto" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().placement).toBe("auto");
    expect(typeof res.json().hostId).toBe("string");
    await app.close();
  });

  it("404s a preview for a host that is not registered", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/placement-preview",
      payload: { hostId: "no-such-host", placement: "auto" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a POST preview for a mode outside the shared vocabulary", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/placement-preview",
      payload: { hostId: "local", placement: "whatever" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("lists projects in case-insensitive alphabetical order", async () => {
    const app = await buildApp();

    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "zeta", cwd: "/tmp/z" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "Alpha", cwd: "/tmp/a" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "beta", cwd: "/tmp/b" },
    });
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, allowDuplicate: true, name: "Gamma", cwd: "/tmp/g" },
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
      payload: { allowDuplicate: true, name: "tilde", cwd: "~/definitely-not-here/my-project" },
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
      payload: { allowDuplicate: true, name: "mkdir-test", cwd },
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
      payload: { allowDuplicate: true, name: "mkdir-test", cwd, createDir: true },
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
      payload: { allowDuplicate: true, name: "mkdir-fail", cwd },
    });
    expect(withoutFlag.statusCode).toBe(400);
    expect(withoutFlag.json().code).toBe("PROJECT_PATH_NOT_A_DIRECTORY");

    const withFlag = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "mkdir-fail", cwd, createDir: true },
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
      payload: { allowDuplicate: true, name: "leaf-only", cwd, createDir: true },
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
      payload: { allowDuplicate: true, name: "mkdir-existing", cwd, createDir: true },
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
      payload: { allowDuplicate: true, name: "dangling", cwd, createDir: true },
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
      payload: {
        allowDuplicate: true,
        name: "remote-createdir",
        cwd: "/remote/path",
        hostId,
        createDir: true,
      },
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
      payload: {
        allowDuplicate: true,
        name: "git-init-fresh",
        cwd,
        createDir: true,
        gitInit: true,
      },
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
      payload: {
        allowDuplicate: true,
        name: "git-init-existing",
        cwd,
        createDir: true,
        gitInit: true,
      },
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
      payload: {
        allowDuplicate: true,
        name: "git-init-fails",
        cwd,
        createDir: true,
        gitInit: true,
      },
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
      payload: { allowDuplicate: true, name: "git-init-no-createdir", cwd, gitInit: true },
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
      payload: { allowDuplicate: true, name: "no-cwd" },
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
      payload: { createDir: true, allowDuplicate: true, name: "throwaway", cwd: "/tmp" },
    });
    const { id } = created.json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${id}` });
    expect(deleted.statusCode).toBe(204);

    await app.close();
  });

  describe("GET /api/projects/:id (issue #2148)", () => {
    it("returns exactly the row GET /api/projects has for that project", async () => {
      const app = await buildApp();
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            createDir: true,
            allowDuplicate: true,
            name: "single-read",
            cwd: "/tmp/single-read",
          },
        });
        const { id } = created.json();

        const single = await app.inject({ method: "GET", url: `/api/projects/${id}` });
        expect(single.statusCode).toBe(200);
        const list = await app.inject({ method: "GET", url: "/api/projects" });
        const row = (list.json() as Array<{ id: number }>).find((p) => p.id === id);
        expect(single.body).toBe(JSON.stringify(row));
        expect(single.json().hostCwds).toEqual({});
        expect(single.json().hostCwdsMeta).toBeTypeOf("object");
      } finally {
        await app.close();
      }
    });

    it("serialises a remote-hosted project like its list row, degrading an unreachable host", async () => {
      const app = await buildApp();
      try {
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "single-read-host", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const created = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "single-read-remote",
            cwd: "/x",
            hostId: host.json().id,
          },
        });
        const { id } = created.json();

        const single = await app.inject({ method: "GET", url: `/api/projects/${id}` });
        expect(single.statusCode).toBe(200);
        expect(single.json()).toMatchObject({
          id,
          currentBranch: null,
          ruleFiles: [],
          detectedDevServerPort: null,
        });
        const list = await app.inject({ method: "GET", url: "/api/projects" });
        const row = (list.json() as Array<{ id: number }>).find((p) => p.id === id);
        expect(single.body).toBe(JSON.stringify(row));
      } finally {
        await app.close();
      }
    });

    it("404s for an unknown id", async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({ method: "GET", url: "/api/projects/987654" });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it("400s for a malformed id", async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({ method: "GET", url: "/api/projects/abc" });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });
  });

  describe("PATCH /api/projects/:id", () => {
    it("updates name and cwd", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "before", cwd: "/tmp/before" },
      });
      const { id } = created.json();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { createDir: true, allowDuplicate: true, name: "after", cwd: "/tmp/after" },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "tilde-edit",
          cwd: "/tmp/tilde-edit",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "mkdir-update",
          cwd: "/tmp/mkdir-update-init",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "mkdir-fail-update",
          cwd: "/tmp/mkdir-fail-update-init",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "flag-without-cwd",
          cwd: "/tmp/flag-without-cwd",
        },
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
        payload: { allowDuplicate: true, name: "rename-me", cwd },
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
        payload: { allowDuplicate: true, name: "flags-only", cwd },
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
        payload: { allowDuplicate: true, name: "git-init-no-createdir", cwd },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "partial-before",
          cwd: "/tmp/partial",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "dev-server",
          cwd: "/tmp/dev-server",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "agent-defaults",
          cwd: "/tmp/agent-defaults",
        },
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

    it("400s on hermes as defaultReviewAgent while it isn't set up, accepts it once it is (#2369)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "hermes-reviewer",
          cwd: "/tmp/hermes-reviewer",
        },
      });
      const { id } = created.json();

      const refused = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { defaultReviewAgent: "hermes" },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toContain("Review relay");

      applySettingsPatch(app, {
        reviewRelay: { apiUrl: "http://hermes.test:8643", taskMasterReviewer: true },
      });
      setHermesKey(app, "test-key"); // pragma: allowlist secret
      try {
        const accepted = await app.inject({
          method: "PATCH",
          url: `/api/projects/${id}`,
          payload: { defaultReviewAgent: "hermes" },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toMatchObject({ defaultReviewAgent: "hermes" });
      } finally {
        clearHermesKey(app);
        applySettingsPatch(app, { reviewRelay: { apiUrl: "", taskMasterReviewer: false } });
      }

      // Clearing it, or moving to a CLI, never needs Hermes.
      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { defaultReviewAgent: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().defaultReviewAgent).toBeNull();

      await app.close();
    });

    it("sets, then clears, mergeOnApprove/autoApprove", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "merge-settings",
          cwd: "/tmp/merge-settings",
        },
      });
      const { id } = created.json();
      expect(created.json().mergeOnApprove).toBeNull();
      expect(created.json().autoApprove).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { mergeOnApprove: true, autoApprove: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ mergeOnApprove: true, autoApprove: true });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { mergeOnApprove: false, autoApprove: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().mergeOnApprove).toBe(false);
      expect(cleared.json().autoApprove).toBeNull();

      await app.close();
    });

    // Issue #2110 — the coordinator flag: per-project, default off, settable
    // and clearable through PATCH, and valid as the ONLY field in a PATCH.
    it("sets, then clears, allowCrossProjectSpawn — off by default (#2110)", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "coordinator-flag",
          cwd: "/tmp/coordinator-flag",
        },
      });
      const { id } = created.json();
      expect(created.json().allowCrossProjectSpawn).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { allowCrossProjectSpawn: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().allowCrossProjectSpawn).toBe(true);

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { allowCrossProjectSpawn: false },
      });
      expect(cleared.json().allowCrossProjectSpawn).toBe(false);

      const bad = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { allowCrossProjectSpawn: "yes" },
      });
      expect(bad.statusCode).toBe(400);

      await app.close();
    });

    // Regression guard for the "nothing maps to a column" 400 check
    // (routes/projects.ts) — a PATCH carrying ONLY one of these two new
    // fields must not fall through to `.update(projects).set({})`, which
    // drizzle-orm throws on ("No values to set", a 500 not a 400).
    it("accepts a PATCH carrying only mergeOnApprove", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "merge-only-field",
          cwd: "/tmp/merge-only-field",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { mergeOnApprove: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mergeOnApprove).toBe(true);

      await app.close();
    });

    // #756
    it("sets, then clears, maxAutoReturnRounds", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "round-cap-p",
          cwd: "/tmp/round-cap-p",
        },
      });
      const { id } = created.json();
      expect(created.json().maxAutoReturnRounds).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { maxAutoReturnRounds: 5 },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().maxAutoReturnRounds).toBe(5);

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { maxAutoReturnRounds: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().maxAutoReturnRounds).toBeNull();

      await app.close();
    });

    it("accepts 0 as unlimited, and rejects a negative maxAutoReturnRounds", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "round-cap-invalid-p",
          cwd: "/tmp/round-cap-invalid-p",
        },
      });
      const { id } = created.json();

      const unlimited = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { maxAutoReturnRounds: 0 },
      });
      expect(unlimited.statusCode).toBe(200);
      expect(unlimited.json().maxAutoReturnRounds).toBe(0);

      const negative = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { maxAutoReturnRounds: -1 },
      });
      expect(negative.statusCode).toBe(400);

      await app.close();
    });

    // Regression guard for the "nothing maps to a column" 400 check, same
    // reasoning as the mergeOnApprove-only test above.
    it("accepts a PATCH carrying only maxAutoReturnRounds", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "round-cap-only-field",
          cwd: "/tmp/round-cap-only-field",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { maxAutoReturnRounds: 3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().maxAutoReturnRounds).toBe(3);

      await app.close();
    });

    it("sets, then clears, conventionalCommitTitles", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "cc-titles-p",
          cwd: "/tmp/cc-titles-p",
        },
      });
      const { id } = created.json();
      expect(created.json().conventionalCommitTitles).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { conventionalCommitTitles: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().conventionalCommitTitles).toBe(true);

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { conventionalCommitTitles: false },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().conventionalCommitTitles).toBe(false);

      await app.close();
    });

    // Regression guard for the "nothing maps to a column" 400 check, same
    // reasoning as the mergeOnApprove-only test above.
    it("accepts a PATCH carrying only conventionalCommitTitles", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "cc-titles-only-field",
          cwd: "/tmp/cc-titles-only-field",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { conventionalCommitTitles: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().conventionalCommitTitles).toBe(true);

      await app.close();
    });

    it("updates autoTagRelease (true/false) on a project", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "auto-tag-release-p",
          cwd: "/tmp/auto-tag-release-p",
        },
      });
      const { id } = created.json();
      expect(created.json().autoTagRelease).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { autoTagRelease: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json().autoTagRelease).toBe(true);

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { autoTagRelease: false },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().autoTagRelease).toBe(false);

      await app.close();
    });

    it("accepts a PATCH carrying only autoTagRelease", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "auto-tag-release-only-field",
          cwd: "/tmp/auto-tag-release-only-field",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { autoTagRelease: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoTagRelease).toBe(true);

      await app.close();
    });

    // Issue #884 — same nullable-override contract as autoFetch/autoTagRelease
    // above: null = inherit the global setting, true/false = explicit
    // per-project override.
    it("sets, then clears, injectAgentGuide/injectProjectBriefing", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "inject-overrides-p",
          cwd: "/tmp/inject-overrides-p",
        },
      });
      const { id } = created.json();
      expect(created.json().injectAgentGuide).toBeNull();
      expect(created.json().injectProjectBriefing).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectAgentGuide: false, injectProjectBriefing: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ injectAgentGuide: false, injectProjectBriefing: true });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectAgentGuide: null, injectProjectBriefing: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().injectAgentGuide).toBeNull();
      expect(cleared.json().injectProjectBriefing).toBeNull();

      await app.close();
    });

    it("accepts a PATCH carrying only injectAgentGuide", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "inject-agent-guide-only-field",
          cwd: "/tmp/inject-agent-guide-only-field",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectAgentGuide: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().injectAgentGuide).toBe(false);

      await app.close();
    });

    // Issue #937 — same nullable-override contract as injectAgentGuide/
    // injectProjectBriefing above: null = inherit `true` (inject), true/
    // false = explicit per-project override.
    it("sets, then clears, injectWorkflowConventions", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "inject-workflow-conventions-p",
          cwd: "/tmp/inject-workflow-conventions-p",
        },
      });
      const { id } = created.json();
      expect(created.json().injectWorkflowConventions).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectWorkflowConventions: false },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ injectWorkflowConventions: false });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectWorkflowConventions: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().injectWorkflowConventions).toBeNull();

      await app.close();
    });

    // TASK_ROW_COLUMNS-style regression guard: PATCH's own `.returning()`
    // proves the column round-trips through drizzle, but the frontend reads
    // the toggle's current value off GET /api/projects (the list, not a
    // per-project GET) — a column silently missing from THAT projection
    // would leave the UI toggle looking dead while the DB write succeeded.
    it("GET /api/projects includes injectWorkflowConventions in the list response", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "inject-workflow-conventions-list",
          cwd: "/tmp/inject-workflow-conventions-list",
        },
      });
      const { id } = created.json();
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { injectWorkflowConventions: true },
      });

      const list = await app.inject({ method: "GET", url: "/api/projects" });
      expect(list.statusCode).toBe(200);
      const project = (
        list.json() as Array<{ id: number; injectWorkflowConventions?: boolean }>
      ).find((p) => p.id === id);
      expect(project?.injectWorkflowConventions).toBe(true);

      await app.close();
    });

    // Issue #1208 — a SECOND, independent opt-out from injectWorkflowConventions
    // above; same nullable-boolean contract (null/false = inject, true =
    // suppress), but it must never affect what injectWorkflowConventions
    // itself resolves to or reports.
    it("sets, then clears, suppressConventionsInjectionAfterScaffold", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "suppress-conventions-injection-p",
          cwd: "/tmp/suppress-conventions-injection-p",
        },
      });
      const { id } = created.json();
      expect(created.json().suppressConventionsInjectionAfterScaffold).toBeNull();

      const set = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { suppressConventionsInjectionAfterScaffold: true },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ suppressConventionsInjectionAfterScaffold: true });

      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { suppressConventionsInjectionAfterScaffold: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().suppressConventionsInjectionAfterScaffold).toBeNull();

      await app.close();
    });

    // TASK_ROW_COLUMNS-style regression guard, same rationale as
    // injectWorkflowConventions's own list-projection test above.
    it("GET /api/projects includes suppressConventionsInjectionAfterScaffold in the list response", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "suppress-conventions-injection-list",
          cwd: "/tmp/suppress-conventions-injection-list",
        },
      });
      const { id } = created.json();
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { suppressConventionsInjectionAfterScaffold: true },
      });

      const list = await app.inject({ method: "GET", url: "/api/projects" });
      expect(list.statusCode).toBe(200);
      const project = (
        list.json() as Array<{
          id: number;
          suppressConventionsInjectionAfterScaffold?: boolean;
        }>
      ).find((p) => p.id === id);
      expect(project?.suppressConventionsInjectionAfterScaffold).toBe(true);

      await app.close();
    });

    it("accepts a PATCH carrying only autoApprove", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          createDir: true,
          name: "auto-approve-only-field",
          cwd: "/tmp/auto-approve-only",
        },
      });
      const { id } = created.json();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { autoApprove: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoApprove).toBe(true);

      await app.close();
    });

    it("rejects an unrecognized defaultAgent name", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "bad-agent-default",
          cwd: "/tmp/bad-agent-default",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "bad-dev-server",
          cwd: "/tmp/bad-dev-server",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "empty-body",
          cwd: "/tmp/empty-body",
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "git-repo",
          cwd: path.join(root, "git-repo"),
        },
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
    // Issue #525's cascade recurred here (a different trigger: a 5s
    // testTimeout hit on a loaded CI runner, not an unguarded throw) — a
    // test that never reaches its own `await app.close()` used to leak a
    // live hooks.sock listener that every *later* buildApp() in the whole
    // file failed against with a misleading SocketAlreadyListeningError.
    // Same containment as the "webhook registration" describe block below:
    // this block's own SESSIONS_DIR plus an afterEach that closes every
    // tracked app unconditionally, confining any future leak to this block.
    let previousSessionsDir: string | undefined;
    const sessionsDir = uniqueSessionsDir();

    beforeAll(() => {
      previousSessionsDir = process.env.SESSIONS_DIR;
      process.env.SESSIONS_DIR = sessionsDir;
    });

    afterAll(() => {
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

    afterEach(async () => {
      const toClose = apps;
      apps = [];
      const hookSocketPath = toClose[0]?.pty.hookSocketPath;
      const results = await Promise.allSettled(toClose.map((app) => app.close()));
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          `[afterEach teardown] ${failures.length}/${toClose.length} app.close() call(s) failed: ` +
            failures.map((f) => String(f.reason)).join("; "),
        );
      }
      if (hookSocketPath) {
        expect(
          fs.existsSync(hookSocketPath),
          `hooks.sock still exists after closing all apps built by this test: ${hookSocketPath}`,
        ).toBe(false);
      }
    });

    it("404s for an unknown project", async () => {
      const app = await makeApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/dock" });
      expect(res.statusCode).toBe(404);
    });

    it("returns [] for a project with no .crs/dock.json", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-empty-"));
      const app = await makeApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "no-dock", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/dock`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);

      fs.rmSync(projectCwd, { recursive: true, force: true });
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

      const app = await makeApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "with-dock", cwd: projectCwd },
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
    });
  });

  // The git-log and remote-host git routes that used to sit inside the
  // "GET /api/projects/:id/github (issue #27)" describe. They exercise
  // /api/projects/:id/git-log and /api/projects/:id/git-commit — routes whose
  // source stayed in projects.ts — so they stay in this file too, but they
  // are not GitHub-route tests and their old path said they were.
  describe("git log and remote-host git routes", () => {
    // Same containment as the "dock" describe block above: this block's own
    // SESSIONS_DIR plus an afterEach that closes every tracked app
    // unconditionally, confining any leak to this block instead of poisoning
    // the rest of the file's buildApp() calls.
    let previousSessionsDir: string | undefined;
    const sessionsDir = uniqueSessionsDir();

    beforeAll(() => {
      previousSessionsDir = process.env.SESSIONS_DIR;
      process.env.SESSIONS_DIR = sessionsDir;
    });

    afterAll(() => {
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

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      const toClose = apps;
      apps = [];
      const hookSocketPath = toClose[0]?.pty.hookSocketPath;
      const results = await Promise.allSettled(toClose.map((app) => app.close()));
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new Error(
          `[afterEach teardown] ${failures.length}/${toClose.length} app.close() call(s) failed: ` +
            failures.map((f) => String(f.reason)).join("; "),
        );
      }
      if (hookSocketPath) {
        expect(
          fs.existsSync(hookSocketPath),
          `hooks.sock still exists after closing all apps built by this test: ${hookSocketPath}`,
        ).toBe(false);
      }

      // github-integration's `integrations` row is a singleton shared
      // across this whole test file's DB — reset it after every test in
      // this block so a connected token doesn't leak into an unrelated
      // "no token" case (same reasoning as github-integration.test.ts).
      const app = await buildApp();
      const { disconnect } = await import("../../src/services/github-integration.js");
      disconnect(app);
      await app.close();
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

      async function repoProject(app: Awaited<ReturnType<typeof buildApp>>) {
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
        const app = await makeApp();
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
        const app = await makeApp();
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
        const app = await makeApp();
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
        run: (ctx: {
          app: Awaited<ReturnType<typeof makeApp>>;
          id: number;
          seen: string[];
        }) => Promise<void>,
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
        const app = await makeApp();
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
        const app = await makeApp();
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

  describe("GET /api/projects/git-statuses (batch, issue #166)", () => {
    it("returns empty projects/sessions maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
      await app.close();
    });

    it("returns empty projects/sessions maps for an empty ids string", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-statuses?ids=" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-real-repo",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-not-a-repo",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-transiently-broken",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Project is omitted from `projects` because git status failed, but the
      // failure is reported (issue #1602).
      const body = res.json();
      expect(body.projects).toEqual({});
      expect(body.problems[String(projectId)]).toMatchObject({ reason: "failed" });

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("reports a checkout flipped to core.bare = true as a bare-repo problem (issue #1602)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-status-bare-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "core.bare", "true"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-bare-flag",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      const body = res.json();
      expect(body.projects[String(projectId)]).toBeUndefined();
      expect(body.problems[String(projectId)].reason).toBe("bare-repo");
      expect(body.problems[String(projectId)].message).toContain("git config core.bare false");

      const single = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/git-status`,
      });
      expect(single.statusCode).toBe(503);
      expect(single.json().message).toContain("core.bare");

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
        payload: { allowDuplicate: true, name: "batch-remote", cwd: "/x", hostId: host.json().id },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      // Remote host unreachable — project omitted from response.
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });

      await app.close();
    });

    describe("remote host git status problems (issue #1612)", () => {
      async function remoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "problem-host", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: {
            allowDuplicate: true,
            name: "remote-problem",
            cwd: "/x",
            hostId: host.json().id,
          },
        });
        return project.json().id as number;
      }
      const stubAgent = (body: unknown) =>
        vi.stubGlobal(
          "fetch",
          vi.fn().mockImplementation(
            async () =>
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        );
      const problem = { reason: "bare-repo", message: "core.bare = true on the agent" };

      afterEach(() => vi.unstubAllGlobals());

      it("reports the agent's problem in the batch and the per-project 503", async () => {
        const app = await buildApp();
        const projectId = await remoteProject(app);
        stubAgent({ isRepo: true, status: null, problem });

        const batch = await app.inject({
          method: "GET",
          url: `/api/projects/git-statuses?ids=${projectId}`,
        });
        expect(batch.json()).toEqual({
          projects: {},
          sessions: {},
          problems: { [String(projectId)]: problem },
        });

        const single = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/git-status`,
        });
        expect(single.statusCode).toBe(503);
        expect(single.json().message).toBe(problem.message);
        await app.close();
      });

      it("falls back to the generic text when an older agent sends no problem", async () => {
        const app = await buildApp();
        const projectId = await remoteProject(app);
        stubAgent({ isRepo: true, status: null });

        const batch = await app.inject({
          method: "GET",
          url: `/api/projects/git-statuses?ids=${projectId}`,
        });
        expect(batch.json().problems).toEqual({});

        const single = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/git-status`,
        });
        expect(single.statusCode).toBe(503);
        expect(single.json().message).toBe("git status is temporarily unavailable");
        await app.close();
      });
    });

    it("handles a mix of repo, non-repo, and transient-failure projects", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-mix-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
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
        payload: { createDir: true, allowDuplicate: true, name: "batch-mix-repo", cwd: repoDir },
      });
      const nonRepo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-mix-nonrepo",
          cwd: nonRepoDir,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-project",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-livecwd-project",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-badlive-project",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-nonrepo",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-session-foreign-project",
          cwd: projectCwd,
        },
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
      expect(res.json()).toEqual({ projects: {}, sessions: {}, problems: {} });
      await app.close();
    });
  });

  describe("GET /api/projects/git-refs (batch, issue #1007)", () => {
    it("returns empty branches/prs maps when no ids are given", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/git-refs" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ branches: {}, prs: {}, defaultBranchCi: {} });
      await app.close();
    });

    it("returns branches and the warm-cache PR status for a connected local repo", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-real-"));
      execFileSync("git", ["init", "-b", "main"], {
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
      execFileSync("git", ["remote", "add", "origin", "git@github.com:batch-refs/repo.git"], {
        cwd: projectCwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-real",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      // Primed as the poller (github-pr-poller.ts) would — the batch
      // route's PR half is a pure cache read, no token needed.
      const { setRepoPRsStatus } = await import("../../src/services/github.js");
      setRepoPRsStatus("batch-refs", "repo", {
        prs: [
          {
            number: 3,
            title: "Batch it",
            htmlUrl: "https://github.com/batch-refs/repo/pull/3",
            author: "dev",
            ...PR_REVIEW_DEFAULTS,
            headSha: "abc",
            headBranch: "feature",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(projectId)]).toMatchObject({
        branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
      });
      expect(body.prs[String(projectId)].prs).toHaveLength(1);
      expect(body.prs[String(projectId)].prs[0].number).toBe(3);

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("carries the poller's default-branch CI even when the repo has no open PRs", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-ci-"));
      for (const args of [
        ["init", "-b", "main"],
        ["remote", "add", "origin", "git@github.com:batch-ci/repo.git"],
      ]) {
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      }
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-ci",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;
      const { setRepoPRsStatus, setDefaultBranchCi } = await import("../../src/services/github.js");

      // Cold cache: the id is omitted so the client keeps its last-known-good.
      let res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(String(projectId) in res.json().defaultBranchCi).toBe(false);

      // Zero open PRs collapses `prs` to null — the CI map must not.
      setRepoPRsStatus("batch-ci", "repo", {
        prs: [],
        prSummary: { total: 0, pass: 0, fail: 0, pending: 0, unknown: 0 },
      });
      setDefaultBranchCi("batch-ci", "repo", "failure");
      res = await app.inject({ method: "GET", url: `/api/projects/git-refs?ids=${projectId}` });
      const body = res.json();
      expect(body.prs[String(projectId)]).toBeNull();
      expect(body.defaultBranchCi[String(projectId)]).toBe("failure");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns null branches and null prs for a local project that isn't a git repo", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-none-"));
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-none",
          cwd: projectCwd,
        },
      });
      const projectId = created.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(projectId)]).toBeNull();
      expect(body.prs[String(projectId)]).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    // Hermes review, PR #1017 — the PRs half used to collapse "host
    // unreachable" and "no GitHub remote configured" into the same `null`
    // (resolveRepoRef's own null-collapse), so a transient outage cleared
    // the frontend's last-known-good open-PR list for that project exactly
    // like a durable "no PRs" would. Fixed to use resolveRepoRefResult
    // directly and omit (not null) on "unreachable" — this test locks that
    // in for both halves of the batch, matching git-statuses' own
    // omit-on-unreachable precedent above.
    it("omits BOTH branches and prs (not null) for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-refs-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "batch-refs-remote",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const projectId = project.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ branches: {}, prs: {}, defaultBranchCi: {} });

      await app.close();
    });

    it("handles a mix of a connected repo and an unreachable remote-host project independently", async () => {
      const { execFileSync } = await import("node:child_process");
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-git-refs-mix-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      fs.writeFileSync(path.join(repoDir, "a.txt"), "a");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe", env: gitEnv() });
      execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
        cwd: repoDir,
        stdio: "pipe",
        env: gitEnv(),
      });

      const app = await buildApp();
      const repo = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "batch-git-refs-mix-repo",
          cwd: repoDir,
        },
      });
      const repoId = repo.json().id as number;

      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "batch-refs-mix-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const remote = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "batch-git-refs-mix-remote",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const remoteId = remote.json().id as number;

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-refs?ids=${repoId},${remoteId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.branches[String(repoId)]).toMatchObject({
        branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
      });
      expect(body.prs[String(repoId)]).toBeNull();
      expect(body.branches[String(remoteId)]).toBeUndefined();
      expect(body.prs[String(remoteId)]).toBeUndefined();

      fs.rmSync(repoDir, { recursive: true, force: true });
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
        payload: { createDir: true, allowDuplicate: true, name: "not-a-repo", cwd: projectCwd },
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
        payload: { createDir: true, allowDuplicate: true, name: "real-repo", cwd: projectCwd },
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
    // Source Control both call this route right after a manual "Fetch" to show
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "fresh-status-repo",
          cwd: projectCwd,
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-git-status",
          cwd: "/x",
          hostId: host.json().id,
        },
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
    // Source Control flicker: a client that treats 503 as "keep my last-known-good"
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "transiently-broken-repo",
          cwd: projectCwd,
        },
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
        payload: { createDir: true, allowDuplicate: true, name: "not-a-repo", cwd: projectCwd },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "real-repo-branches",
          cwd: projectCwd,
        },
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
      // Issue #271 follow-up — no remote configured, so there's nothing to
      // resolve a default branch from; `null`, never the literal "HEAD".
      expect(body.defaultBranch).toBeNull();

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("resolves defaultBranch from origin/HEAD for the promote/launcher base-ref pickers (issue #271 follow-up)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-default-"));
      const remoteDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "projects-git-branches-default-origin-"),
      );
      const run = (cwd: string, args: string[]) =>
        execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });

      run(remoteDir, ["init", "--bare", "-b", "main"]);
      run(projectCwd, ["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(projectCwd, ["add", "-A"]);
      run(projectCwd, ["commit", "-m", "initial", "--no-verify"]);
      run(projectCwd, ["remote", "add", "origin", remoteDir]);
      run(projectCwd, ["push", "origin", "main"]);
      run(projectCwd, ["remote", "set-head", "origin", "main"]);

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "default-branch-repo",
          cwd: projectCwd,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${created.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().defaultBranch).toBe("origin/main");

      fs.rmSync(projectCwd, { recursive: true, force: true });
      fs.rmSync(remoteDir, { recursive: true, force: true });
      await app.close();
    });

    it("resolves isMerged only when ?detail=1 is set (issue #442)", async () => {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-branches-detail-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "detail-repo-branches",
          cwd: projectCwd,
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-git-branches",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${project.json().id}/git-branches`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  // Issue #1851 — the READ-ONLY clone health check. It never mutates
  // anything: a damaged clone is reported, not repaired.
  // Issue #1896 — the clone REPAIR. Two phases in one endpoint: without
  // `confirm` it returns the PLAN (a read), with `confirm: true` it runs the
  // repair and reports what it did.
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
        payload: { createDir: true, allowDuplicate: true, name: "fetch-repo", cwd: projectCwd },
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
        payload: {
          allowDuplicate: true,
          name: "remote-git-fetch",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-fetch`,
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });
  });

  describe("POST /api/projects/:id/git-pull (issue #745)", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/projects/999999/git-pull" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("runs git pull for a real local repo and returns a GitPullResult", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-git-pull-"));
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
        payload: { createDir: true, allowDuplicate: true, name: "pull-repo", cwd: projectCwd },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${created.json().id}/git-pull`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({ pulled: expect.any(Boolean) as boolean }),
      );

      fs.rmSync(projectCwd, { recursive: true, force: true });
      await app.close();
    });

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "git-pull-remote-host", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-git-pull",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-pull`,
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
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature-x"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "branch-delete-repo",
          cwd: projectCwd,
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-branch-delete",
          cwd: "/x",
          hostId: host.json().id,
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-branch-delete-success",
          cwd: remoteCwd,
          hostId: host.json().id,
        },
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

  describe("A3 — branch detail, squash-aware merge state and local prune", () => {
    const sh = (cwd: string, ...args: string[]) =>
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
    const realResolve = vi.mocked(resolveGitHubToken).getMockImplementation()!;
    const pr = (number: number, headRef: string, headSha: string, mergedAt: string | null) => ({
      number,
      htmlUrl: `https://github.com/o/r/pull/${number}`,
      headRef,
      headSha,
      headRepo: "o/r",
      baseRef: "main",
      mergedAt,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const commitFile = (dir: string, file: string, message: string) => {
      fs.writeFileSync(path.join(dir, file), file);
      sh(dir, "add", ".");
      sh(dir, "commit", "-q", "-m", message);
    };

    async function setup() {
      const app = await buildApp();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-prune-"));
      sh(dir, "init", "-q", "-b", "main");
      commitFile(dir, "a.txt", "initial");
      sh(dir, "remote", "add", "origin", "https://github.com/o/r.git");
      sh(dir, "update-ref", "refs/remotes/origin/main", "main");
      sh(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      sh(dir, "branch", "anc");
      sh(dir, "branch", "claimed");
      sh(dir, "branch", "inwt");
      const wt = `${dir}-wt`;
      sh(dir, "worktree", "add", wt, "inwt");
      // upstream deleted on the remote: tracking config, no remote ref
      sh(dir, "checkout", "-q", "-b", "gone");
      commitFile(dir, "g.txt", "gone work");
      sh(dir, "config", "branch.gone.remote", "origin");
      sh(dir, "config", "branch.gone.merge", "refs/heads/gone");
      // its commit still lives on some other remote ref, so nothing is lost
      sh(dir, "update-ref", "refs/remotes/origin/elsewhere", "gone");
      // upstream gone AND a commit no remote has: must never be a candidate
      sh(dir, "checkout", "-q", "-b", "gone-unpushed", "main");
      commitFile(dir, "u.txt", "unpushed work");
      sh(dir, "config", "branch.gone-unpushed.remote", "origin");
      sh(dir, "config", "branch.gone-unpushed.merge", "refs/heads/gone-unpushed");
      // squash-merged on GitHub: unique commit, PR head sha == tip
      sh(dir, "checkout", "-q", "-b", "squashed", "main");
      commitFile(dir, "s.txt", "squashed work");
      const squashedSha = sh(dir, "rev-parse", "HEAD");
      // name reused after a merge: PR head sha differs from the tip
      sh(dir, "checkout", "-q", "-b", "reused", "main");
      commitFile(dir, "r.txt", "reused work");
      // closed unmerged
      sh(dir, "checkout", "-q", "-b", "abandoned", "main");
      commitFile(dir, "x.txt", "abandoned work");
      const abandonedSha = sh(dir, "rev-parse", "HEAD");
      sh(dir, "checkout", "-q", "main");

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, allowDuplicate: true, name: "prune", cwd: dir },
      });
      const id = created.json().id as number;
      const { tasks } = await import("../../src/db/schema.js");
      app.db
        .insert(tasks)
        .values({ projectId: id, title: "t", status: "in_progress", branchName: "claimed" })
        .run();

      vi.mocked(resolveGitHubToken).mockResolvedValue("tok");
      const githubWrite = await import("../../src/services/github-write.js");
      const { clearMergedPrsCacheForTests } =
        await import("../../src/services/github-merged-prs.js");
      clearMergedPrsCacheForTests();
      const list = vi
        .spyOn(githubWrite, "listClosedPullRequests")
        .mockResolvedValue([
          pr(11, "squashed", squashedSha, "2026-01-01T00:00:00Z"),
          pr(12, "reused", "f".repeat(40), "2026-01-01T00:00:00Z"),
          pr(13, "abandoned", abandonedSha, null),
          { ...pr(14, "anc", "e".repeat(40), "2026-01-01T00:00:00Z"), headRepo: "fork/r" },
        ]);
      const cleanup = async () => {
        list.mockRestore();
        vi.mocked(resolveGitHubToken).mockImplementation(realResolve);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(wt, { recursive: true, force: true });
        await app.close();
      };
      return { app, dir, id, wt, list, cleanup };
    }

    it("lists mergeState and pr per branch with one GitHub listing, not one per branch", async () => {
      const { app, id, list, cleanup } = await setup();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-branches?detail=1`,
      });
      const byName = Object.fromEntries(
        (res.json().branches as Array<Record<string, unknown>>).map((b) => [b.name as string, b]),
      );
      expect(byName.anc.mergeState).toBe("ancestor");
      expect(byName.gone.mergeState).toBe("upstream-gone");
      expect(byName.squashed).toMatchObject({
        mergeState: "pr-merged",
        pr: { number: 11, state: "merged" },
      });
      expect(byName.abandoned).toMatchObject({ mergeState: "pr-closed", pr: { state: "closed" } });
      // a reused name (sha mismatch) and a fork's head never count
      expect(byName.reused.mergeState).toBeUndefined();
      expect(byName.reused.pr).toBeUndefined();
      expect(byName.anc.pr).toBeUndefined();
      expect(list).toHaveBeenCalledTimes(1);
      await cleanup();
    });

    it("dry-run reports candidates and guarded skips, deleting nothing", async () => {
      const { app, dir, id, cleanup } = await setup();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dryRun).toBe(true);
      expect(body.candidates).toEqual(
        expect.arrayContaining([
          { name: "anc", reason: "ancestor" },
          { name: "gone", reason: "upstream-gone" },
          { name: "squashed", reason: "pr-merged" },
        ]),
      );
      const names = body.candidates.map((c: { name: string }) => c.name);
      expect(names).not.toContain("abandoned");
      expect(names).not.toContain("reused");
      expect(names).not.toContain("gone-unpushed");
      expect(body.skipped).toEqual(
        expect.arrayContaining([
          { name: "inwt", why: "worktree" },
          { name: "claimed", why: "task-claimed" },
        ]),
      );
      expect(sh(dir, "branch", "--list", "squashed")).toContain("squashed");
      await cleanup();
    });

    it("confirm deletes candidates locally and refuses every guard", async () => {
      const { app, dir, id, cleanup } = await setup();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: {
          confirm: true,
          names: ["anc", "gone", "squashed", "inwt", "claimed", "main", "abandoned", "nope"],
        },
      });
      const body = res.json();
      expect([...body.deleted].sort()).toEqual(["anc", "gone", "squashed"]);
      expect(body.failed).toEqual(
        expect.arrayContaining([
          { name: "inwt", why: "worktree" },
          { name: "claimed", why: "task-claimed" },
          { name: "abandoned", why: "not-prunable" },
          { name: "nope", why: "not-prunable" },
          { name: "main", why: "not-prunable" },
        ]),
      );
      expect(sh(dir, "branch", "--list", "main")).toContain("main");
      expect(sh(dir, "branch", "--list", "inwt")).toContain("inwt");
      expect(sh(dir, "branch", "--list", "squashed")).toBe("");
      await cleanup();
    });

    it("re-validates a pr-merged branch server-side: a GitHub failure leaves it alone", async () => {
      const { app, dir, id, list, cleanup } = await setup();
      list.mockRejectedValue(new Error("boom"));
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true, names: ["squashed", "anc"] },
      });
      expect(res.json().deleted).toEqual(["anc"]);
      expect(res.json().failed).toEqual([{ name: "squashed", why: "not-prunable" }]);
      expect(sh(dir, "branch", "--list", "squashed")).toContain("squashed");
      await cleanup();
    });

    it("never deletes without an explicit confirm, even with dryRun:false or names", async () => {
      const { app, dir, id, cleanup } = await setup();
      for (const payload of [
        { dryRun: false, names: ["anc"] },
        { dryRun: true, confirm: true, names: ["anc"] },
      ]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${id}/git-branch-prune`,
          payload,
        });
        expect(res.json()).toMatchObject({ dryRun: true, deleted: [] });
      }
      expect(sh(dir, "branch", "--list", "anc")).toContain("anc");
      const dup = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true, names: ["anc", "anc"] },
      });
      expect(dup.statusCode).toBe(400);
      await cleanup();
    });

    it("rejects confirm without names and 404s an unknown project", async () => {
      const { app, id, cleanup } = await setup();
      const bad = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/git-branch-prune`,
        payload: { confirm: true },
      });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: "POST",
        url: "/api/projects/999999/git-branch-prune",
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
      await cleanup();
    });

    it("GET git-branch returns base counts, unique commits, worktree, task and pr", async () => {
      const { app, id, wt, cleanup } = await setup();
      const get = (name: string) =>
        app.inject({
          method: "GET",
          url: `/api/projects/${id}/git-branch?name=${encodeURIComponent(name)}`,
        });
      const squashed = (await get("squashed")).json();
      expect(squashed).toMatchObject({
        name: "squashed",
        base: "origin/main",
        baseAhead: 1,
        baseBehind: 0,
        mergeState: "pr-merged",
        pr: { number: 11 },
        worktreePath: null,
        taskId: null,
      });
      expect(squashed.uniqueCommits).toHaveLength(1);
      expect(squashed.uniqueCommits[0].subject).toBe("squashed work");
      expect(squashed.lastCommit.subject).toBe("squashed work");
      expect((await get("gone")).json()).toMatchObject({ upstreamGone: true });
      expect((await get("inwt")).json().worktreePath).toBe(wt);
      expect((await get("claimed")).json().taskId).toEqual(expect.any(Number));
      expect((await get("main")).json().isCurrent).toBe(true);
      expect((await get("missing")).statusCode).toBe(404);
      expect((await get("-bad")).statusCode).toBe(400);
      const none = await app.inject({ method: "GET", url: `/api/projects/${id}/git-branch` });
      expect(none.statusCode).toBe(400);
      await cleanup();
    });

    it("git-log scope=branch:<name> walks only that branch", async () => {
      const { app, id, cleanup } = await setup();
      const ok = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-log?scope=${encodeURIComponent("branch:squashed")}`,
      });
      expect(ok.statusCode).toBe(200);
      const subjects = ok.json().commits.map((c: { subject: string }) => c.subject);
      expect(subjects).toEqual(["squashed work", "initial"]);
      const bad = await app.inject({
        method: "GET",
        url: `/api/projects/${id}/git-log?scope=${encodeURIComponent("branch:--all")}`,
      });
      expect(bad.statusCode).toBe(400);
      await cleanup();
    });
  });

  // Issue #1672 — guarded checkout / create / rebase of the project checkout.
  describe("POST /api/projects/:id/git-checkout, git-branch-create, git-rebase (issue #1672)", () => {
    async function makeProject(app: Awaited<ReturnType<typeof buildApp>>) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-branch-ops-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      run(["branch", "feature"]);
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "branch-ops-repo",
          cwd: projectCwd,
        },
      });
      return { projectCwd, projectId: created.json().id as number, run };
    }

    const post = (app: Awaited<ReturnType<typeof buildApp>>, url: string, payload: object) =>
      app.inject({ method: "POST", url, payload });

    it("404s an unknown project and 400s a malformed body", async () => {
      const app = await buildApp();
      try {
        expect(
          (await post(app, "/api/projects/999999/git-checkout", { branch: "main" })).statusCode,
        ).toBe(404);
        expect((await post(app, "/api/projects/1/git-checkout", {})).statusCode).toBe(400);
        expect(
          (await post(app, "/api/projects/1/git-branch-create", { name: "x" })).statusCode,
        ).toBe(400);
        expect(
          (await post(app, "/api/projects/1/git-rebase", { onto: "x".repeat(256) })).statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });

    it("checks out, creates and rebases on a local project", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      try {
        const checkout = await post(app, `/api/projects/${projectId}/git-checkout`, {
          branch: "feature",
        });
        expect(checkout.json()).toEqual({ ok: true });

        const created = await post(app, `/api/projects/${projectId}/git-branch-create`, {
          name: "topic",
          from: "main",
          checkout: true,
        });
        expect(created.json()).toEqual({ ok: true });

        const rebased = await post(app, `/api/projects/${projectId}/git-rebase`, { onto: "main" });
        expect(rebased.json()).toEqual({ ok: true, reason: "already-up-to-date", detail: "main" });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("topic");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("refuses while an active session works in the checkout, but not one in a linked worktree", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        // A session in a linked worktree under the checkout has its own HEAD.
        // Ignored, as a real repo ignores its `.wt/` — or it reads as untracked.
        fs.appendFileSync(path.join(projectCwd, ".git", "info", "exclude"), ".wt/\n");
        const linked = path.join(projectCwd, ".wt", "other");
        run(["worktree", "add", "-q", "-b", "other", linked]);
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: linked }).run();
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "feature" })
          ).json(),
        ).toEqual({ ok: true });

        // One with no cwd of its own runs in the checkout itself.
        const inCheckout = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: null })
          .run();
        const sessionId = Number(inCheckout.lastInsertRowid);
        const blocked = { ok: false, reason: "sessions-active", detail: String(sessionId) };
        expect(
          (await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "main" })).json(),
        ).toEqual(blocked);
        expect((await post(app, `/api/projects/${projectId}/git-rebase`, {})).json()).toEqual(
          blocked,
        );
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-branch-create`, {
              name: "t2",
              from: "main",
              checkout: true,
            })
          ).json(),
        ).toEqual(blocked);
        // Creating without switching moves nothing, so it is allowed.
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-branch-create`, {
              name: "t3",
              from: "main",
            })
          ).json(),
        ).toEqual({ ok: true });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("counts a session of another project row on the same checkout", async () => {
      const app = await buildApp();
      const { projectCwd, projectId, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        const twin = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "branch-ops-twin", cwd: projectCwd },
        });
        const twinId = twin.json().id as number;
        const inserted = app.db
          .insert(sessions)
          .values({ projectId: twinId, command: "bash", cwd: null })
          .run();
        expect(
          (
            await post(app, `/api/projects/${projectId}/git-checkout`, { branch: "feature" })
          ).json(),
        ).toEqual({
          ok: false,
          reason: "sessions-active",
          detail: String(Number(inserted.lastInsertRowid)),
        });
        expect(String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("guards a project rooted in a linked worktree like any other checkout", async () => {
      const app = await buildApp();
      const { projectCwd, run } = await makeProject(app);
      const { sessions } = await import("../../src/db/schema.js");
      try {
        const linked = path.join(projectCwd, "..", `${path.basename(projectCwd)}-wt`);
        run(["worktree", "add", "-q", "-b", "wt-branch", linked]);
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "branch-ops-in-worktree", cwd: linked },
        });
        const id = project.json().id as number;
        const inserted = app.db
          .insert(sessions)
          .values({ projectId: id, command: "bash", cwd: linked })
          .run();
        expect(
          (await post(app, `/api/projects/${id}/git-checkout`, { branch: "feature" })).json(),
        ).toEqual({
          ok: false,
          reason: "sessions-active",
          detail: String(Number(inserted.lastInsertRowid)),
        });
        fs.rmSync(linked, { recursive: true, force: true });
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("refuses while another git operation holds the clone", async () => {
      const app = await buildApp();
      const { projectCwd, projectId } = await makeProject(app);
      const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
      markCloneBusy("local", projectCwd);
      try {
        const res = await post(app, `/api/projects/${projectId}/git-checkout`, {
          branch: "feature",
        });
        expect(res.json()).toMatchObject({ ok: false, reason: "busy" });
      } finally {
        releaseClone("local", projectCwd);
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    async function remoteProject(app: Awaited<ReturnType<typeof buildApp>>, baseUrl: string) {
      const host = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: `branch-ops-host-${baseUrl.length}`, baseUrl, token: "t" },
      });
      const project = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
          name: "remote-branch-ops",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      return project.json().id as number;
    }

    it("503s for a project on an unreachable remote host", async () => {
      const app = await buildApp();
      try {
        const id = await remoteProject(app, "http://127.0.0.1:1");
        const res = await post(app, `/api/projects/${id}/git-rebase`, {});
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });

    it("runs on the owning agent for a remote project", async () => {
      const app = await buildApp();
      const calls: Array<[string, unknown]> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          const { pathname } = new URL(url);
          calls.push([pathname, init?.body ? JSON.parse(String(init.body)) : undefined]);
          const body =
            pathname === "/internal/git-branches"
              ? { branches: [], worktrees: [], remoteBranches: [] }
              : { ok: false, reason: "conflicts", detail: "origin/main", conflicts: ["a.txt"] };
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      );
      try {
        const id = await remoteProject(app, "http://agent.invalid:9");
        const res = await post(app, `/api/projects/${id}/git-rebase`, { onto: "origin/main" });
        expect(res.json()).toEqual({
          ok: false,
          reason: "conflicts",
          detail: "origin/main",
          conflicts: ["a.txt"],
        });
        expect(calls).toContainEqual(["/internal/git-rebase", { cwd: "/x", onto: "origin/main" }]);
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });
  });

  describe("POST /api/projects/:id/git-worktree-remove (issue #442)", () => {
    async function makeProjectWithWorktree(app: Awaited<ReturnType<typeof buildApp>>) {
      const { execFileSync } = await import("node:child_process");
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-worktree-remove-"));
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: projectCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      fs.writeFileSync(path.join(projectCwd, "a.txt"), "a");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(projectCwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);

      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "worktree-remove-repo",
          cwd: projectCwd,
        },
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

    it.each(["active", "alive", "unknown"] as const)(
      "guards a cross-project session that is %s, with a force override",
      async (state) => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const { projects, sessions } = await import("../../src/db/schema.js");
        const otherProjectId = Number(
          app.db
            .insert(projects)
            .values({
              name: "other-worktree-project",
              cwd: worktreePath,
            })
            .run().lastInsertRowid,
        );
        const sessionId = Number(
          app.db
            .insert(sessions)
            .values({
              projectId: otherProjectId,
              command: "bash",
              cwd: worktreePath,
              status: state === "active" ? "active" : "killed",
            })
            .run().lastInsertRowid,
        );
        const liveness = vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(sessionId)]: state === "active" ? "dead" : state,
        });
        try {
          const refused = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload: { worktreePath },
          });
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
          expect(forced.json()).toEqual({ removed: true });
        } finally {
          liveness.mockRestore();
          fs.rmSync(projectCwd, { recursive: true, force: true });
          await app.close();
        }
      },
    );

    it("guards a session using a symlink alias to the worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const alias = path.join(projectCwd, "alias");
      fs.symlinkSync(worktreePath, alias);
      const { projects, sessions } = await import("../../src/db/schema.js");
      const otherId = Number(
        app.db.insert(projects).values({ name: "alias-project", cwd: alias }).run().lastInsertRowid,
      );
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId: otherId, command: "bash", cwd: alias }).run()
          .lastInsertRowid,
      );
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("reports an unresolvable session path and permits force", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const loop = path.join(projectCwd, "loop");
      fs.symlinkSync(loop, loop);
      const { projects, sessions } = await import("../../src/db/schema.js");
      const otherId = Number(
        app.db.insert(projects).values({ name: "unknown-path-project", cwd: loop }).run()
          .lastInsertRowid,
      );
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId: otherId, command: "bash", cwd: loop }).run()
          .lastInsertRowid,
      );
      try {
        const refused = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(refused.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        const forced = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, force: true },
        });
        expect(forced.json()).toEqual({ removed: true });
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not block on a session in a sibling with the same path prefix", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const sibling = `${worktreePath}-other`;
      fs.mkdirSync(sibling);
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: sibling }).run();
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(fs.existsSync(sibling)).toBe(true);
      } finally {
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("detects a session started while paths are being resolved", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run();
      let addedId = 0;
      const realpath = fs.promises.realpath.bind(fs.promises);
      const spy = vi.spyOn(fs.promises, "realpath").mockImplementation(async (p, options) => {
        if (p === projectCwd && !addedId) {
          addedId = Number(
            app.db.insert(sessions).values({ projectId, command: "bash", cwd: worktreePath }).run()
              .lastInsertRowid,
          );
        }
        return realpath(p, options as never) as Promise<string>;
      });
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(addedId).toBeGreaterThan(0);
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(addedId),
        });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("reports a host rejection from the session liveness check accurately", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: worktreePath, status: "killed" })
        .run();
      const spy = vi
        .spyOn(app.pty, "isMasterAliveStateBatch")
        .mockRejectedValue(new HostRequestError("local", 401, ""));
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.statusCode).toBe(503);
        expect(res.json().message).toContain("agent token");
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("treats a changing live cwd as an uncertain session instead of failing the request", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi.spyOn(app.pty, "list");
      spy
        .mockReturnValue([{ id: String(sessionId), liveCwd: worktreePath }] as ReturnType<
          typeof app.pty.list
        >)
        .mockReturnValueOnce([]);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("treats a live cwd that keeps changing as uncertain", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      let calls = 0;
      const spy = vi
        .spyOn(app.pty, "list")
        .mockImplementation(
          () =>
            [
              { id: String(sessionId), liveCwd: ++calls % 2 ? projectCwd : worktreePath },
            ] as ReturnType<typeof app.pty.list>,
        );
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sessionId),
        });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not retain a live cwd after its PTY exits during the check", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi
        .spyOn(app.pty, "list")
        .mockReturnValue([])
        .mockReturnValueOnce([{ id: String(sessionId), liveCwd: worktreePath }] as ReturnType<
          typeof app.pty.list
        >);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json()).toEqual({ removed: true });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
    });

    it("does not block for a changed live cwd outside the worktree", async () => {
      const app = await buildApp();
      const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
      const { sessions } = await import("../../src/db/schema.js");
      const sessionId = Number(
        app.db.insert(sessions).values({ projectId, command: "bash", cwd: projectCwd }).run()
          .lastInsertRowid,
      );
      const spy = vi.spyOn(app.pty, "list");
      spy
        .mockReturnValue([{ id: String(sessionId), liveCwd: projectCwd }] as ReturnType<
          typeof app.pty.list
        >)
        .mockReturnValueOnce([]);
      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath },
        });
        expect(res.json(), JSON.stringify(res.json())).toEqual({ removed: true });
      } finally {
        spy.mockRestore();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      }
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
        payload: {
          allowDuplicate: true,
          name: "remote-worktree-remove",
          cwd: "/x",
          hostId: host.json().id,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.json().id}/git-worktree-remove`,
        payload: { worktreePath: "/x/.mullion-worktrees/foo" },
      });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    // Issue #2026 — Settings → Storage's "Kept session worktrees": removal of
    // an ended session's own worktree, which may be on another host and was
    // cut from `worktreeRepoCwd`, not necessarily `project.cwd`.
    describe("with a sessionId", () => {
      async function insertOwner(
        app: Awaited<ReturnType<typeof buildApp>>,
        values: {
          projectId: number;
          cwd: string;
          repoCwd: string;
          hostId?: string | null;
          status?: "active" | "killed" | "exited";
        },
      ) {
        const { sessions } = await import("../../src/db/schema.js");
        const inserted = app.db
          .insert(sessions)
          .values({
            projectId: values.projectId,
            command: "bash",
            cwd: values.cwd,
            hostId: values.hostId ?? null,
            status: values.status ?? "exited",
            worktreeBranch: "mullion/session-x",
            worktreeRepoCwd: values.repoCwd,
            worktreeKeptReason: "unpushed",
          })
          .run();
        return Number(inserted.lastInsertRowid);
      }

      async function readOwner(app: Awaited<ReturnType<typeof buildApp>>, id: number) {
        const { sessions } = await import("../../src/db/schema.js");
        const { eq } = await import("drizzle-orm");
        return app.db.select().from(sessions).where(eq(sessions.id, id)).all()[0];
      }

      it("removes the session's local worktree and marks it reclaimed", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "dead",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(fs.existsSync(worktreePath)).toBe(false);
        const row = await readOwner(app, ownerId);
        expect(row.worktreeReclaimedAt).toBeInstanceOf(Date);
        expect(row.worktreeKeptReason).toBeNull();

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("refuses while the owning session's process is still alive, and force overrides it", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
          status: "killed",
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "alive",
        });

        const refused = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(refused.json()).toEqual({
          removed: false,
          reason: "still-running",
          detail: "alive",
        });
        expect(fs.existsSync(worktreePath)).toBe(true);
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeNull();

        const forced = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId, force: true },
        });
        expect(forced.json()).toEqual({ removed: true });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("runs on the session's host against worktreeRepoCwd, with the live-session guard", async () => {
        const app = await buildApp();
        const sessionBackendModule = await import("../../src/services/session-backend.js");
        const host = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "kept-worktree-remote", baseUrl: "http://127.0.0.1:1", token: "t" },
        });
        const remoteHostId = host.json().id as string;
        // A LOCAL project whose session was placed on the remote host.
        const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-kept-remote-"));
        const project = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "kept-remote", cwd: projectCwd },
        });
        const projectId = project.json().id as number;
        const repoCwd = "/remote/checkout";
        const worktreePath = "/remote/checkout/.mullion-worktrees/mullion-session-x";
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd,
          hostId: remoteHostId,
        });

        const removeListedWorktree = vi.fn().mockResolvedValue({ removed: true });
        const liveness = vi.fn(async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, "dead"])),
        );
        const compareWorktreePaths = vi.fn(
          async (_target: string, candidates: { cwd: string | null }[]) =>
            candidates.map((candidate) =>
              candidate.cwd === "/remote/alias" ? "inside" : "outside",
            ),
        );
        const resolveBackendSpy = vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
          removeListedWorktree,
          liveness,
          compareWorktreePaths,
        } as unknown as SessionBackend);

        // Another session still active inside the worktree, through an alias on that host.
        const { sessions } = await import("../../src/db/schema.js");
        const sibling = app.db
          .insert(sessions)
          .values({ projectId, command: "bash", cwd: "/remote/alias", hostId: remoteHostId })
          .run();
        const guarded = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(guarded.json()).toEqual({
          removed: false,
          reason: "sessions-active",
          detail: String(sibling.lastInsertRowid),
        });
        expect(removeListedWorktree).not.toHaveBeenCalled();

        const { eq } = await import("drizzle-orm");
        app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(eq(sessions.id, Number(sibling.lastInsertRowid)))
          .run();
        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: true });
        expect(resolveBackendSpy).toHaveBeenCalledWith(expect.anything(), remoteHostId);
        expect(removeListedWorktree).toHaveBeenCalledWith(repoCwd, worktreePath, {
          force: undefined,
        });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("refuses when the owning session's process cannot be confirmed gone", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "unknown",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({
          removed: false,
          reason: "still-running",
          detail: "unknown",
        });
        expect(fs.existsSync(worktreePath)).toBe(true);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("503s when the session's host cannot be asked, and frees the reclaim slot", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockRejectedValue(new Error("down"));
        const { claimReclaimSlot, releaseReclaimSlot } =
          await import("../../src/services/session-worktree-reclaim.js");

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.statusCode).toBe(503);
        expect(claimReclaimSlot(ownerId)).toBe(true);
        releaseReclaimSlot(ownerId);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("409s while the reclaim sweep holds the session, and 400s for an active owner", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { claimReclaimSlot, releaseReclaimSlot } =
          await import("../../src/services/session-worktree-reclaim.js");

        expect(claimReclaimSlot(ownerId)).toBe(true);
        try {
          const busy = await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload: { worktreePath, sessionId: ownerId },
          });
          expect(busy.statusCode).toBe(409);
        } finally {
          releaseReclaimSlot(ownerId);
        }

        const activeId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
          status: "active",
        });

        const active = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: activeId, force: true },
        });
        expect(active.statusCode).toBe(400);
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("rejects a session from another project, one without a worktree, or a mismatched path", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const other = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { allowDuplicate: true, name: "kept-other", cwd: projectCwd },
        });
        const foreignId = await insertOwner(app, {
          projectId: other.json().id,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { sessions } = await import("../../src/db/schema.js");
        const plainId = Number(
          app.db
            .insert(sessions)
            .values({ projectId, command: "bash", cwd: worktreePath, status: "exited" })
            .run().lastInsertRowid,
        );
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const post = (payload: object) =>
          app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/git-worktree-remove`,
            payload,
          });

        expect((await post({ worktreePath, sessionId: foreignId })).statusCode).toBe(404);
        expect((await post({ worktreePath, sessionId: 999999 })).statusCode).toBe(404);
        expect((await post({ worktreePath, sessionId: plainId })).statusCode).toBe(400);
        expect((await post({ worktreePath: projectCwd, sessionId: ownerId })).statusCode).toBe(400);
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("marks a worktree git no longer lists as reclaimed, so its row drops off", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const notAWorktree = path.join(projectCwd, "plain-dir");
        fs.mkdirSync(notAWorktree);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: notAWorktree,
          repoCwd: projectCwd,
        });
        vi.spyOn(app.pty, "isMasterAliveStateBatch").mockResolvedValue({
          [String(ownerId)]: "dead",
        });

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath: notAWorktree, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: false, reason: "not-listed" });
        expect((await readOwner(app, ownerId)).worktreeReclaimedAt).toBeInstanceOf(Date);
        expect(fs.existsSync(worktreePath)).toBe(true);

        vi.restoreAllMocks();
        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });

      it("reports an already-reclaimed worktree without touching the host", async () => {
        const app = await buildApp();
        const { projectCwd, worktreePath, projectId } = await makeProjectWithWorktree(app);
        const ownerId = await insertOwner(app, {
          projectId,
          cwd: worktreePath,
          repoCwd: projectCwd,
        });
        const { sessions } = await import("../../src/db/schema.js");
        const { eq } = await import("drizzle-orm");
        app.db
          .update(sessions)
          .set({ worktreeReclaimedAt: new Date() })
          .where(eq(sessions.id, ownerId))
          .run();

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/git-worktree-remove`,
          payload: { worktreePath, sessionId: ownerId },
        });
        expect(res.json()).toEqual({ removed: false, reason: "not-listed" });
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.rmSync(projectCwd, { recursive: true, force: true });
        await app.close();
      });
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "worktree-prune-repo",
          cwd: projectCwd,
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-worktree-prune",
          cwd: "/x",
          hostId: host.json().id,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-project",
          cwd: projectCwd,
        },
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
        workflowFiles: [],
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-nonrepo",
          cwd: projectCwd,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-clean",
          cwd: projectCwd,
        },
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
        workflowFiles: [],
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
        payload: {
          allowDuplicate: true,
          name: "diff-stats-remote-project",
          cwd: "/x",
          hostId: host.json().id,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-base-project",
          cwd: projectCwd,
        },
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
        workflowFiles: [],
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
        workflowFiles: [],
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "diff-stats-auto-project",
          cwd: projectCwd,
        },
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
        workflowFiles: [],
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
        payload: { allowDuplicate: true, createDir: true, name, cwd: projectCwd },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "git-file-diff-nonrepo",
          cwd: projectCwd,
        },
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
        payload: { createDir: true, allowDuplicate: true, name: "branchy", cwd: projectCwd },
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
        payload: { allowDuplicate: true, name: "remote-branch", cwd: "/x", hostId: host.json().id },
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
        payload: {
          allowDuplicate: true,
          name: "dangling-hostid-project",
          cwd: "/x",
          hostId: host.json().id,
        },
      });
      const otherLocal = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          allowDuplicate: true,
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
        payload: { allowDuplicate: true, name: "orphan", cwd: "/x", hostId: "does-not-exist" },
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
        payload: {
          allowDuplicate: true,
          name: "remote",
          cwd: "~/on-the-agent",
          hostId: host.json().id,
        },
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
        payload: {
          createDir: true,
          allowDuplicate: true,
          name: "same-path-local",
          cwd: "/shared/path",
        },
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
        payload: {
          allowDuplicate: true,
          name: "remote-actions",
          cwd: "/x",
          hostId: host.json().id,
        },
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
        payload: { createDir: true, allowDuplicate: true, name: "untracked-dock", cwd: "/tmp" },
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
        payload: { allowDuplicate: true, name: "remote-dock", cwd: "/x", hostId: host.json().id },
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
        payload: { createDir: true, allowDuplicate: true, name: "mixed-sessions", cwd: "/tmp" },
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
        payload: { createDir: true, allowDuplicate: true, name: "wiring-create", cwd },
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
        payload: { createDir: true, allowDuplicate: true, name: "wiring-disabled", cwd },
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
        payload: { createDir: true, allowDuplicate: true, name: "wiring-patch", cwd: originalCwd },
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
        payload: { createDir: true, allowDuplicate: true, name: "wiring-move", cwd: originalCwd },
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
        payload: { createDir: true, allowDuplicate: true, name: "wiring-delete", cwd },
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

    it("#2251 — keeps the shared hook when another project on the same repo remains", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const cwdA = await githubRepo("acme", "wiring-shared");
      const cwdB = await githubRepo("Acme", "Wiring-Shared"); // case differs

      const calls: Array<{ url: string; method?: string }> = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        if (String(url).endsWith("/hooks") && (!init || init.method === undefined)) {
          return Promise.resolve(
            jsonRes(200, [
              {
                id: 555,
                active: true,
                config: { url: "https://hooks.example.com/api/webhooks/github" },
              },
            ]),
          );
        }
        return Promise.resolve(jsonRes(201, { id: 555 }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const a = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "wiring-shared-a", cwd: cwdA },
      });
      const b = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "wiring-shared-b", cwd: cwdB },
      });
      const idA = a.json().id as number;
      const idB = b.json().id as number;
      calls.length = 0;

      // Deleting one of two projects on the repo leaves the hook alone.
      const first = await app.inject({ method: "DELETE", url: `/api/projects/${idB}` });
      expect(first.statusCode).toBe(204);
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

      const { webhookRegistrations } = await import("../../src/db/schema.js");
      const { eq: eqOp } = await import("drizzle-orm");
      const survivor = app.db
        .select()
        .from(webhookRegistrations)
        .where(eqOp(webhookRegistrations.projectId, idA))
        .get();
      expect(survivor?.hookId).toBe(555);

      // The last project on the repo takes the hook down as before.
      const second = await app.inject({ method: "DELETE", url: `/api/projects/${idA}` });
      expect(second.statusCode).toBe(204);
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/hooks/555"))).toBe(true);

      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
    });

    it("#2251 — keeps the hook while another project's host stays unresolvable, even past the import deferral window", async () => {
      const app = await makeApp();
      await enableWebhooksDirect(app);
      const cwdA = await githubRepo("acme", "wiring-ghost-a");
      const cwdB = await githubRepo("acme", "wiring-ghost-b");

      const calls: Array<{ url: string; method?: string }> = [];
      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        // The dead remote host never answers.
        if (String(url).startsWith("http://127.0.0.1:1")) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        calls.push({ url: String(url), method: init?.method });
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        if (String(url).endsWith("/hooks") && (!init || init.method === undefined)) {
          return Promise.resolve(
            jsonRes(200, [
              {
                id: 600,
                active: true,
                config: { url: "https://hooks.example.com/api/webhooks/github" },
              },
            ]),
          );
        }
        return Promise.resolve(jsonRes(201, { id: 600 }));
      }) as unknown as typeof fetch;

      const a = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "wiring-ghost-a", cwd: cwdA },
      });
      const b = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "wiring-ghost-b", cwd: cwdB },
      });
      // A project on a registered-but-dead remote host: its repo can't be resolved.
      const { hosts, projects: projectsTable } = await import("../../src/db/schema.js");
      app.db
        .insert(hosts)
        .values({ id: "ghost-host", name: "ghost", baseUrl: "http://127.0.0.1:1" })
        .run();
      app.db
        .insert(projectsTable)
        .values({ name: "ghost", cwd: "/nonexistent/ghost", hostId: "ghost-host" })
        .run();
      calls.length = 0;

      const { MAX_UNRESOLVED_MS, resetRepoKeyCache } =
        await import("../../src/services/repo-key.js");
      resetRepoKeyCache();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        // Inside the window: the unresolvable project may share the hook.
        const first = await app.inject({ method: "DELETE", url: `/api/projects/${a.json().id}` });
        expect(first.statusCode).toBe(204);
        // Past the window the import path stops deferring, but the delete guard must not.
        vi.setSystemTime(Date.now() + MAX_UNRESOLVED_MS + 60_000);
        const second = await app.inject({ method: "DELETE", url: `/api/projects/${b.json().id}` });
        expect(second.statusCode).toBe(204);
      } finally {
        vi.useRealTimers();
      }

      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
    });
  });
  // Issue #2231 — one project per repo: a checkout of a repo that already has
  // a project is attached to it instead of becoming a duplicate.
  describe("same-repo duplicate prevention (#2231)", () => {
    const ORIGIN = "git@github.com:acme/dup.git";
    let base: string;

    function checkout(name: string, origin: string | null = ORIGIN): string {
      const cwd = path.join(base, name);
      fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
      if (origin) {
        fs.writeFileSync(
          path.join(cwd, ".git", "config"),
          `[remote "origin"]\n\turl = ${origin}\n`,
        );
      }
      return cwd;
    }

    async function addHost(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      return res.json().id as string;
    }

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dup-"));
    });
    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("POST answers 409 DUPLICATE_PROJECT for the same origin, before creating any directory", async () => {
      const app = await buildApp();
      const first = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup", cwd: checkout("one") },
      });
      expect(first.statusCode).toBe(201);

      const missing = path.join(base, "not-yet", "x");
      const again = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup-2", cwd: checkout("two") },
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: "DUPLICATE_PROJECT",
        existingProjectId: first.json().id,
        existingName: "dup",
      });

      // The duplicate check runs before the directory is validated/created.
      const noDir = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup", cwd: checkout("one"), createDir: true },
      });
      expect(noDir.statusCode).toBe(409);
      expect(fs.existsSync(missing)).toBe(false);
      await app.close();
    });

    it("POST does not treat two repos on one forge with different ports as duplicates", async () => {
      const app = await buildApp();
      const first = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "gitea-a",
          cwd: checkout("ga", "ssh://git@gitea.local:2222/team/app.git"),
        },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "gitea-b",
          cwd: checkout("gb", "ssh://git@gitea.local:2223/team/app.git"),
        },
      });
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      // The same port is the same repo, and the 409 names the override.
      const third = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "gitea-c", cwd: checkout("gc", "ssh://git@gitea.local:2222/team/app") },
      });
      expect(third.statusCode).toBe(409);
      expect(third.json().message).toContain("allowDuplicate");
      expect(third.json().existingHostId).toBe("local");
      await app.close();
    });

    it("POST create for a remote hostId makes no discovery call (the check is local-only)", async () => {
      const app = await buildApp();
      const hostId = await addHost(app, "box-nonet");
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { name: "remote-nonet", cwd: "/srv/nonet", hostId },
        });
        expect(res.statusCode).toBe(201);
        expect(
          fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/internal/discover")),
        ).toEqual([]);
      } finally {
        fetchSpy.mockRestore();
      }
      await app.close();
    });

    it("POST with allowDuplicate:true creates the second project", async () => {
      const app = await buildApp();
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup", cwd: checkout("one") },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup-2", cwd: checkout("two"), allowDuplicate: true },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it("POST 409s when the new cwd is mapped in another project's hostCwds", async () => {
      const app = await buildApp();
      const hostId = await addHost(app, "box-dup");
      const first = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "mapped",
          cwd: checkout("solo", null),
          hostCwds: { [hostId]: "/srv/mapped" },
        },
      });
      expect(first.statusCode).toBe(201);
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "other", cwd: "/srv/mapped", hostId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().existingProjectId).toBe(first.json().id);
      await app.close();
    });

    it("PATCH 409s when the new cwd duplicates another project, ignores itself, and allowDuplicate overrides", async () => {
      const app = await buildApp();
      const a = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "a", cwd: checkout("a") },
      });
      const b = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "b", cwd: checkout("b", "git@github.com:acme/other.git") },
      });
      expect(b.statusCode).toBe(201);
      const bId = b.json().id as number;

      // Re-saving its own cwd is not a duplicate of itself.
      const same = await app.inject({
        method: "PATCH",
        url: `/api/projects/${bId}`,
        payload: { name: "b2", cwd: checkout("b", "git@github.com:acme/other.git") },
      });
      expect(same.statusCode).toBe(200);

      const clash = await app.inject({
        method: "PATCH",
        url: `/api/projects/${bId}`,
        payload: { cwd: checkout("c") },
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().message).toContain("save this change anyway");
      expect(clash.json()).toMatchObject({
        code: "DUPLICATE_PROJECT",
        existingProjectId: a.json().id,
      });

      const forced = await app.inject({
        method: "PATCH",
        url: `/api/projects/${bId}`,
        payload: { cwd: checkout("c"), allowDuplicate: true },
      });
      expect(forced.statusCode).toBe(200);

      // allowDuplicate alone is not a field to update.
      const only = await app.inject({
        method: "PATCH",
        url: `/api/projects/${bId}`,
        payload: { allowDuplicate: true },
      });
      expect(only.statusCode).toBe(400);
      await app.close();
    });

    it("PATCH 409s when a hostCwds entry is another project's path", async () => {
      const app = await buildApp();
      const hostId = await addHost(app, "box-patch");
      const a = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "a", cwd: checkout("pa", null), hostCwds: { [hostId]: "/srv/pa" } },
      });
      const b = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "b", cwd: checkout("pb", null) },
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${b.json().id}`,
        payload: { hostCwds: { [hostId]: "/srv/pa" } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().existingProjectId).toBe(a.json().id);
      await app.close();
    });

    it("discover reports matchedProject for an origin match and counts a hostCwds path as registered", async () => {
      const prev = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = base;
      const app = await buildApp();
      const existing = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "dup", cwd: checkout("home") },
      });
      checkout("clone"); // same origin, not registered
      checkout("unrelated", "git@github.com:acme/else.git");
      const hostId = await addHost(app, "box-disc");
      await app.inject({
        method: "POST",
        url: `/api/projects/${existing.json().id}/host-checkouts`,
        payload: { hostId, cwd: path.join(base, "unrelated") },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects/discover" });
      const byName = Object.fromEntries(res.json().map((c: { name: string }) => [c.name, c]));
      expect(byName.clone.isRegistered).toBe(false);
      expect(byName.clone.matchedProject).toEqual({
        id: existing.json().id,
        name: "dup",
        hostId: "local",
        reason: "origin",
      });
      expect(byName.home.matchedProject.reason).toBe("path");
      expect(byName.unrelated.matchedProject).toBeUndefined();
      await app.close();
      if (prev === undefined) delete process.env.PROJECTS_ROOTS;
      else process.env.PROJECTS_ROOTS = prev;
    });

    it("POST /:id/host-checkouts attaches a path as operator-set and refuses bad input", async () => {
      const app = await buildApp();
      const hostId = await addHost(app, "box-attach");
      const p = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "att", cwd: checkout("att", null) },
      });
      const id = p.json().id as number;

      const ok = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/host-checkouts`,
        payload: { hostId, cwd: "/srv/att" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().hostCwds).toEqual({ [hostId]: "/srv/att" });
      expect(ok.json().hostCwdsMeta.auto).toEqual([]);

      const own = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/host-checkouts`,
        payload: { hostId: "local", cwd: "/x" },
      });
      expect(own.statusCode).toBe(400);

      const unknown = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/host-checkouts`,
        payload: { hostId: "nope", cwd: "/x" },
      });
      expect(unknown.statusCode).toBe(400);

      const traversal = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/host-checkouts`,
        payload: { hostId, cwd: "/srv/../etc" },
      });
      expect(traversal.statusCode).toBe(400);

      // A different path already mapped for the host is not replaced.
      const mapped = await app.inject({
        method: "POST",
        url: `/api/projects/${id}/host-checkouts`,
        payload: { hostId, cwd: "/srv/att-2" },
      });
      expect(mapped.statusCode).toBe(409);
      expect(mapped.json().code).toBe("HOST_PATH_ALREADY_MAPPED");

      // A path that is another project's is refused, not attached twice.
      const other = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "other", cwd: checkout("other", null) },
      });
      const owned = await app.inject({
        method: "POST",
        url: `/api/projects/${other.json().id}/host-checkouts`,
        payload: { hostId, cwd: "/srv/att" },
      });
      expect(owned.statusCode).toBe(409);
      expect(owned.json().code).toBe("DUPLICATE_PROJECT");

      const missing = await app.inject({
        method: "POST",
        url: "/api/projects/999999/host-checkouts",
        payload: { hostId, cwd: "/srv/nobody" },
      });
      expect(missing.statusCode).toBe(404);
      await app.close();
    });
  });
});
