import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { projects, sessions } from "../../src/db/schema.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../../src/shared/constants.js";
import { eq } from "drizzle-orm";

// Issue #3427 - a REMOTE project's Docker discovery and service actions go to
// its agent. The agent is scripted below; a method the test does not script
// rejects like an unreachable host. (The local half is projects-docker.test.ts,
// which also holds the in-process agent round trip.)
const agent = vi.hoisted(() => ({
  scripted: {} as Record<string, (...args: unknown[]) => unknown>,
  calls: [] as { method: string; args: unknown[] }[],
}));
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  const client = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        async (...args: unknown[]) => {
          agent.calls.push({ method, args });
          const fn = agent.scripted[method];
          if (!fn) throw new Error(`host unreachable (${method} not scripted)`);
          return fn(...args);
        },
    },
  );
  return { ...actual, getRemoteHostClient: () => client };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `projects-docker-remote-test-${process.pid}.db`);

function service(overrides: Record<string, unknown> = {}) {
  return {
    composeProject: "sanctuary",
    service: "web",
    containerName: "sanctuary-web",
    workingDir: "/remote/path",
    state: "running",
    status: "Up",
    imageRef: "nginx:1",
    imageId: "sha256:old",
    buildable: false,
    pullable: true,
    composeResolvable: true,
    configFiles: [],
    envFile: null,
    configHash: "h",
    ...overrides,
  };
}

describe("remote projects: Docker discovery and actions on the agent (#3427)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function remoteProjectOn(app: Awaited<ReturnType<typeof buildApp>>, name: string) {
    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const [row] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/remote/path", hostId: hostRes.json().id as string })
      .returning()
      .all();
    return row.id;
  }

  it("a remote-host project merges the controls its agent discovers under its configured ones (#3427)", async () => {
    agent.scripted = {
      resolveDock: () => [
        { id: "dev", title: "Dev", command: "npm run dev" },
        { id: "docker:sanctuary:web", title: "Web (custom)", command: "tail -f x" },
      ],
      resolveDockerServices: () => ({
        composeAvailable: true,
        services: [
          service({ workingDir: "/remote/path" }),
          service({ service: "db", workingDir: "/remote/path/sub" }),
          service({ service: "other", workingDir: "/elsewhere" }),
        ],
      }),
    };
    const app = await buildApp();
    const projectId = await remoteProjectOn(app, "remote");

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
    expect(res.statusCode).toBe(200);
    const controls = res.json() as { id: string; title: string }[];
    expect(controls.map((c) => c.id).sort()).toEqual([
      "dev",
      "docker:sanctuary:db",
      "docker:sanctuary:web",
    ]);
    // configured wins on an id collision
    expect(controls.find((c) => c.id === "docker:sanctuary:web")?.title).toBe("Web (custom)");
    expect(agent.calls.some((c) => c.method === "resolveDockerServices")).toBe(true);

    await app.close();
  });

  it("a remote project whose agent has no Docker, or cannot answer, keeps its configured controls", async () => {
    const app = await buildApp();
    const projectId = await remoteProjectOn(app, "remote-nodocker");
    agent.scripted = {
      resolveDock: () => [{ id: "dev", title: "Dev", command: "npm run dev" }],
      resolveDockerServices: () => ({ composeAvailable: false, services: [] }),
    };
    const empty = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
    expect(empty.json().map((c: { id: string }) => c.id)).toEqual(["dev"]);

    // an older agent that lacks the route: discovery throws, the dock still answers
    agent.scripted = {
      resolveDock: () => [{ id: "dev", title: "Dev", command: "npm run dev" }],
    };
    const old = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
    expect(old.statusCode).toBe(200);
    expect(old.json().map((c: { id: string }) => c.id)).toEqual(["dev"]);

    // an unreachable host is still a 503 for the dock itself
    agent.scripted = {};
    const down = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
    expect(down.statusCode).toBe(503);

    await app.close();
  });

  it("runs a remote project's check-update and service actions on its agent (#3427)", async () => {
    const app = await buildApp();
    const projectId = await remoteProjectOn(app, "remote-actions");
    agent.calls = [];
    agent.scripted = {
      resolveDockerServices: () => ({
        composeAvailable: true,
        services: [service({ workingDir: "/remote/path" })],
      }),
      runDockerComposeAction: (_cwd, _svc, action) =>
        action === "check-update"
          ? { updateAvailable: true, currentImageId: "a", latestImageId: "b", imageRef: "r" }
          : { success: action !== "stop" },
    };
    const payload = { controlId: "docker:sanctuary:web" };

    const check = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/check-update`,
      payload,
    });
    expect(check.json()).toMatchObject({ updateAvailable: true, latestImageId: "b" });

    const restart = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/service/restart`,
      payload,
    });
    expect(restart.json()).toEqual({ success: true });
    const stop = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/service/stop`,
      payload,
    });
    expect(stop.json()).toEqual({ success: false });
    expect(agent.calls.filter((c) => c.method === "runDockerComposeAction")).toHaveLength(3);

    // an agent that fails mid-action degrades, never 5xx
    agent.scripted.runDockerComposeAction = () => {
      throw new Error("boom");
    };
    const failedCheck = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/check-update`,
      payload,
    });
    expect(failedCheck.json()).toEqual({ updateAvailable: false, reason: "pull-failed" });
    const failedStart = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/service/start`,
      payload,
    });
    expect(failedStart.json()).toEqual({ success: false });

    await app.close();
  });

  it("404s for a remote project's service its agent does not report", async () => {
    agent.scripted = { resolveDockerServices: () => ({ composeAvailable: true, services: [] }) };
    const app = await buildApp();
    const projectId = await remoteProjectOn(app, "remote2");

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/check-update`,
      payload: { controlId: "docker:sanctuary:web" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("503s (not 404) a per-service action when the agent cannot be reached for discovery", async () => {
    agent.scripted = {};
    const app = await buildApp();
    const projectId = await remoteProjectOn(app, "remote-down");
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/docker/check-update`,
      payload: { controlId: "docker:sanctuary:web" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  describe("a remote stack session's liveness is the agent's, not this host's scope (#3427)", () => {
    async function stackRestart(mode: "alive" | "dead" | "omitted" | "unreachable") {
      agent.scripted = {
        resolveDockerServices: () => ({ composeAvailable: true, services: [service()] }),
        bulkIsMasterAlive: (ids) => {
          if (mode === "unreachable") throw new Error("down");
          if (mode === "omitted") return {};
          return Object.fromEntries((ids as string[]).map((id) => [id, mode === "alive"]));
        },
      };
      const app = await buildApp();
      const projectId = await remoteProjectOn(app, `remote-live-${mode}`);
      const { hostId } = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
      const row = app.db
        .insert(sessions)
        .values({
          projectId,
          hostId,
          command: "docker compose restart",
          kind: "dock",
          status: "active",
          name: `${DOCKER_STACK_SESSION_NAME_PREFIX}sanctuary`,
        })
        .returning()
        .get();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const consulted = agent.calls.some((c) => c.method === "bulkIsMasterAlive");
      await app.close();
      return { res, row, consulted };
    }

    it.each(["alive", "omitted", "unreachable"] as const)(
      "keeps and reuses the session when the agent says %s",
      async (mode) => {
        const { res, row, consulted } = await stackRestart(mode);
        expect(consulted).toBe(true);
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({ sessionId: row.id, reused: true });
      },
    );

    it("does not reuse a session the agent reports dead", async () => {
      const { res, row, consulted } = await stackRestart("dead");
      expect(consulted).toBe(true);
      expect(res.json().sessionId).not.toBe(row.id);
    });
  });
});
