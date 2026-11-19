import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { dropSessionGithubAuth, getSessionGithubAuth } =
  await import("../../src/services/session-github-token.js");
const { getTerminalPalette, resetTerminalPalette } =
  await import("../../src/services/terminal-query-reply.js");

const TOKEN = INTERNAL_TEST_TOKEN;
const { activeScopeUnits } = childProcessHarness;

describe("internal routes (agent role, issue #26)", () => {
  const env = createInternalAgentEnv();
  let projectsRoot: string;
  beforeAll(() => {
    env.setup();
    projectsRoot = env.projectsRoot;
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  it("PUT /internal/sessions/:id/github-auth stores a refreshed token for the session (#2246)", async () => {
    const app = await buildApp();
    const headers = { authorization: `Bearer ${TOKEN}` };
    const ok = await app.inject({
      method: "PUT",
      url: "/internal/sessions/2246/github-auth",
      headers,
      payload: { mode: "task", token: "ghs_refreshed", username: "x-access-token" },
    });
    expect(ok.statusCode).toBe(204);
    expect(getSessionGithubAuth("2246")).toMatchObject({ mode: "task", token: "ghs_refreshed" });

    const noAuth = await app.inject({
      method: "PUT",
      url: "/internal/sessions/2246/github-auth",
      payload: { mode: "task", token: "x" },
    });
    expect(noAuth.statusCode).toBe(401);

    const badId = await app.inject({
      method: "PUT",
      url: `/internal/sessions/${encodeURIComponent("weird;id")}/github-auth`,
      headers,
      payload: { mode: "task", token: "x" },
    });
    expect(badId.statusCode).toBe(400);
    const badBody = await app.inject({
      method: "PUT",
      url: "/internal/sessions/2246/github-auth",
      headers,
      payload: { mode: "root", token: "x" },
    });
    expect(badBody.statusCode).toBe(400);
    dropSessionGithubAuth("2246");
    await app.close();
  });

  it("rejects a request with no Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/agents" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("compares host paths within configured roots and refuses escaped paths", async () => {
    const app = await buildApp();
    const worktree = path.join(projectsRoot, "comparison-target");
    const alias = path.join(projectsRoot, "comparison-alias");
    fs.mkdirSync(worktree, { recursive: true });
    fs.symlinkSync(worktree, alias, "dir");
    const res = await app.inject({
      method: "POST",
      url: "/internal/worktrees/compare-paths",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        target: worktree,
        candidates: [
          { id: "1", cwd: alias },
          { id: "2", cwd: projectsRoot },
          { id: "3", cwd: os.tmpdir() },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stable: true,
      generation: expect.any(String),
      relations: ["inside", "outside", "unknown"],
    });
    fs.rmSync(alias);
    fs.rmSync(worktree, { recursive: true, force: true });
    await app.close();
  });

  it("uses the agent session launch cwd when the primary has none", async () => {
    const app = await buildApp();
    const worktree = path.join(projectsRoot, "comparison-launch-target");
    fs.mkdirSync(worktree, { recursive: true });
    const get = vi
      .spyOn(app.pty, "get")
      .mockReturnValue({ cwd: worktree, liveCwd: null } as ReturnType<typeof app.pty.get>);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/worktrees/compare-paths",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          target: worktree,
          candidates: [
            { id: "1", cwd: null },
            { id: "2", cwd: null },
          ],
        },
      });
      expect(res.json()).toMatchObject({ stable: true, relations: ["inside", "inside"] });
      get.mockReturnValue(undefined);
      const unknown = await app.inject({
        method: "POST",
        url: "/internal/worktrees/compare-paths",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { target: worktree, candidates: [{ id: "1", cwd: null }] },
      });
      expect(unknown.json()).toMatchObject({ relations: ["unknown"] });
    } finally {
      get.mockRestore();
      fs.rmSync(worktree, { recursive: true, force: true });
      await app.close();
    }
  });

  it("rejects a request with the wrong token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/agents",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // Issue #1721 / roadmap 8.7 — the agent's own CAPACITY report. Behind
  // the same gate as every other /internal/* route, and measured by the
  // ONE function the primary also uses for itself (so the two are
  // comparable by construction).
  it("rejects a capacity request with no Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/capacity" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("reports this agent's own platform, cores, load, memory and session counts", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/capacity",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      platform: string;
      logicalCores: number;
      loadAverage1m: number;
      memory: { totalBytes: number; freeBytes: number };
      sessions: { tracked: number; alive: number };
      sampledAt: string;
    };
    expect(body.platform).toBe(process.platform);
    expect(body.logicalCores).toBeGreaterThan(0);
    expect(body.loadAverage1m).toBeGreaterThanOrEqual(0);
    expect(body.memory.totalBytes).toBeGreaterThan(0);
    expect(body.sessions).toEqual({ tracked: 0, alive: 0 });
    // The age stamp, so the primary can tell a fresh reading from a stale
    // one — a host that stops reporting keeps its last numbers.
    expect(Number.isNaN(Date.parse(body.sampledAt))).toBe(false);
    await app.close();
  });

  it("discovers candidates from this agent's own PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // Issue #2090 — each candidate also carries its raw origin and whether it
    // is a linked worktree, so the primary can match a project to its clone on
    // this host (the fixture's repo has an origin remote).
    expect(res.json()).toEqual([
      {
        name: "git-repo",
        cwd: path.join(projectsRoot, "git-repo"),
        isGitRepo: true,
        origin: "git@github.com:s3ntin3l8/mullion-session-manager.git",
        isWorktree: false,
      },
    ]);
    await app.close();
  });

  // Issue #247 / roadmap 7.4. Issue #820 PR5d — sshAuthSock is no longer
  // unconditionally null here: with MULLION_SSH_AUTH_SOCK and ambient
  // SSH_AUTH_SOCK both unset (this describe block's own beforeAll), the
  // agent role falls back to the bridge-materialized socket
  // (resolveSshAuthSock's tier 3) — and sshAgentPlugin has genuinely bound
  // that socket by the time this request runs, so `present` is true, not
  // a dangling-path case.
  it("returns this agent's own effective config, with no idle timeout (that's DB-backed on the primary)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/config",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      role: "agent",
      projectsRoots: [projectsRoot],
      sessionsDir: app.config.SESSIONS_DIR,
      crsConfigDir: app.config.CRS_CONFIG_DIR,
      browserEnabled: app.config.BROWSER_ENABLED,
    });
    expect(body.sshAuthSock).toEqual({
      path: path.join(path.dirname(app.pty.hookSocketPath), "ssh-agent.sock"),
      present: true,
      source: "bridge",
    });
    expect(typeof body.version).toBe("string");
    expect(body).not.toHaveProperty("idleTimeout");
    await app.close();
  });

  // #819/#822 SSH-agent follow-up — the dangling-socket case is the
  // expected steady state whenever the far end (an `ssh -R` tunnel) is
  // offline, not an error, so this must surface as `present: false`
  // rather than throwing or omitting the field.
  it("reports sshAuthSock present/absent from a live existsSync check, not just the configured path", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-"));
    const presentSockPath = path.join(socketDir, "agent.sock");
    fs.writeFileSync(presentSockPath, "");
    const absentSockPath = path.join(socketDir, "does-not-exist.sock");

    try {
      process.env.MULLION_SSH_AUTH_SOCK = presentSockPath;
      const presentApp = await buildApp();
      const presentRes = await presentApp.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(presentRes.json().sshAuthSock).toEqual({
        path: presentSockPath,
        present: true,
        source: "configured",
      });
      await presentApp.close();

      process.env.MULLION_SSH_AUTH_SOCK = absentSockPath;
      const absentApp = await buildApp();
      const absentRes = await absentApp.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(absentRes.json().sshAuthSock).toEqual({
        path: absentSockPath,
        present: false,
        source: "configured",
      });
      await absentApp.close();
    } finally {
      delete process.env.MULLION_SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // Issue #820 PR7a — before this, the ambient tier reported `sshAuthSock:
  // null`, identical to genuinely having nothing configured at all
  // (resolveSshAuthSock's "none" tier). Settings > Hosts needs to tell
  // these apart, so the ambient tier now reports the inherited path itself
  // (not the bridge/configured path — there isn't one; Mullion isn't
  // supplying this value) tagged `source: "ambient"`.
  it("reports the ambient SSH_AUTH_SOCK itself, tagged source: ambient — distinct from the null 'nothing configured' case", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-ambient-"));
    const ambientSockPath = path.join(socketDir, "keyring-agent.sock");
    fs.writeFileSync(ambientSockPath, "");

    try {
      process.env.SSH_AUTH_SOCK = ambientSockPath;
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().sshAuthSock).toEqual({
        path: ambientSockPath,
        present: true,
        source: "ambient",
      });
      await app.close();
    } finally {
      delete process.env.SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // #819/#822 SSH-agent follow-up — pty-manager.ts's PtyManager resolves a
  // relative MULLION_SSH_AUTH_SOCK once, at construction (its own comment:
  // "a relative MULLION_SSH_AUTH_SOCK would resolve against a different ...
  // directory instead of the single stable path this feature depends on").
  // This diagnostic must report that same resolved path, not the raw
  // relative string — otherwise it would show an operator a path that
  // doesn't match what sessions actually receive, and existsSync would run
  // against the wrong location (this process's cwd) rather than a
  // guaranteed-stable one.
  it("resolves a relative MULLION_SSH_AUTH_SOCK the same way PtyManager does, not the raw string", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-ssh-sock-relative-"));
    const sockPath = path.join(socketDir, "agent.sock");
    fs.writeFileSync(sockPath, "");
    const relativeSockPath = path.relative(process.cwd(), sockPath);

    try {
      process.env.MULLION_SSH_AUTH_SOCK = relativeSockPath;
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().sshAuthSock).toEqual({
        path: sockPath,
        present: true,
        source: "configured",
      });
      await app.close();
    } finally {
      delete process.env.MULLION_SSH_AUTH_SOCK;
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  // Issue #647 / roadmap 7.8 — the agent-side counterpart to
  // test/routes/updates.test.ts's own suite. Deliberately mirrors that
  // file's fixtures (VALID_ASSET_URL/VALID_CHECKSUM_URL, a per-test
  // mkdtemp MULLION_HOME) rather than sharing them, since these routes are
  // reached over a different mount point (/internal/updates/* — see this
  // file's own onRequest gate above) with a different auth requirement.

  describe("PUT /internal/terminal/palette", () => {
    const palette = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };

    it("rejects a request with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/internal/terminal/palette",
        payload: palette,
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("caches the forwarded palette for this agent's startup query replies", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/internal/terminal/palette",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: palette,
      });
      expect(res.statusCode).toBe(204);
      expect(getTerminalPalette()).toEqual(palette);
      resetTerminalPalette();
      await app.close();
    });

    it("rejects a malformed color", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "PUT",
        url: "/internal/terminal/palette",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { ...palette, background: "red" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("self-update (issue #647 / roadmap 7.8)", () => {
    const VALID_ASSET_URL =
      "https://github.com/s3ntin3l8/mullion-session-manager/releases/download/v0.1.5/mullion-0.1.5.tgz";
    const VALID_CHECKSUM_URL =
      "https://github.com/s3ntin3l8/mullion-session-manager/releases/download/v0.1.5/mullion-0.1.5.tgz.sha256";
    let mullionHome: string;

    beforeEach(() => {
      mullionHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-updates-test-home-"));
    });

    afterEach(() => {
      delete process.env.MULLION_HOME;
      fs.rmSync(mullionHome, { recursive: true, force: true });
    });

    it("rejects GET /internal/updates/status with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/internal/updates/status" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects POST /internal/updates/apply with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("reports 'unavailable' from GET /internal/updates/status when MULLION_HOME is unset", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/updates/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ phase: "unavailable" });
      await app.close();
    });

    it("reflects the current contents of .update-status.json", async () => {
      process.env.MULLION_HOME = mullionHome;
      fs.writeFileSync(
        path.join(mullionHome, ".update-status.json"),
        JSON.stringify({ phase: "restarting", version: "0.1.5", updatedAt: 12345 }),
      );
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/updates/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json()).toMatchObject({ phase: "restarting", version: "0.1.5" });
      await app.close();
    });

    it("rejects a malformed body (bad version pattern) on POST /internal/updates/apply", async () => {
      process.env.MULLION_HOME = mullionHome;
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          version: "not-a-version",
          assetUrl: VALID_ASSET_URL,
          checksumUrl: VALID_CHECKSUM_URL,
        },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("refuses when MULLION_HOME is unset", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("launches self-update.sh detached via systemd-run and returns 202", async () => {
      process.env.MULLION_HOME = mullionHome;
      const scriptDir = path.join(mullionHome, "current", "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(path.join(scriptDir, "self-update.sh"), "#!/usr/bin/env bash\n");
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/updates/apply",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL, checksumUrl: VALID_CHECKSUM_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ phase: "downloading", version: "0.1.5" });
      // The shared node:child_process mock at the top of this file tracks
      // every "systemd-run -u <unit> ..." call's unit name in
      // activeScopeUnits — reused here rather than adding a second spy on
      // the same mocked spawn().
      expect(activeScopeUnits.has("mullion-update-0.1.5.scope")).toBe(true);
      await app.close();
    });
  });

  describe("PUT /internal/projects-roots (issue #1951)", () => {
    const originalHome = process.env.HOME;
    let sandbox: string;
    let newRoot: string;
    const put = (app: Awaited<ReturnType<typeof buildApp>>, roots: unknown, token = TOKEN) =>
      app.inject({
        method: "PUT",
        url: "/internal/projects-roots",
        headers: { authorization: `Bearer ${token}` },
        payload: { roots },
      });
    const get = (app: Awaited<ReturnType<typeof buildApp>>, url: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });

    beforeEach(() => {
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "internal-roots-"));
      process.env.HOME = path.join(sandbox, "home");
      fs.mkdirSync(process.env.HOME, { recursive: true });
      newRoot = path.join(sandbox, "work");
      fs.mkdirSync(path.join(newRoot, "other-repo", ".git"), { recursive: true });
    });
    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      delete process.env.PROJECTS_ROOTS_LOCKED;
      fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("saves the roots, reports them as an override, and applies them on the very next request", async () => {
      const app = await buildApp();
      const res = await put(app, [newRoot]);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        projectsRoots: [newRoot],
        projectsRootsSource: "override",
        projectsRootsEnv: [projectsRoot],
        projectsRootsLocked: false,
      });
      // The discover scan and the path barrier both read the new roots at once.
      const discovered = await get(app, "/internal/discover");
      expect(discovered.json()).toEqual([
        {
          name: "other-repo",
          cwd: path.join(newRoot, "other-repo"),
          isGitRepo: true,
          origin: null,
          isWorktree: false,
        },
      ]);
      const inside = await get(app, `/internal/actions?cwd=${encodeURIComponent(newRoot)}`);
      expect(inside.statusCode).not.toBe(400);
      const oldRoot = await get(app, `/internal/actions?cwd=${encodeURIComponent(projectsRoot)}`);
      expect(oldRoot.statusCode).toBe(400);
      await app.close();
    });

    it("survives a restart, and null goes back to the host's own PROJECTS_ROOTS", async () => {
      const first = await buildApp();
      expect((await put(first, [newRoot])).statusCode).toBe(200);
      await first.close();

      const second = await buildApp();
      const config = (await get(second, "/internal/config")).json();
      expect(config).toMatchObject({ projectsRoots: [newRoot], projectsRootsSource: "override" });

      const reset = await put(second, null);
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({
        projectsRoots: [projectsRoot],
        projectsRootsSource: "env",
      });
      expect(
        fs.existsSync(path.join(process.env.HOME!, ".mullion", "agent-projects-roots.json")),
      ).toBe(false);
      await second.close();
    });

    it("refuses an unsafe or missing directory with 422 {status: 400}, saving nothing", async () => {
      const app = await buildApp();
      for (const bad of [
        path.join(sandbox, "missing"),
        process.env.HOME!,
        path.dirname(sandbox),
        "relative/dir",
      ]) {
        const res = await put(app, [bad]);
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ status: 400, error: expect.any(String) });
      }
      expect((await get(app, "/internal/config")).json()).toMatchObject({
        projectsRoots: [projectsRoot],
        projectsRootsSource: "env",
      });
      await app.close();
    });

    it("rejects a malformed body", async () => {
      const app = await buildApp();
      // Refused either by the body schema (400) or, for an empty list that the
      // schema layer coerces through, by the validator (422 {status: 400}).
      for (const body of [[], "nope", { roots: 1 }]) {
        const res = await put(app, body);
        expect([400, 422]).toContain(res.statusCode);
      }
      await app.close();
    });

    it("answers 422 {status: 409} when the host's operator pinned the roots, and ignores a saved override", async () => {
      // An override saved earlier (before the operator pinned the roots).
      const early = await buildApp();
      expect((await put(early, [newRoot])).statusCode).toBe(200);
      await early.close();

      process.env.PROJECTS_ROOTS_LOCKED = "true";
      const app = await buildApp();
      const res = await put(app, [newRoot]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ status: 409, error: expect.stringMatching(/pinned/) });
      expect((await get(app, "/internal/config")).json()).toMatchObject({
        projectsRoots: [projectsRoot],
        projectsRootsSource: "env",
        projectsRootsLocked: true,
        // ... and it says the saved list is being ignored, so it can be cleared.
        projectsRootsOverrideIgnored: true,
      });

      // Clearing is allowed while pinned: it only moves toward the pinned value,
      // and without it the old override would spring back the day the pin lifts.
      const cleared = await put(app, null);
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({
        projectsRoots: [projectsRoot],
        projectsRootsOverrideIgnored: false,
      });
      expect(
        fs.existsSync(path.join(process.env.HOME!, ".mullion", "agent-projects-roots.json")),
      ).toBe(false);
      await app.close();
    });

    it("does not trust a hand-edited override: a file rewritten to name '/' falls back to the env roots", async () => {
      const first = await buildApp();
      expect((await put(first, [newRoot])).statusCode).toBe(200);
      await first.close();
      // What an attacker with file-write reach into ~/.mullion would try.
      const file = path.join(process.env.HOME!, ".mullion", "agent-projects-roots.json");
      fs.writeFileSync(file, JSON.stringify({ version: 1, roots: ["/"] }));
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(file, future, future);

      const app = await buildApp();
      expect((await get(app, "/internal/config")).json()).toMatchObject({
        projectsRoots: [projectsRoot],
        projectsRootsSource: "env",
      });
      await app.close();
    });

    it("refuses a root that overlaps Mullion's own data (~/.mullion holds this very override)", async () => {
      const app = await buildApp();
      const own = path.join(process.env.HOME!, ".mullion");
      fs.mkdirSync(own, { recursive: true });
      const res = await put(app, [own]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        status: 400,
        error: expect.stringMatching(/Mullion's own/),
      });
      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      expect((await put(app, [newRoot], "wrong")).statusCode).toBe(401);
      await app.close();
    });

    it("is rate limited far below the other internal routes", async () => {
      const app = await buildApp();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await put(app, [newRoot])).statusCode);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429]);
      await app.close();
    });
  });

  // Issue #1951 — the agent-side halves of `sessions.prompt` and
  // `sessions.wait_for_output` for a child whose PTY lives on this host. A
  // refusal is HTTP 422 carrying `{status, error}`: RemoteHostClient discards
  // the body of a 5xx, so the real answer must travel as a 4xx.
});
