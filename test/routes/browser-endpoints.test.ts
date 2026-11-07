import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { previews, projects, sessionBrowsers, sessions } from "../../src/db/schema.js";
import { AGENT_OPERATIONS, PROTOCOL_VERSION } from "../../src/shared/agent-protocol.js";
import { BrowserManager, type BrowserTarget } from "../../src/services/browser-manager.js";
import {
  closeSessionBrowserBindings,
  listSessionBrowserBindings,
  recordSessionBrowserBinding,
} from "../../src/services/session-browsers.js";
import { resolveSessionBrowserTarget } from "../../src/services/browser-target.js";
import { resolveAgentBrowserTarget } from "../../src/services/session-lifecycle.js";
import { sessionBrowserTarget } from "../../src/services/session-browser-targets.js";
import { BROWSER_TARGET_SCHEMA } from "../../src/routes/internal-schemas.js";
import { uniqueSessionsDir } from "../helpers/sessions-dir.js";

// Issue #2688 — a session's browser endpoint is decided when the session first
// binds a browser, from the preview it serves, and is the same on the primary,
// on the agent and on a close. These tests go through the real primary routes
// and a real, listening agent app (no mock of the client or `requireOperation`).
const tmpDb = path.join(os.tmpdir(), `browser-endpoints-test-${process.pid}.db`);
const TOKEN = "browser-endpoints-agent-token";

type App = Awaited<ReturnType<typeof buildApp>>;

function fakePage() {
  return {
    content: vi.fn(async () => "<html></html>"),
    url: () => "http://localhost/",
    title: async () => "t",
    getByText: () => ({ all: async () => [] }),
    locator: () => ({ ariaSnapshot: async () => "- body" }),
    evaluate: async () => [],
  };
}
const launched = () =>
  ({ page: fakePage(), consoleLogs: [], pageErrors: [] }) as unknown as Awaited<
    ReturnType<App["browser"]["getOrLaunch"]>
  >;

describe("browser endpoints (#2688)", () => {
  let primary: App;
  let agent: App;
  let agentPort: number;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.BROWSER_ENABLED = "true";
    const prev: Record<string, string | undefined> = {};
    const agentEnv = {
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: TOKEN,
      PROJECTS_ROOTS: os.tmpdir(),
      SESSIONS_DIR: uniqueSessionsDir("browser-endpoints"),
    };
    for (const [k, v] of Object.entries(agentEnv)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    agent = await buildApp();
    for (const k of Object.keys(agentEnv)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await agent.listen({ port: 0, host: "127.0.0.1" });
    const address = agent.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    agentPort = address.port;
    primary = await buildApp();
  });
  afterAll(async () => {
    await primary.close();
    await agent.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.BROWSER_ENABLED;
  });
  afterEach(() => vi.restoreAllMocks());

  async function addAgentHost(operations: readonly string[] = AGENT_OPERATIONS) {
    const res = await primary.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `be-host-${++n}`,
        baseUrl: `http://127.0.0.1:${agentPort}`,
        token: TOKEN,
      },
    });
    const hostId = res.json().id as string;
    primary.hostAgentTracker?.record(hostId, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: {
        protocolVersion: PROTOCOL_VERSION,
        legacy: false,
        operations: [...operations],
        launchOptions: ["browserTarget"],
      },
    });
    return hostId;
  }
  function addProject(cwd: string, hostId: string) {
    return primary.db
      .insert(projects)
      .values({ name: `be-${++n}`, cwd, hostId })
      .returning({ id: projects.id })
      .get().id;
  }
  function addSession(projectId: number, cwd: string, hostId: string) {
    return primary.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd, hostId })
      .returning({ id: sessions.id })
      .get().id;
  }
  function addPreview(projectId: number, sessionId: number, slug: string, branch = "") {
    primary.db
      .insert(previews)
      .values({ slug, kind: "project", projectId, sessionId, branch })
      .run();
  }
  const bindingOf = (sessionId: number) => listSessionBrowserBindings(primary, sessionId)[0];

  /** What the spawn does: the agent gets the legacy target, the primary an
   * unfixed binding. */
  async function spawnRemote(projectId: number, sessionId: number, hostId: string) {
    const [project] = primary.db.select().from(projects).where(eq(projects.id, projectId)).all();
    const sent = await resolveAgentBrowserTarget(primary, project, sessionId, hostId);
    expect(sent).toBeDefined();
    expect(sent!.endpoint).toBeUndefined();
    recordSessionBrowserBinding(primary, sessionId, sent!, { endpointUnfixed: true });
    const { rememberSessionBrowserTarget } =
      await import("../../src/services/session-browser-targets.js");
    rememberSessionBrowserTarget(agent.pty, String(sessionId), sent!, agent.config.SESSIONS_DIR);
    return sent!;
  }

  it("a remote session opens its browser with the preview endpoint and closes it on session end", async () => {
    const hostId = await addAgentHost();
    const projectId = addProject("/work/p", hostId);
    const sessionId = addSession(projectId, "/work/p", hostId);
    await spawnRemote(projectId, sessionId, hostId);
    // The dev server is accepted AFTER the spawn.
    addPreview(projectId, sessionId, "prev-remote");
    expect(bindingOf(sessionId).targetEndpoint).toBeNull();

    const launch = vi.spyOn(agent.browser, "getOrLaunch").mockResolvedValue(launched());
    const res = await primary.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "get" },
    });
    expect(res.statusCode).toBe(200);
    // The agent served the endpoint-keyed target (real route + parseBrowserTarget).
    expect(launch.mock.calls[0][0]).toMatchObject({
      projectId,
      hostId,
      checkoutRoot: "/work/p",
      endpoint: "prev-remote",
    });
    // Fixed on the primary, and on the agent for the session's own `use_browser`.
    expect(bindingOf(sessionId).targetEndpoint).toBe("prev-remote");
    expect(sessionBrowserTarget(String(sessionId), agent.config.SESSIONS_DIR)?.endpoint).toBe(
      "prev-remote",
    );

    // Never changes afterwards, even when another preview shows up.
    addPreview(projectId, sessionId, "prev-later", "later");
    const again = await resolveSessionBrowserTarget(primary, projectId, sessionId);
    expect(again.ok && again.target.endpoint).toBe("prev-remote");

    // Session end: the real agent /close receives the endpoint.
    const close = vi.spyOn(agent.browser, "closeTarget").mockResolvedValue(undefined);
    closeSessionBrowserBindings(primary, sessionId);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(close.mock.calls[0][0]).toMatchObject({
      projectId,
      hostId,
      checkoutRoot: "/work/p",
      endpoint: "prev-remote",
    });
  });

  it("keeps the context the agent already runs, so the panel and use_browser share one", async () => {
    const hostId = await addAgentHost();
    const projectId = addProject("/work/q", hostId);
    const sessionId = addSession(projectId, "/work/q", hostId);
    const sent = await spawnRemote(projectId, sessionId, hostId);
    addPreview(projectId, sessionId, "prev-late");
    // use_browser already opened a context with the spawn-time target.
    vi.spyOn(agent.browser, "get").mockImplementation((t: BrowserTarget) =>
      t.endpoint === undefined ? ({} as never) : undefined,
    );
    const launch = vi.spyOn(agent.browser, "getOrLaunch").mockResolvedValue(launched());

    const res = await primary.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "get" },
    });
    expect(res.statusCode).toBe(200);
    expect(launch.mock.calls[0][0].endpoint).toBeUndefined();
    expect(bindingOf(sessionId).targetEndpoint).toBe("");
    expect(sessionBrowserTarget(String(sessionId), agent.config.SESSIONS_DIR)).toEqual(sent);
  });

  it("an older agent (no browser-endpoints) gets the legacy endpoint on every path: one context, one close", async () => {
    const hostId = await addAgentHost(AGENT_OPERATIONS.filter((op) => op !== "browser-endpoints"));
    const projectId = addProject("/work/old", hostId);
    const sessionId = addSession(projectId, "/work/old", hostId);
    await spawnRemote(projectId, sessionId, hostId);
    addPreview(projectId, sessionId, "prev-old");

    const launch = vi.spyOn(agent.browser, "getOrLaunch").mockResolvedValue(launched());
    const push = vi.spyOn(agent.browser, "get");
    for (let i = 0; i < 2; i++) {
      const res = await primary.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/browser`,
        payload: { action: "get" },
      });
      expect(res.statusCode).toBe(200);
    }
    // Both panel-proxied calls name the endpoint-less target the spawn sent.
    expect(launch).toHaveBeenCalled();
    expect(launch.mock.calls.every(([t]) => t.endpoint === undefined)).toBe(true);
    expect(push).not.toHaveBeenCalled(); // no target push to an agent without the operation
    expect(bindingOf(sessionId).targetEndpoint).toBe("");

    // A binding recorded WITH an endpoint before the agent was downgraded is
    // still closed under the key the agent knows.
    const close = vi.spyOn(agent.browser, "closeTarget").mockResolvedValue(undefined);
    primary.db
      .update(sessionBrowsers)
      .set({ targetEndpoint: "prev-old" })
      .where(eq(sessionBrowsers.sessionId, sessionId))
      .run();
    closeSessionBrowserBindings(primary, sessionId);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(close.mock.calls[0][0].endpoint).toBeUndefined();
  });

  it("a local session opens its browser with the preview endpoint and closes it on session end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "be-local-"));
    const projectId = addProject(dir, "local");
    const sessionId = addSession(projectId, dir, "local");
    addPreview(projectId, sessionId, "prev-local");
    const launch = vi.spyOn(primary.browser, "getOrLaunch").mockResolvedValue(launched());

    const res = await primary.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "get" },
    });
    expect(res.statusCode).toBe(200);
    expect(launch.mock.calls[0][0]).toMatchObject({
      projectId,
      hostId: "local",
      checkoutRoot: dir,
      endpoint: "prev-local",
      legacy: true,
    });
    expect(bindingOf(sessionId).targetEndpoint).toBe("prev-local");

    const close = vi.spyOn(primary.browser, "closeTarget").mockResolvedValue(undefined);
    closeSessionBrowserBindings(primary, sessionId);
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "prev-local" }));
  });

  it("a local session with no preview keeps the legacy value even once a dev server is accepted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "be-nopreview-"));
    const projectId = addProject(dir, "local");
    const sessionId = addSession(projectId, dir, "local");
    vi.spyOn(primary.browser, "getOrLaunch").mockResolvedValue(launched());
    await primary.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "get" },
    });
    expect(bindingOf(sessionId).targetEndpoint).toBe("");
    addPreview(projectId, sessionId, "prev-accepted-later");
    const resolved = await resolveSessionBrowserTarget(primary, projectId, sessionId);
    expect(resolved.ok && resolved.target.endpoint).toBeUndefined();
  });

  it("a branch preview in its own worktree resolves its own target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "be-wt-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
    const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "be-wt-branch-")));
    fs.rmSync(worktree, { recursive: true });
    git("worktree", "add", "-q", "-b", "feat", worktree);
    const projectId = addProject(fs.realpathSync(root), "local");
    const mainSession = addSession(projectId, fs.realpathSync(root), "local");
    const dockSession = addSession(projectId, worktree, "local");
    addPreview(projectId, mainSession, "prev-main");
    addPreview(projectId, dockSession, "prev-branch", "feat");

    const main = await resolveSessionBrowserTarget(primary, projectId, mainSession);
    const branch = await resolveSessionBrowserTarget(primary, projectId, dockSession);
    expect(main.ok && main.target).toMatchObject({
      checkoutRoot: fs.realpathSync(root),
      endpoint: "prev-main",
      legacy: true,
    });
    expect(branch.ok && branch.target).toMatchObject({
      checkoutRoot: worktree,
      endpoint: "prev-branch",
      legacy: false,
    });
  });

  it("an agent whose spawn schema lacks `endpoint` strips it without error", async () => {
    // The claim behind the capability gate: an older agent's
    // additionalProperties:false schema drops the field and the call succeeds.
    const { endpoint: _endpoint, ...properties } = BROWSER_TARGET_SCHEMA.properties;
    const oldSchema = { ...BROWSER_TARGET_SCHEMA, properties };
    const old = Fastify();
    let seen: unknown;
    old.post(
      "/spawn",
      { schema: { body: { type: "object", properties: { browserTarget: oldSchema } } } },
      async (req) => {
        seen = (req.body as { browserTarget: unknown }).browserTarget;
        return { ok: true };
      },
    );
    const res = await old.inject({
      method: "POST",
      url: "/spawn",
      payload: {
        browserTarget: {
          projectId: 1,
          hostId: "h",
          checkoutRoot: "/r",
          legacy: true,
          endpoint: "e",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ projectId: 1, hostId: "h", checkoutRoot: "/r", legacy: true });
    await old.close();
  });

  it("an unreachable agent leaves the session's endpoint undecided", async () => {
    const hostId = await addAgentHost();
    const projectId = addProject("/work/down", hostId);
    const sessionId = addSession(projectId, "/work/down", hostId);
    await spawnRemote(projectId, sessionId, hostId);
    addPreview(projectId, sessionId, "prev-down");
    const { RemoteHostClient } = await import("../../src/services/remote-host-client.js");
    vi.spyOn(RemoteHostClient.prototype, "postBrowser").mockRejectedValue(new Error("down"));
    const resolved = await resolveSessionBrowserTarget(primary, projectId, sessionId);
    expect(resolved.ok && resolved.target.endpoint).toBeUndefined();
    expect(bindingOf(sessionId).targetEndpoint).toBeNull();
  });
});

describe("legacy cookie jar of the default checkout (#2688)", () => {
  function jar(dataDir: string, target: BrowserTarget): string {
    const mgr = new BrowserManager({ enabled: true, dataDir } as never);
    return (mgr as unknown as { storageStatePath(t: BrowserTarget): string }).storageStatePath(
      target,
    );
  }
  const base = { projectId: 4, hostId: "local", checkoutRoot: "/r", legacy: true };

  it("keeps project-<id>.json for the endpoint that first loads it, even a slug accepted later", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "be-jar-"));
    expect(path.basename(jar(dir, { ...base, endpoint: "prev-a" }))).toBe("project-4.json");
    expect(path.basename(jar(dir, { ...base, endpoint: "prev-a" }))).toBe("project-4.json");
    // The user explicitly opens a second endpoint: it gets its own file.
    const second = path.basename(jar(dir, { ...base, endpoint: "prev-b" }));
    expect(second).toMatch(/^project-4-[0-9a-f]{16}\.json$/);
    expect(path.basename(jar(dir, base))).not.toBe("project-4.json");
  });

  it("keeps the jar for the legacy endpoint when it is the one in use", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "be-jar-"));
    expect(path.basename(jar(dir, base))).toBe("project-4.json");
    expect(path.basename(jar(dir, { ...base, endpoint: "prev-a" }))).not.toBe("project-4.json");
  });

  it("never gives a non-default checkout the legacy file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "be-jar-"));
    expect(path.basename(jar(dir, { ...base, legacy: false, checkoutRoot: "/wt" }))).not.toBe(
      "project-4.json",
    );
  });
});
