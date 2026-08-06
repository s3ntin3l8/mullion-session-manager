import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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

  // Issue #247 / roadmap 7.4.
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
    expect(typeof body.version).toBe("string");
    expect(body).not.toHaveProperty("idleTimeout");
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

  // Issue #431 — the agent-side half of the agent-rules triple
  // (routes/agent-rules.ts is the primary side). Global-scope targets
  // resolve off os.homedir(), redirected here the same way
  // test/services/agent-rules.test.ts does, so this never touches the
  // real test-runner's own ~/.claude etc.
  describe("/internal/agent-rules (issue #431)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/agent-rules",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS (CodeQL: this route WRITES, unlike the read-only ones above)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-outside-"));

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(400);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "malicious" },
      });
      expect(write.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, "CLAUDE.md"))).toBe(false);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists, writes, and deletes a target for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(200);
      expect(Array.isArray(list.json())).toBe(true);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "written via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("written via internal route");
      expect(fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8")).toBe(
        "written via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — this route used to reject a
    // global-scope target id here, which for a remote-hosted project's
    // global CLAUDE.md/AGENTS.md forced the primary through a standalone,
    // primary-host-only route instead — silently writing to the *primary's*
    // filesystem, not this (remote) host's. `cwd` is still confined to
    // PROJECTS_ROOTS, but it's unused for a global-scope target (which
    // resolves off this host's own redirected HOME instead).
    it("writes and deletes a global-scope target id on the project-scoped write/delete routes, resolved on this host's own HOME", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "global content via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("global content via internal route");
      expect(fs.readFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "global content via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(fakeHome, ".claude", "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    it("400s on a malformed body (missing content) via the new schema", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");
      const res = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — the names-only counterpart the
    // sidebar's per-project indicator uses instead of the full listing.
    describe("/internal/agent-rules/exists", () => {
      it("requires a cwd query param", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/internal/agent-rules/exists",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("rejects a cwd outside PROJECTS_ROOTS", async () => {
        const app = await buildApp();
        const outsideRoots = fs.mkdtempSync(
          path.join(os.tmpdir(), "internal-agent-rules-exists-outside-"),
        );
        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(outsideRoots)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        fs.rmSync(outsideRoots, { recursive: true, force: true });
        await app.close();
      });

      it("returns only existing project-scope filenames, never content", async () => {
        const app = await buildApp();
        const cwd = fs.mkdtempSync(path.join(projectsRoot, "exists-test-"));
        fs.writeFileSync(path.join(cwd, "GEMINI.md"), "should not appear in the response");

        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(cwd)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(["GEMINI.md"]);
        expect(res.payload).not.toContain("should not appear");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });

  // Issue #432 — the agent-side half of the skills-discovery triple
  // (routes/skills.ts is the primary side). Same fake-HOME redirection
  // reasoning as /internal/agent-rules above.
  describe("/internal/skills (issue #432)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    function writeSkill(dir: string, name: string, description: string) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
      );
    }

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/skills",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-outside-"));

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists project- and global-scope skills for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "skills-repo");
      writeSkill(path.join(cwd, ".claude", "skills", "proj-skill"), "proj-skill", "in the repo");
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "home-skill"),
        "home-skill",
        "in the home dir",
      );

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const byName = Object.fromEntries(
        res.json().map((s: { name: string; scope: string }) => [s.name, s]),
      );
      expect(byName["proj-skill"].scope).toBe("project");
      expect(byName["home-skill"].scope).toBe("global");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
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
    // objectContaining, not exact equality — issue #442 adds unconditional
    // enrichment fields (lastCommitRelative etc.) to every branch entry.
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "main", isCurrent: true }),
    );
    expect(body.branches).toContainEqual(
      expect.objectContaining({ name: "feature/foo", isCurrent: false }),
    );
    expect(body.branches.every((b: { isMerged?: boolean }) => b.isMerged === undefined)).toBe(true);
    expect(body.worktrees).toEqual([{ path: cwd, branch: "main", isMain: true }]);

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    await app.close();
  });

  it("resolves isMerged when ?detail=1 is set (issue #442)", async () => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-branches-detail-root-"));
    const cwd = path.join(repoRoot, "real-repo");
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    run(["add", "-A"]);
    run(["commit", "-m", "initial", "--no-verify"]);
    run(["checkout", "-b", "merged-branch"]);
    run(["checkout", "main"]);
    run(["merge", "merged-branch", "--no-edit"]);

    const remoteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "internal-git-branches-detail-origin-"),
    );
    run(["remote", "add", "origin", remoteDir]);
    execFileSync("git", ["init", "--bare", "-b", "main"], {
      cwd: remoteDir,
      stdio: "pipe",
      env: gitEnv(),
    });
    run(["push", "-u", "origin", "main"]);

    const previousRoots = process.env.PROJECTS_ROOTS;
    process.env.PROJECTS_ROOTS = repoRoot;
    const app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-branches?cwd=${encodeURIComponent(cwd)}&detail=1`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branches.find((b: { name: string }) => b.name === "merged-branch").isMerged).toBe(
      true,
    );

    process.env.PROJECTS_ROOTS = previousRoots;
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
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

  describe("POST /internal/git-worktree/remove, /clear-orphan, and /prune (issue #283)", () => {
    async function makeTaskWorktreeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-worktree-remove-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      const worktreePath = path.join(cwd, ".mullion-worktrees", "mullion-task-1");
      run(["worktree", "add", "-b", "mullion/task-1", worktreePath, "main"]);
      return { repoRoot, cwd, worktreePath, run };
    }

    it("removes a clean task worktree, but refuses (and leaves in place) a dirty one", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      // Dirty first — refused, still on disk.
      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ removed: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      fs.unlinkSync(path.join(worktreePath, "dirty.txt"));
      const cleanRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: cwd },
      });
      expect(cleanRes.statusCode).toBe(200);
      expect(cleanRes.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a worktreePath or parentCwd outside this agent's own PROJECTS_ROOTS", async () => {
      const { repoRoot, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const outsidePath = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath: "/etc/not-a-project" },
      });
      expect(outsidePath.statusCode).toBe(400);

      const outsideParent = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { worktreePath, parentCwd: "/etc" },
      });
      expect(outsideParent.statusCode).toBe(400);
      // Untouched by the rejected request.
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes an explicitly-named orphan but skips a dirty one, and rejects an orphanPaths entry outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const pruneRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: [worktreePath] },
      });
      expect(pruneRes.statusCode).toBe(200);
      expect(pruneRes.json()).toEqual({ removed: [worktreePath], skipped: [] });
      expect(fs.existsSync(worktreePath)).toBe(false);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, orphanPaths: ["/etc/not-a-project"] },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan removes a clean worktree AND its branch ref, so a fresh worktree add -b at the same path/branch succeeds", async () => {
      const { repoRoot, cwd, worktreePath, run } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: "mullion/task-1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cleared: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      // The branch is gone too — re-adding a worktree with the same -b
      // branch name at the same path no longer collides.
      expect(() =>
        run(["worktree", "add", "-b", "mullion/task-1", worktreePath, "main"]),
      ).not.toThrow();
      expect(fs.existsSync(worktreePath)).toBe(true);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("clear-orphan refuses (leaving worktree and branch in place) when the worktree is dirty, and rejects a cwd/worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd, worktreePath } = await makeTaskWorktreeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");
      const dirtyRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath, branchName: "mullion/task-1" },
      });
      expect(dirtyRes.statusCode).toBe(200);
      expect(dirtyRes.json()).toEqual({ cleared: false, reason: "dirty" });
      expect(fs.existsSync(worktreePath)).toBe(true);

      const outsideRes = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/clear-orphan",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project", branchName: "mullion/task-1" },
      });
      expect(outsideRes.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("POST /internal/git-branch-delete, /git-worktree/remove-listed, and /prune-metadata (issue #442)", () => {
    async function makeRepo() {
      const { execFileSync } = await import("node:child_process");
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-442-root-"));
      const cwd = path.join(repoRoot, "real-repo");
      fs.mkdirSync(cwd, { recursive: true });
      const run = (args: string[], runCwd = cwd) =>
        execFileSync("git", args, { cwd: runCwd, stdio: "pipe", env: gitEnv() });
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
      run(["add", "-A"]);
      run(["commit", "-m", "initial", "--no-verify"]);
      return { repoRoot, cwd, run };
    }

    it("deletes a branch on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      run(["branch", "feature-x"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, name: "feature-x" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/name body for git-branch-delete, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-branch-delete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc/not-a-project", name: "main" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("removes any worktree git worktree list reports, not just a mullion-task-prefixed one", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "hand-made");
      run(["worktree", "add", "-b", "hand-made-branch", worktreePath, "main"]);
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: true });
      expect(fs.existsSync(worktreePath)).toBe(false);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd/worktreePath body for remove-listed, and rejects a worktreePath outside PROJECTS_ROOTS", async () => {
      const { repoRoot, cwd } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/remove-listed",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd, worktreePath: "/etc/not-a-project" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("prunes stale worktree administrative metadata on this host's own filesystem", async () => {
      const { repoRoot, cwd, run } = await makeRepo();
      const worktreePath = path.join(cwd, ".mullion-worktrees", "oob-removed");
      run(["worktree", "add", "-b", "oob-branch", worktreePath, "main"]);
      fs.rmSync(worktreePath, { recursive: true, force: true });
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pruned: true });

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });

    it("requires a cwd body for prune-metadata, and rejects a cwd outside PROJECTS_ROOTS", async () => {
      const { repoRoot } = await makeRepo();
      const previousRoots = process.env.PROJECTS_ROOTS;
      process.env.PROJECTS_ROOTS = repoRoot;
      const app = await buildApp();

      const missing = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const outside = await app.inject({
        method: "POST",
        url: "/internal/git-worktree/prune-metadata",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { cwd: "/etc" },
      });
      expect(outside.statusCode).toBe(400);

      process.env.PROJECTS_ROOTS = previousRoots;
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await app.close();
    });
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

  describe("GET /internal/sessions/:id/scrollback (Phase 4, #187)", () => {
    it("returns the base64-encoded scrollback for a tracked session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;

      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "601", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/601/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const { b64 } = res.json();
      expect(typeof b64).toBe("string");
      // Always non-empty: getScrollback()'s synthesized alt-screen preamble
      // is unconditional, even with nothing else in the ring buffer yet —
      // see pty-manager.ts's getScrollback doc comment.
      expect(Buffer.from(b64, "base64").length).toBeGreaterThan(0);

      await app.close();
    });

    it("returns an empty b64 for a session id this agent has never tracked", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/sessions/never-spawned/scrollback",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ b64: "" });
      await app.close();
    });

    it("401s without a valid bearer token", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/internal/sessions/601/scrollback" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("POST /internal/sessions/:id/review-gate (issue #178)", () => {
    it("delivers a decision to a real pending gate and reports {ok: true}", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9001", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);
      const session = app.pty.get("9001");
      if (!session) throw new Error("session not tracked");

      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(app.pty.hookSocketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });
      socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
      socket.write(
        `${JSON.stringify({ kind: "review_gate", state: "waiting", prompt: "rm -rf /tmp/x" })}\n`,
      );
      await waitUntil(() => session.toInfo().gateState === "waiting");

      const replyPromise = new Promise<string>((resolve) => {
        socket.on("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
      });

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9001/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(JSON.parse(await replyPromise)).toEqual({ decision: "approved" });
      expect(session.toInfo().gateState).toBe("approved");

      socket.destroy();
      await app.close();
    });

    it("reports {ok: false} when nothing is pending for this session", async () => {
      const app = await buildApp();
      const before = fakePtyChildren.length;
      await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { id: "9002", cwd: "/tmp", command: "bash", cols: 80, rows: 24 },
      });
      await waitUntil(() => fakePtyChildren.length > before);

      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9002/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "denied", reason: "nothing pending" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: false });

      await app.close();
    });

    it("rejects a request with the wrong token", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9003/review-gate",
        headers: { authorization: "Bearer wrong" },
        payload: { decision: "approved" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("400s an unrecognized decision value", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions/9004/review-gate",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
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
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              host: req.headers.host,
              path: req.url,
              method: req.method,
              headers: req.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
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

    it("streams a POST body through to this agent's own loopback dev server", async () => {
      // Registered in its own encapsulated child context with a raw
      // content-type parser (see internal.ts) so request.body arrives as
      // the unparsed stream this route needs — this is the regression test
      // for that encapsulation actually working.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.method).toBe("POST");
      expect(body.body).toBe(JSON.stringify({ hello: "world" }));
      await app.close();
    });

    it("401s a POST with no Authorization header, same as the existing GET gate", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        payload: JSON.stringify({ hello: "world" }),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("still forwards a POST body with no Content-Type header at all", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/preview/${stubPort}/api/echo`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: "raw-bytes-no-content-type",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toBe("raw-bytes-no-content-type");
      await app.close();
    });

    it("still parses JSON bodies for an ordinary /internal/* POST route (encapsulation regression net)", async () => {
      // Proves the preview route's own raw-body content-type parser
      // (registered in a child context so it can removeAllContentTypeParsers()
      // for itself) never leaked out and broke JSON parsing for the rest of
      // this plugin — spawn-session is a real POST route that requires a
      // parsed JSON body.
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/sessions",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          id: "not-numeric-port-related",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        },
      });
      // Whatever this route's own validation does with this payload, it
      // must have been able to parse it as JSON in the first place — a
      // leaked raw-body parser would instead hand it an unparsed Buffer
      // and fail differently (e.g. a schema/type error, not this route's
      // own business-logic response).
      expect(res.statusCode).not.toBe(415);
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

// Issue #245 / roadmap 7.1 (independent review, PR #528) — the single
// highest-consequence invariant in the self-registration feature: an
// enrolled agent has MULLION_AGENT_TOKEN unset (empty string), and without
// the `.trim() !== ""` guard in internal.ts's onRequest hook,
// timingSafeTokenMatch("", "") would make an EMPTY inbound Authorization
// header match an empty configured token — unauthenticated access to
// /internal/ws/attach, arbitrary command execution. This must be a test,
// not a comment.
describe("internal routes: empty MULLION_AGENT_TOKEN guard (issue #245)", () => {
  let projectsRoot: string;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-empty-token-root-"));
    process.env.MULLION_ROLE = "agent";
    process.env.PROJECTS_ROOTS = projectsRoot;
    // No MULLION_AGENT_TOKEN — mirrors an enrolled agent before (or
    // without) any successful self-registration, when app.agentSession is
    // also still undefined. Needs SOME path to boot per src/app.ts's
    // fail-closed check; port 1 fails fast (connection refused) so the
    // plugin's fire-and-forget registerWithRetry() doesn't hang the test
    // or make a real network call.
    process.env.MULLION_PRIMARY_URL = "http://127.0.0.1:1";
    process.env.MULLION_ENROLLMENT_TOKEN = "unused-in-this-test";
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
  });

  it("rejects a request with an empty Authorization Bearer value when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/discover",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a request with no Authorization header at all when no static token is configured", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/discover" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
