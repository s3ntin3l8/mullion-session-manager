import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" — see mock-pty.ts's header comment for
// the empirically confirmed hoisting/ordering failure mode.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as HermesReview from "../../src/services/hermes-review.js";
import type * as TaskReconciler from "../../src/services/task-reconciler.js";

// The relay's landed-check memo (issue #1630) — cleared per test so one
// test's answer is not the next one's.
import { gitEnv } from "../../src/services/git-env.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";

import { buildTestApp } from "../helpers/app.js";
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

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

// Each "remote host" test below builds a second, real buildApp() instance in
// `agent` role alongside this file's own primary one — both would otherwise
// default to the SAME SESSIONS_DIR (test/setup.ts sets it once per file), so
// their hooksPlugin listeners (registered for both roles) would collide on
// the same hooks.sock path. Gives each agent instance its own scratch
// directory instead.

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

    // The apps this block builds are closed by buildTestApp()'s
    // onTestFinished callback, which also asserts their hooks.sock is gone
    // — the same guarantee this block's own afterEach used to give by
    // closing every tracked app itself (issue #525's containment).

    it("404s for an unknown project", async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/dock" });
      expect(res.statusCode).toBe(404);
    });

    it("returns [] for a project with no .crs/dock.json", async () => {
      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-dock-empty-"));
      const app = await buildTestApp();
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

      const app = await buildTestApp();
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

  // Issue #1851 — the READ-ONLY clone health check. It never mutates
  // anything: a damaged clone is reported, not repaired.
  // Issue #1896 — the clone REPAIR. Two phases in one endpoint: without
  // `confirm` it returns the PLAN (a read), with `confirm: true` it runs the
  // repair and reports what it did.

  // Issue #1672 — guarded checkout / create / rebase of the project checkout.

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
    // SESSIONS_DIR contains that failure mode to this block; the apps
    // below (closed unconditionally by buildTestApp()) stop it from
    // leaking at all.
    let previousSessionsDir: string | undefined;
    const sessionsDir = uniqueSessionsDir("projects");

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
      // Not tracked via buildTestApp(): this app must be fully closed
      // before the test body's own app call runs (same hooks.sock,
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
    });

    it("registers a webhook for a project created while webhooks are enabled", async () => {
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
      const app = await buildTestApp();
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
