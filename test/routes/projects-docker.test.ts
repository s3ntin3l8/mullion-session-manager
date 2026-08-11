import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { projects } from "../../src/db/schema.js";

// Issue #73 — GET /api/projects/:id/dock merging in discovered Compose
// services, and the two docker/check-update + docker/update routes.
//
// docker-service-detect.ts's own shell-out logic (parsing, dedupe,
// buildOnly/composeResolvable heuristics, shell-quoting) is already
// exhaustively covered by test/services/docker-service-detect.test.ts — this
// file mocks that whole module with controllable fixtures so it can focus on
// the ROUTE layer: merge order, manual-override-wins, the local/remote host
// branch, the controlId lookup guard, and createSessionRecord wiring.
//
// Session creation (the /docker/update route) spawns real OS processes
// (systemd-run, dtach) via PtyManager — faked the same way
// test/routes/sessions.test.ts fakes them, so this exercises the route/DB
// layer without depending on a real systemd --user session in CI.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

interface FixtureService {
  composeProject: string;
  service: string;
  containerName: string;
  workingDir: string;
  state: string;
  status: string;
  imageRef: string;
  imageId: string;
  buildOnly: boolean;
  composeResolvable: boolean;
}

function fixtureService(overrides: Partial<FixtureService> = {}): FixtureService {
  return {
    composeProject: "sanctuary",
    service: "web",
    containerName: "sanctuary-web",
    workingDir: "/home/user/sanctuary",
    state: "running",
    status: "Up 6 days",
    imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
    imageId: "sha256:current00000000000000000000000000000000000000000000000000000",
    buildOnly: false,
    composeResolvable: true,
    ...overrides,
  };
}

// Mutable fixtures the mocked docker-service-detect module reads from —
// reset in each test that needs a non-default value.
let discoveredServices: FixtureService[] = [];
let pullSucceeds = true;
let latestImageId = "sha256:latest0000000000000000000000000000000000000000000000000000000";

vi.mock("../../src/services/docker-service-detect.js", () => ({
  getComposeServices: vi.fn(async () => discoveredServices),
  mapServicesToProject: vi.fn((services: FixtureService[], projectCwd: string) =>
    services.filter(
      (s) => s.workingDir === projectCwd || s.workingDir.startsWith(`${projectCwd}/`),
    ),
  ),
  toDockControls: vi.fn(async (services: FixtureService[]) =>
    services.map((s) => ({
      id: `docker:${s.composeProject}:${s.service}`,
      title: s.service,
      command: `docker compose -p '${s.composeProject}' --project-directory '${s.workingDir}' logs -f --tail=200 '${s.service}'`,
      source: "docker" as const,
      docker: {
        composeProject: s.composeProject,
        service: s.service,
        containerName: s.containerName,
        state: s.state,
        status: s.status,
        imageRef: s.imageRef,
        imageId: s.imageId,
        buildOnly: s.buildOnly,
      },
    })),
  ),
  shellQuote: vi.fn((v: string) => `'${v}'`),
  pullComposeImageQuietly: vi.fn(async () => pullSucceeds),
  inspectImageId: vi.fn(async () => (pullSucceeds ? latestImageId : null)),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");

const tmpDb = path.join(os.tmpdir(), `projects-docker-test-${process.pid}.db`);

function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `projects-docker-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

describe("projects route — Docker Compose service discovery (issue #73)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  // Inserted directly into the DB rather than via POST /api/projects: this
  // file's own default cwd ("/home/user/sanctuary") is a fictional path that
  // matches fixtureService()'s default workingDir for the mocked
  // docker-service-detect module — it was never meant to exist on disk (this
  // file mocks that whole module, see the header comment), and POST
  // /api/projects now requires a real, existing directory. Matches the
  // direct-insert precedent in webhooks.test.ts for the same reason.
  function createProject(
    app: Awaited<ReturnType<typeof buildApp>>,
    overrides: { cwd?: string; hostId?: string } = {},
  ): number {
    const [row] = app.db
      .insert(projects)
      .values({
        name: "p",
        cwd: overrides.cwd ?? "/home/user/sanctuary",
        ...(overrides.hostId ? { hostId: overrides.hostId } : {}),
      })
      .returning()
      .all();
    return row.id;
  }

  describe("GET /api/projects/:id/dock", () => {
    it("merges discovered Docker services under configured dock.json controls", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        expect.objectContaining({ id: "docker:sanctuary:web", source: "docker" }),
      ]);

      await app.close();
    });

    it("a manual dock.json control with the same id overrides the discovered one", async () => {
      discoveredServices = [fixtureService()];
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "projects-docker-config-"));
      const previousConfigDir = process.env.CRS_CONFIG_DIR;
      process.env.CRS_CONFIG_DIR = configDir;

      const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-docker-repo-"));
      fs.mkdirSync(path.join(projectCwd, ".crs"));
      fs.writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({
          controls: [
            { id: "docker:sanctuary:web", title: "Web (custom)", command: "tail -f custom.log" },
          ],
        }),
      );
      discoveredServices = [fixtureService({ workingDir: projectCwd })];

      const app = await buildApp();
      const projectId = await createProject(app, { cwd: projectCwd });

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(res.json()).toEqual([
        expect.objectContaining({
          id: "docker:sanctuary:web",
          title: "Web (custom)",
          command: "tail -f custom.log",
        }),
      ]);
      // The manual control must not carry the discovered source/docker fields.
      expect(res.json()[0].source).toBeUndefined();

      await app.close();
      process.env.CRS_CONFIG_DIR = previousConfigDir;
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(projectCwd, { recursive: true, force: true });
    });

    it("a remote-host project never sees discovered Docker controls", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();

      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = hostRes.json().id as string;
      const projectId = await createProject(app, { cwd: "/remote/path", hostId });

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      // Unreachable remote host -> 503, same as today's behavior; the point
      // being asserted is that this path never even calls into docker
      // discovery (getComposeServices' mock isn't consulted for host !==
      // LOCAL_HOST_ID at all — see the route's early branch).
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("settings.dock.dockerServices=false suppresses all discovered controls", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const patch = await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: false } },
      });
      expect(patch.statusCode).toBe(200);

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(res.json()).toEqual([]);

      // Restore for subsequent tests in this file.
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: true } },
      });
      await app.close();
    });
  });

  describe("POST /api/projects/:id/docker/check-update", () => {
    it("reports updateAvailable when the freshly-pulled image id differs", async () => {
      discoveredServices = [fixtureService()];
      pullSucceeds = true;
      latestImageId = "sha256:different000000000000000000000000000000000000000000000000000";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        updateAvailable: true,
        latestImageId,
        imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
      });

      await app.close();
    });

    it("reports updateAvailable:false when the image id is unchanged", async () => {
      discoveredServices = [fixtureService()];
      pullSucceeds = true;
      latestImageId = fixtureService().imageId;
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.json()).toMatchObject({ updateAvailable: false });
      expect(res.json().reason).toBeUndefined();

      await app.close();
    });

    it("returns reason:'build-only' without attempting a pull", async () => {
      discoveredServices = [fixtureService({ buildOnly: true })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ updateAvailable: false, reason: "build-only" });

      await app.close();
    });

    it("returns reason:'pull-failed' (200, not 5xx) when the pull fails", async () => {
      discoveredServices = [fixtureService()];
      pullSucceeds = false;
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ updateAvailable: false, reason: "pull-failed" });

      await app.close();
    });

    it("404s for a controlId not owned by this project", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:some-other-project:web" },
      });
      expect(res.statusCode).toBe(404);

      await app.close();
    });

    it("rejects a non-local project", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "remote2", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = hostRes.json().id as string;
      const projectId = await createProject(app, { cwd: "/remote/path", hostId });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("400s on a missing controlId rather than 500ing", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("404s (a true kill-switch, not just visibility) when dockerServices is off, even for a valid controlId", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: false } },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/check-update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(404);

      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: true } },
      });
      await app.close();
    });
  });

  describe("POST /api/projects/:id/docker/update", () => {
    it("spawns a kind:dock session with the pull+up command and returns an ephemeral control", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(typeof body.sessionId).toBe("number");
      expect(body.control).toMatchObject({
        id: "docker-update:sanctuary",
        title: "Update sanctuary",
        source: "docker",
      });
      expect(body.control.command).toContain("pull");
      expect(body.control.command).toContain("up -d");
      // Distinct from the logs command, so Dock.tsx's command-based session
      // matching can never confuse an update run with a log stream.
      expect(body.control.command).not.toContain("logs -f");

      const sessionRes = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}&kind=dock`,
      });
      expect(sessionRes.json()).toEqual([
        expect.objectContaining({
          id: body.sessionId,
          command: body.control.command,
          kind: "dock",
        }),
      ]);

      await app.close();
    });

    it("rejects a build-only service", async () => {
      discoveredServices = [fixtureService({ buildOnly: true })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("404s for a controlId not owned by this project", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:some-other-project:web" },
      });
      expect(res.statusCode).toBe(404);

      await app.close();
    });

    it("400s on a missing controlId rather than 500ing", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("404s (a true kill-switch, not just visibility) when dockerServices is off, even for a valid controlId", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: false } },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(404);

      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { dock: { dockerServices: true } },
      });
      await app.close();
    });
  });

  // Full remote-host round-trip, same pattern as test/routes/projects.test.ts
  // — confirms the dock route's remote branch is untouched by issue #73 (no
  // docker fields leak into a remote host's response) end to end, not just
  // via the unreachable-host 503 case above.
  describe("remote host round-trip", () => {
    it("a remote host's own /internal/dock response is returned verbatim, with no docker merge applied", async () => {
      discoveredServices = [fixtureService()];
      const AGENT_TOKEN = "test-agent-token";
      const agentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "projects-docker-agent-repo-"));
      fs.mkdirSync(path.join(agentCwd, ".crs"));
      fs.writeFileSync(
        path.join(agentCwd, ".crs", "dock.json"),
        JSON.stringify({
          controls: [{ id: "remote-logs", title: "Remote logs", command: "tail -f x" }],
        }),
      );

      // Same env swap-and-restore pattern as test/routes/projects.test.ts's
      // own full remote round-trip test — `process.env[key] = undefined`
      // coerces to the STRING "undefined" rather than deleting the key, so
      // restoring a previously-unset var must `delete`, not reassign.
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      const prevEnv: Record<string, string | undefined> = {};
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
      const agentPort = typeof address === "object" && address ? address.port : 0;

      const app = await buildApp();
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: "real-remote",
          baseUrl: `http://127.0.0.1:${agentPort}`,
          token: AGENT_TOKEN,
        },
      });
      const hostId = hostRes.json().id as string;
      const projectId = await createProject(app, { cwd: agentCwd, hostId });

      const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/dock` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        expect.objectContaining({ id: "remote-logs", title: "Remote logs" }),
      ]);
      expect(res.json().some((c: { id: string }) => c.id.startsWith("docker:"))).toBe(false);

      await app.close();
      await agentApp.close();
      fs.rmSync(agentCwd, { recursive: true, force: true });
    });
  });
});
