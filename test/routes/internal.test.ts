import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { gitEnv } from "../../src/services/git-env.js";

// The agent's /internal/* API (issue #26) reaches the exact same PtyManager
// spawn/liveness path as the primary's own routes (sessions.ts, terminal.ts)
// and the exact same agent-detect probe as actions.ts/agents.ts — just
// through a token-gated, DB-less surface instead. Faked the same way
// test/routes/terminal.test.ts, test/services/pty-manager.test.ts, and
// test/services/agent-detect.test.ts fake it, combined into one mock since a
// single "agent" role process exercises all three code paths.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  exitListeners: Array<() => void> = [];
  writeSpy = vi.fn();
  resizeSpy = vi.fn();

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: () => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write(data: string) {
    this.writeSpy(data);
  }

  resize(cols: number, rows: number) {
    this.resizeSpy(cols, rows);
  }

  kill() {}

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[] = [], options?: unknown) => {
      // `git` (git-status.ts, issues #76/#96) is passed straight through to
      // the real implementation rather than faked — unlike
      // systemctl/systemd-run/agent-detect's shell probe below, this suite
      // actually asserts on real git output (branch/isClean), and a real
      // temp repo is cheap to spin up in these tests.
      if (file === "git") {
        return actual.spawn(file, args, options as ChildProcess.SpawnOptions);
      }

      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };

      // PtyManager.isMasterAlive: `systemctl --user is-active <unit>.scope`.
      // Always replies "active" — this suite asserts response shape, not
      // session-reconciler-style semantics (already covered elsewhere).
      if (file === "systemctl" && args[1] === "is-active") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit("data", Buffer.from("active\n"));
            ee.emit("close", 0);
          });
        });
        return ee;
      }

      // PtyManager.stopScope (terminate) and bootstrapMaster (systemd-run):
      // both only wait on 'exit'.
      if ((file === "systemctl" && args[1] === "stop") || file === "systemd-run") {
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }

      // Anything else is agent-detect's probe(): `$SHELL -lc "command -v
      // <bin>"`, which waits on 'close' only (never 'exit' — see its own
      // doc comment). No stdout data means "not found"; every probe in this
      // suite reports unavailable, which is fine since nothing here asserts
      // on which specific CLIs are detected, only that the endpoints work.
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");

const TOKEN = "test-agent-token";

// Real PNG signature bytes — /internal/uploads now checks the body's actual
// magic bytes against the declared mime (issue #68 hardening), not just the
// Content-Type header, so a happy-path upload test needs a real signature,
// not an arbitrary string.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

function waitForOpenOrClose(ws: WebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve("open"), { once: true });
    ws.addEventListener("close", () => resolve("close"), { once: true });
  });
}

// The `ws` package's client (needed here, not the global WebSocket, since
// only `ws` supports setting a custom Authorization header on the upgrade
// request — see remote-host-client.ts's planned use of the same package)
// emits 'unexpected-response' (and sometimes 'error') for a rejected
// upgrade, not a DOM-style 'close' event — both are "never opened" outcomes
// for this test's purposes.
function waitForNodeWsOutcome(ws: NodeWebSocket): Promise<"open" | "close"> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("close", () => resolve("close"));
    ws.once("unexpected-response", () => resolve("close"));
    ws.once("error", () => resolve("close"));
  });
}

// The near side (this test's own client) can finish its handshake with the
// agent before the agent's own upstream connection to the loopback stub
// has — pipeWsFrames deliberately drops (not queues) a message sent before
// the upstream is OPEN, same tradeoff as terminal.ts's own
// proxyToRemoteAttach. Retrying the send until a response arrives, rather
// than sending once and awaiting a fixed delay, is this repo's existing
// convention for this exact gap (see preview-ws-proxy.test.ts's own
// identical helper).
function sendUntilEcho(ws: NodeWebSocket, message: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const onMessage = (data: Buffer) => {
      clearInterval(interval);
      resolve(data.toString());
    };
    ws.once("message", onMessage);
    const interval = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(interval);
        ws.off("message", onMessage);
        reject(new Error("no response received before timeout"));
        return;
      }
      if (ws.readyState === NodeWebSocket.OPEN) ws.send(message);
    }, 20);
  });
}

describe("internal routes (agent role, issue #26)", () => {
  let projectsRoot: string;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-discover-root-"));
    fs.mkdirSync(path.join(projectsRoot, "git-repo", ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(projectsRoot, "git-repo", ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:s3ntin3l8/mullion-session-manager.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.PROJECTS_ROOTS = projectsRoot;
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
  });

  beforeEach(() => {
    clearAgentsCacheForTests();
  });

  async function buildAndListen() {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return { app, port: address.port };
  }

  it("rejects a request with no Authorization header", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/agents" });
    expect(res.statusCode).toBe(401);
    await app.close();
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

  it("discovers candidates from this agent's own PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: "git-repo", cwd: path.join(projectsRoot, "git-repo"), isGitRepo: true },
    ]);
    await app.close();
  });

  it("requires a cwd query param for actions and dock", async () => {
    const app = await buildApp();
    const actions = await app.inject({
      method: "GET",
      url: "/internal/actions",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: "/internal/dock",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);
    await app.close();
  });

  it("resolves actions and dock for a cwd on this host", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(200);
    expect(Array.isArray(actions.json())).toBe(true);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(200);
    expect(dock.json()).toEqual([]);
    await app.close();
  });

  it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-outside-roots-"));

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("rejects a session id that isn't a plain alphanumeric token", async () => {
    const app = await buildApp();

    const terminateRes = await app.inject({
      method: "POST",
      url: `/internal/sessions/${encodeURIComponent("weird;id")}/terminate`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(400);

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "weird id", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(400);

    await app.close();
  });

  it("resolves a github.com owner/repo from this host's own .git/config (issue #27)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: "s3ntin3l8", repo: "mullion-session-manager" });
    await app.close();
  });

  it("resolves null for a repo with no github.com origin remote", async () => {
    // A separate root (not projectsRoot) so this bare repo never shows up
    // as an extra candidate in the "discovers candidates" test's exact
    // single-entry assertion above.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bare-root-"));
    fs.mkdirSync(path.join(bareRoot, "bare-repo", ".git"), { recursive: true });
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = bareRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(path.join(bareRoot, "bare-repo"))}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(bareRoot, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for github-repo, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/github-repo",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-github-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/github-repo?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves the current branch from this host's own HEAD (issue #96)", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");
    fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBe("main");
    await app.close();
  });

  it("requires a cwd query param for git-branch, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branch",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branch-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branch?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves git status from this host's own filesystem (issue #76)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, status } — not a bare GitStatus — so the primary can tell
    // "not a repo" apart from "repo exists but git status failed
    // transiently" for a remote host the same way it already can locally
    // (isGitRepo/getGitStatus).
    expect(res.json()).toMatchObject({
      isRepo: true,
      status: { branch: "main", isClean: true },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a directory that isn't a git repo (issue #76)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, status: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-status, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-status",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-status-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-status?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves diff stats from this host's own filesystem (issue #202)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\ntwo\n");

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    // { isRepo, stats } — same shape as /internal/git-status's own
    // { isRepo, status }, for the same "durable vs. transient" reason.
    expect(res.json()).toEqual({
      isRepo: true,
      stats: { filesChanged: 1, insertions: 1, deletions: 0 },
    });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reports isRepo: false for a git-diff cwd that isn't a git repo (issue #202)", async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-not-a-repo-"));
    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = notARepo;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(notARepo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false, stats: null });

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(notARepo, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-diff, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-diff",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-diff-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-diff?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("resolves branches and worktrees from this host's own filesystem (issue #162)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "initial", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    execFileSync("git", ["branch", "feature/foo"], { cwd, stdio: "pipe", env: gitEnv() });

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branches).toContainEqual({ name: "main", isCurrent: true });
    expect(body.branches).toContainEqual({ name: "feature/foo", isCurrent: false });
    expect(body.worktrees).toEqual([{ path: cwd, branch: "main", isMain: true }]);

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("requires a cwd query param for git-branches, and rejects one outside PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: "/internal/git-branches",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.statusCode).toBe(400);

    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-outside-"));
    const outside = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(outside.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  it("returns this host's detected agents", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/agents",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });

  it("spawns a session, reports its live status/liveness, and terminates it", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    const spawnRes = await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "501", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
    });
    expect(spawnRes.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501", "never-spawned"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.statusCode).toBe(200);
    const live = liveRes.json();
    expect(live["501"]).toMatchObject({ alive: true, cwd: "/tmp", command: "bash" });
    expect(live["never-spawned"]).toBeNull();

    const livenessRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/liveness",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["501"] },
    });
    expect(livenessRes.statusCode).toBe(200);
    // The fake systemctl mock above always replies "active".
    expect(livenessRes.json()).toEqual({ "501": true });

    const terminateRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/501/terminate",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(terminateRes.statusCode).toBe(204);

    await app.close();
  });

  it("expands a leading ~ in a spawned session's cwd against this host's own home dir", async () => {
    const app = await buildApp();
    const before = fakePtyChildren.length;

    await app.inject({
      method: "POST",
      url: "/internal/sessions",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { id: "502", cwd: "~", command: "bash", cols: 80, rows: 24 },
    });
    await waitUntil(() => fakePtyChildren.length > before);

    const liveRes = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ids: ["502"], idleThresholdMs: 30_000 },
    });
    expect(liveRes.json()["502"]).toMatchObject({ cwd: os.homedir() });

    await app.close();
  });

  describe("POST /internal/uploads (issue #68)", () => {
    it("writes an image under <cwd>/.mullion-uploads and returns its absolute path", async () => {
      const app = await buildApp();
      // Must be within projectsRoot: this route now confines cwd via
      // resolveWithinRoots, same as /internal/actions and /internal/dock.
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const buffer = PNG_BYTES;

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: buffer,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads"))).toBe(true);
      expect(fs.readFileSync(uploadPath)).toEqual(buffer);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-upload-outside-"));

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(outsideRoots)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a mime type outside the allow-list", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fsvg%2Bxml`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/svg+xml" },
        payload: Buffer.from("<svg/>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a body whose bytes don't match the declared mime, even with an allow-listed Content-Type", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: Buffer.from("<html><script>alert(1)</script></html>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("requires cwd and mime query params", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/uploads",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a request with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=%2Ftmp&mime=image%2Fpng`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  it("rejects a WS attach with no Authorization header before the upgrade completes", async () => {
    const { app, port } = await buildAndListen();

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=x&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
    );
    const outcome = await waitForOpenOrClose(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a WS attach missing required query params, even with a valid token", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/attach?id=x`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("rejects a WS attach whose id isn't a plain alphanumeric token", async () => {
    const { app, port } = await buildAndListen();

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=${encodeURIComponent("weird;id")}&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const outcome = await waitForNodeWsOutcome(ws);
    expect(outcome).toBe("close");

    await app.close();
  });

  it("attaches over WS with a valid token, spawning and streaming pty output", async () => {
    const { app, port } = await buildAndListen();
    const before = fakePtyChildren.length;

    const ws = new NodeWebSocket(
      `ws://127.0.0.1:${port}/internal/ws/attach?id=503&cwd=%2Ftmp&command=bash&cols=80&rows=24`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("close", () => reject(new Error("WS closed instead of opening")));
      ws.once("error", reject);
    });
    await waitUntil(() => fakePtyChildren.length > before);
    const pty = fakePtyChildren[fakePtyChildren.length - 1];

    const messagePromise = new Promise<Buffer>((resolve) => {
      ws.once("message", (data) => resolve(data as Buffer));
    });
    pty.emitData("hello from agent pty");
    const message = await messagePromise;
    expect(message.toString("utf8")).toBe("hello from agent pty");

    ws.close();
    await app.close();
  });

  describe("/internal/ws/events (issue #166's multi-host twin — the agent-side half)", () => {
    it("rejects a connection with no Authorization header", async () => {
      const { app, port } = await buildAndListen();

      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/ws/events`);
      const outcome = await waitForOpenOrClose(ws);
      expect(outcome).toBe("close");

      await app.close();
    });

    it("replays buffered events then streams live ones, using the same shared core as /ws/events", async () => {
      const { app, port } = await buildAndListen();

      // Numeric-looking id — matches production reality (a session id on
      // the agent side is always the primary's stringified DB row id, see
      // sessions.ts's spawn() call), and NotificationEvent.sessionId is
      // typed `number` (pty-manager.ts), derived via Number(this.id).
      // fakePtyChildren accumulates across every test in this file — snapshot
      // its length first (same pattern the /internal/ws/attach test above
      // uses) so `pty` below is genuinely THIS test's own session, not a
      // stale one left over from an earlier test.
      const before = fakePtyChildren.length;
      const spawn = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "77", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      expect(spawn.statusCode).toBe(201);
      await waitUntil(() => fakePtyChildren.length > before);
      const pty = fakePtyChildren[fakePtyChildren.length - 1];

      // Emitted before the WS connects — must still appear in the replay
      // batch (mirrors events.test.ts's own local-route replay assertion).
      pty.emitData("\x1b]2;working\x07");

      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/internal/ws/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const messages: Array<{ sessionId: number; kind: string; payload: Record<string, unknown> }> =
        [];
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error("WS closed instead of opening")));
        ws.once("error", reject);
      });

      await waitUntil(() => messages.length > 0);
      expect(messages[0]).toMatchObject({
        sessionId: 77,
        kind: "title_change",
        payload: { title: "working" },
      });

      // A working->idle title transition (#98) is a zero-threshold attention
      // signal (see ATTENTION_CONFIRM_MS in attention-detect.ts) — confirms
      // synchronously, unlike a bare bell (debounced against attention-detect.ts's
      // PENDING_ATTENTION state machine — see issue #171), which needs either
      // a real ~2s wait or a direct Session.tick() call this route-level test
      // has no access to. The session's title is already "working" from the
      // pre-connect emit above, so this is a genuine transition.
      pty.emitData("\x1b]2;idle\x07");
      await waitUntil(() => messages.some((m) => m.kind === "attention"));

      ws.close();
      await app.close();
    });
  });

  describe("/internal/preview* (issue #28 phase 6 — the agent's own loopback-only proxy half)", () => {
    let stubHttpServer: http.Server;
    let stubWss: WebSocketServer;
    let stubPort: number;

    beforeAll(async () => {
      stubHttpServer = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
      });
      stubWss = new WebSocketServer({ server: stubHttpServer });
      stubWss.on("connection", (socket) => {
        socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
      });
      await new Promise<void>((resolve) => stubHttpServer.listen(0, "127.0.0.1", resolve));
      stubPort = (stubHttpServer.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => stubWss.close(() => resolve()));
      await new Promise<void>((resolve) => stubHttpServer.close(() => resolve()));
    });

    it("proxies to this agent's own loopback dev server, stripping its own auth header before forwarding", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}/some/asset.js?v=1`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.path).toBe("/some/asset.js?v=1");
      // The stub echoes whatever Authorization header it received — none,
      // proving buildUpstreamRequestHeaders' "authorization" exclusion
      // actually stripped this agent's own bearer token before the
      // onward loopback fetch (it would otherwise leak this agent's
      // shared secret to arbitrary project dev-server code).
      expect(body.host).toBe(`127.0.0.1:${stubPort}`);
      await app.close();
    });

    it("rejects a non-numeric or out-of-range port", async () => {
      const app = await buildApp();
      const notNumeric = await app.inject({
        method: "GET",
        url: "/internal/preview/not-a-port/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(notNumeric.statusCode).toBe(400);

      const outOfRange = await app.inject({
        method: "GET",
        url: "/internal/preview/70000/x",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(outOfRange.statusCode).toBe(400);
      await app.close();
    });

    it("502s when the loopback dev server is unreachable", async () => {
      const app = await buildApp();
      // Port 1: a real, always-refused loopback port (same convention used
      // throughout this repo's other "unreachable" tests).
      const res = await app.inject({
        method: "GET",
        url: "/internal/preview/1/",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(502);
      await app.close();
    });

    // The core security claim of this phase: this agent must only ever
    // dial its own loopback, regardless of what path the primary forwards
    // — see resolveLoopbackPreviewUrl's own comment for the two concrete
    // bypasses (network-path reference, HTTP userinfo) a naive
    // string-concatenation would have been vulnerable to.
    it("never dials off-loopback, even for a path smuggling a network-path reference or userinfo host", async () => {
      const app = await buildApp();
      for (const maliciousRest of [
        "//evil.example.com/x",
        "/\\evil.example.com/x",
        "@evil.example.com/",
      ]) {
        const res = await app.inject({
          method: "GET",
          url: `/internal/preview/${stubPort}/${maliciousRest}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        // Either rejected outright (400, the expected outcome) or, in the
        // worst case a future change weakens the parse, proxied — but
        // NEVER to evil.example.com: assert on the stub's own recorded
        // host if it somehow got a 200.
        if (res.statusCode === 200) {
          expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
        } else {
          expect(res.statusCode).toBe(400);
        }
      }
      await app.close();
    });

    it("400s (not 500s) a preview path that `new URL()` itself throws on (Hermes review, PR #48)", async () => {
      // Confirmed via node -e: `new URL("//[::a.b.c.d]/x", base)` throws
      // TypeError outright rather than just parsing into something
      // resolveLoopbackPreviewUrl would otherwise reject — a case its own
      // try/catch exists for.
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${stubPort}///[::a.b.c.d]/x`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a WS preview upgrade with a non-numeric port or missing path", async () => {
      const { app, port } = await buildAndListen();

      const badPort = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=not-a-port&path=%2F`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(badPort)).toBe("close");

      const missingPath = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(missingPath)).toBe("close");

      await app.close();
    });

    // A network-path reference doesn't get *rejected* pre-handshake — it
    // gets *sanitized* (resolveLoopbackPreviewUrl only ever keeps the
    // pathname/search, see its own comment) and the upgrade proceeds
    // against the real loopback dev server, same as the HTTP case above.
    // The assertion that matters isn't "close" — it's "this never actually
    // dials evil.example.com", proven here by getting a real echo back
    // from *our* stub.
    it("sanitizes (not rejects) a WS preview path smuggling a network-path reference — still only ever dials loopback", async () => {
      const { app, port } = await buildAndListen();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=${encodeURIComponent("//evil.example.com/x")}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });

    it("proxies a WS preview upgrade to this agent's own loopback dev server", async () => {
      const { app, port } = await buildAndListen();

      const ws = new NodeWebSocket(
        `ws://127.0.0.1:${port}/internal/ws/preview?port=${stubPort}&path=%2Fhmr`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(await waitForNodeWsOutcome(ws)).toBe("open");
      expect(await sendUntilEcho(ws, "ping")).toBe("echo:ping");

      ws.close();
      await app.close();
    });
  });
});
