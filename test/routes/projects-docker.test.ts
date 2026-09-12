import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../../src/db/schema.js";

// Issue #73 — GET /api/projects/:id/dock merging in discovered Compose
// services, and the two docker/check-update + docker/update routes.
//
// docker-service-detect.ts's own shell-out logic (parsing, dedupe,
// buildable/pullable/composeResolvable heuristics, shell-quoting) is already
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
  // Issue #1243 — split from a single `buildOnly` boolean; see
  // src/services/docker-service-detect.ts's ComposeService doc comments.
  buildable: boolean;
  pullable: boolean;
  composeResolvable: boolean;
  configFiles: string[];
  envFile: string | null;
  configHash: string;
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
    buildable: false,
    pullable: true,
    composeResolvable: true,
    configFiles: [],
    envFile: null,
    configHash: "hash-current",
    ...overrides,
  };
}

// Mutable fixtures the mocked docker-service-detect module reads from —
// reset in each test that needs a non-default value.
let discoveredServices: FixtureService[] = [];
let pullSucceeds = true;
let latestImageId = "sha256:latest0000000000000000000000000000000000000000000000000000000";
let restartSucceeds = true;
let stopSucceeds = true;
let startSucceeds = true;
// `null` mirrors reconstructConfigHash()'s own "couldn't tell" convention —
// tests that care about willRecreate override this per-case.
let reconstructedHash: string | null = "hash-current";

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
        buildable: s.buildable,
        pullable: s.pullable,
      },
    })),
  ),
  shellQuote: vi.fn((v: string) => `'${v}'`),
  // Mirrors the real composeContextFlags() shape closely enough for the
  // route tests below (which assert on substrings of the resulting
  // command), without re-testing its own formatting — that's
  // test/services/docker-service-detect.test.ts's job.
  composeContextFlags: vi.fn((s: FixtureService) => {
    const envFlag = s.envFile ? `--env-file '${s.envFile}' ` : "";
    const fileFlags = s.configFiles.map((f) => `-f '${f}'`).join(" ");
    return `-p '${s.composeProject}' --project-directory '${s.workingDir}' ${envFlag}${fileFlags}`.trim();
  }),
  pullComposeImageQuietly: vi.fn(async () => pullSucceeds),
  inspectImageId: vi.fn(async () => (pullSucceeds ? latestImageId : null)),
  restartComposeService: vi.fn(async () => restartSucceeds),
  stopComposeService: vi.fn(async () => stopSucceeds),
  startComposeService: vi.fn(async () => startSucceeds),
  reconstructConfigHash: vi.fn(async () => reconstructedHash),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { createKeyedLock } = await import("../../src/routes/projects.js");

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
      discoveredServices = [fixtureService({ buildable: true, pullable: false })];
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

    it("reconstructs the stack's own -f/--env-file flags rather than a bare -p/--project-directory", async () => {
      discoveredServices = [
        fixtureService({
          composeProject: "pocket-portfolio-tracker",
          service: "api",
          containerName: "pocket-portfolio-tracker-api-1",
          workingDir: "/home/user/pocket-portfolio-tracker",
          configFiles: ["/home/user/pocket-portfolio-tracker/docker-compose.prod.yml"],
          envFile: "/home/user/pocket-portfolio-tracker/.env.prod",
        }),
      ];
      const app = await buildApp();
      const projectId = await createProject(app, { cwd: "/home/user/pocket-portfolio-tracker" });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:pocket-portfolio-tracker:api" },
      });
      expect(res.statusCode).toBe(201);
      const command: string = res.json().control.command;
      // One -f per config file, and --env-file, on BOTH halves of the
      // pull-then-up command — a bare -p/--project-directory here would
      // instead resolve whatever default-named compose file happens to sit
      // in workingDir (the reported bug: a dev docker-compose.yml sitting
      // next to this prod one).
      expect(
        command.match(/-f '\/home\/user\/pocket-portfolio-tracker\/docker-compose\.prod\.yml'/g),
      ).toHaveLength(2);
      expect(
        command.match(/--env-file '\/home\/user\/pocket-portfolio-tracker\/\.env\.prod'/g),
      ).toHaveLength(2);

      await app.close();
    });

    it("rejects a build-only service", async () => {
      discoveredServices = [fixtureService({ buildable: true, pullable: false })];
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

    // Issue #1243 — the previously-impossible shape: a service with BOTH a
    // build: key and a real registry image must pass this route's
    // `!pullable` guard (it IS pullable), and separately (test below) the
    // stack/rebuild route's `buildable` guard — the two guards no longer
    // exclude one another the way they did when both read one boolean.
    it("accepts a service that is both buildable and pullable", async () => {
      discoveredServices = [fixtureService({ buildable: true, pullable: true })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);

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

    it("reports willRecreate:true when the on-disk config hash no longer matches the running container's", async () => {
      discoveredServices = [fixtureService({ configHash: "hash-old" })];
      reconstructedHash = "hash-new";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.json().willRecreate).toBe(true);

      reconstructedHash = "hash-current";
      await app.close();
    });

    it("reports willRecreate:false when the on-disk config hash still matches", async () => {
      discoveredServices = [fixtureService({ configHash: "hash-current" })];
      reconstructedHash = "hash-current";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.json().willRecreate).toBe(false);

      await app.close();
    });

    it("reports willRecreate:null (advisory only, never blocks) when the hash can't be reconstructed", async () => {
      discoveredServices = [fixtureService()];
      reconstructedHash = null;
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().willRecreate).toBeNull();

      reconstructedHash = "hash-current";
      await app.close();
    });

    it("reports willRecreate:null (not a spurious true) when the recorded config-hash label was never set", async () => {
      // Hermes review — a container predating the config-hash label (or
      // whose docker/compose version never sets it) has configHash:"",
      // which is trivially !== any real reconstructed hash. That must read
      // as "can't tell," not "yes, will recreate."
      discoveredServices = [fixtureService({ configHash: "" })];
      reconstructedHash = "some-real-hash";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().willRecreate).toBeNull();

      reconstructedHash = "hash-current";
      await app.close();
    });
  });

  describe("POST /api/projects/:id/docker/service/{restart,stop,start}", () => {
    const cases: Array<{
      path: string;
      flag: "restartSucceeds" | "stopSucceeds" | "startSucceeds";
    }> = [
      { path: "restart", flag: "restartSucceeds" },
      { path: "stop", flag: "stopSucceeds" },
      { path: "start", flag: "startSucceeds" },
    ];

    for (const { path: actionPath, flag } of cases) {
      it(`${actionPath}: returns {success:true} and forces a discovery refresh on success`, async () => {
        discoveredServices = [fixtureService()];
        if (flag === "restartSucceeds") restartSucceeds = true;
        if (flag === "stopSucceeds") stopSucceeds = true;
        if (flag === "startSucceeds") startSucceeds = true;
        const app = await buildApp();
        const projectId = await createProject(app);

        const { getComposeServices } = await import("../../src/services/docker-service-detect.js");
        vi.mocked(getComposeServices).mockClear();

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/service/${actionPath}`,
          payload: { controlId: "docker:sanctuary:web" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });
        expect(vi.mocked(getComposeServices)).toHaveBeenCalledWith(true);

        await app.close();
      });

      it(`${actionPath}: returns {success:false} without forcing a refresh when the action fails`, async () => {
        discoveredServices = [fixtureService()];
        if (flag === "restartSucceeds") restartSucceeds = false;
        if (flag === "stopSucceeds") stopSucceeds = false;
        if (flag === "startSucceeds") startSucceeds = false;
        const app = await buildApp();
        const projectId = await createProject(app);

        const { getComposeServices } = await import("../../src/services/docker-service-detect.js");
        vi.mocked(getComposeServices).mockClear();

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/service/${actionPath}`,
          payload: { controlId: "docker:sanctuary:web" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: false });
        expect(vi.mocked(getComposeServices)).not.toHaveBeenCalledWith(true);

        restartSucceeds = true;
        stopSucceeds = true;
        startSucceeds = true;
        await app.close();
      });

      it(`${actionPath}: 404s for a controlId not owned by this project`, async () => {
        discoveredServices = [fixtureService()];
        const app = await buildApp();
        const projectId = await createProject(app);

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/service/${actionPath}`,
          payload: { controlId: "docker:some-other-project:web" },
        });
        expect(res.statusCode).toBe(404);

        await app.close();
      });
    }
  });

  describe("POST /api/projects/:id/docker/stack/{restart,apply,stop}", () => {
    const cases = [
      { path: "restart", idPrefix: "docker-restart", titlePrefix: "Restart" },
      { path: "apply", idPrefix: "docker-apply", titlePrefix: "Apply config" },
      { path: "stop", idPrefix: "docker-stop", titlePrefix: "Stop" },
    ];

    for (const { path: actionPath, idPrefix, titlePrefix } of cases) {
      it(`${actionPath}: spawns a kind:dock session and returns an ephemeral control`, async () => {
        discoveredServices = [fixtureService()];
        const app = await buildApp();
        const projectId = await createProject(app);

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/stack/${actionPath}`,
          payload: { controlId: "docker:sanctuary:web" },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(typeof body.sessionId).toBe("number");
        expect(body.control).toMatchObject({
          id: `${idPrefix}:sanctuary`,
          title: `${titlePrefix} sanctuary`,
          source: "docker",
        });

        await app.close();
      });

      it(`${actionPath}: 404s for a controlId not owned by this project`, async () => {
        discoveredServices = [fixtureService()];
        const app = await buildApp();
        const projectId = await createProject(app);

        const res = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/stack/${actionPath}`,
          payload: { controlId: "docker:some-other-project:web" },
        });
        expect(res.statusCode).toBe(404);

        await app.close();
      });
    }

    it("restart: command has no -f/--env-file... it's a bare compose restart on the reconstructed context", async () => {
      discoveredServices = [
        fixtureService({ configFiles: ["/home/user/sanctuary/docker-compose.yml"] }),
      ];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const command: string = res.json().control.command;
      expect(command).toContain("restart");
      expect(command).not.toContain("up -d");
      expect(command).not.toContain("pull");

      await app.close();
    });

    it("apply: command runs `up -d` and reports willRecreate", async () => {
      discoveredServices = [fixtureService({ configHash: "hash-old" })];
      reconstructedHash = "hash-new";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/apply`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const body = res.json();
      expect(body.control.command).toContain("up -d");
      expect(body.control.command).not.toContain("pull");
      expect(body.willRecreate).toBe(true);

      reconstructedHash = "hash-current";
      await app.close();
    });
  });

  describe("POST /api/projects/:id/docker/stack/rebuild", () => {
    it("spawns a build+up session and reports willRecreate for a build-only service", async () => {
      discoveredServices = [
        fixtureService({ buildable: true, pullable: false, configHash: "hash-old" }),
      ];
      reconstructedHash = "hash-new";
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/rebuild`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.control).toMatchObject({ id: "docker-rebuild:sanctuary", source: "docker" });
      expect(body.control.command).toContain("build --pull");
      expect(body.control.command).toContain("up -d");
      expect(body.willRecreate).toBe(true);

      reconstructedHash = "hash-current";
      await app.close();
    });

    it("rejects a service that has a registry image (use pull-restart instead)", async () => {
      discoveredServices = [fixtureService({ buildable: false, pullable: true })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/rebuild`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(400);

      await app.close();
    });

    it("404s for a controlId not owned by this project", async () => {
      discoveredServices = [fixtureService({ buildable: true, pullable: false })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/rebuild`,
        payload: { controlId: "docker:some-other-project:web" },
      });
      expect(res.statusCode).toBe(404);

      await app.close();
    });

    // Issue #1243 — the mirror-image guard now reads `buildable`, not the
    // inverse of the pull route's `pullable` guard, so a service with BOTH
    // facts true passes here too (paired with the same-shape test in
    // docker/update above — together they pin that neither route can ever
    // 400 the other's representative for this shape, per docs/dock.md's
    // "independently gated" guarantee).
    it("accepts a service that is both buildable and pullable", async () => {
      discoveredServices = [fixtureService({ buildable: true, pullable: true })];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/rebuild`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(res.statusCode).toBe(201);

      await app.close();
    });
  });

  // Issue #73 follow-up plan (5a) — the five stack-wide action ids
  // (docker-update, docker-restart, docker-apply, docker-rebuild,
  // docker-stop) previously had no shared concept of "already running on
  // this stack": command-string comparison alone can't catch a second
  // action clicked mid-run, since each of the five runs a DIFFERENT
  // command. Refused by keying every stack-wide session on the compose
  // project instead.
  describe("stack-wide action session identity (issue #73 follow-up, 5a)", () => {
    it("a second stack action on the SAME compose project reuses the first session rather than starting a concurrent one", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);
      const projectId = await createProject(app);

      const first = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/apply`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();
      expect(firstBody.reused).toBeUndefined();

      // A DIFFERENT action (restart, not apply) on the same stack while
      // the first is still active — command-string matching would never
      // catch this, since "restart" and "up -d" share no substring.
      const second = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(second.statusCode).toBe(201);
      const secondBody = second.json();
      expect(secondBody.sessionId).toBe(firstBody.sessionId);
      expect(secondBody.reused).toBe(true);

      // Exactly one kind:dock session exists for this stack, not two.
      const sessionsRes = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}&kind=dock`,
      });
      expect(sessionsRes.json()).toHaveLength(1);

      await app.close();
    });

    // Issue #1182, integration-level sanity check — the actual regression
    // guard for the race itself is createKeyedLock's own deterministic unit
    // tests at the bottom of this file, not this test. The check-then-create
    // race (findActiveStackSession's select, then createSessionRecord's
    // insert) is a single-microtask-wide window in a synchronous-SQLite
    // codebase; two `app.inject()` calls racing under `Promise.all` don't
    // reliably land in it (Hermes review, PR #1182: this test passed on one
    // host even with the fix fully reverted, because the two requests never
    // actually interleaved there). What this test DOES still verify, deter
    // -ministically: the wiring is correct end-to-end — the route handler
    // actually calls through withStackLock with the right key, and the
    // observable contract (one session, one `reused: true`) holds under
    // ordinary concurrent load, not just sequential load (the neighboring
    // test above).
    it("two CONCURRENT stack actions on the same compose project resolve to exactly one created session", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);
      const projectId = await createProject(app);

      const [apply, restart] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/stack/apply`,
          payload: { controlId: "docker:sanctuary:web" },
        }),
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/docker/stack/restart`,
          payload: { controlId: "docker:sanctuary:web" },
        }),
      ]);

      expect(apply.statusCode).toBe(201);
      expect(restart.statusCode).toBe(201);
      const applyBody = apply.json();
      const restartBody = restart.json();

      // Exactly one of the two started a fresh session; the other reused it.
      const reusedCount = [applyBody.reused, restartBody.reused].filter((r) => r === true).length;
      expect(reusedCount).toBe(1);
      expect(applyBody.sessionId).toBe(restartBody.sessionId);

      const sessionsRes = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}&kind=dock`,
      });
      expect(sessionsRes.json()).toHaveLength(1);

      await app.close();
    });

    it("the docker/update route (pull-and-restart) shares the SAME identity as the four stack/* routes", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);
      const projectId = await createProject(app);

      const update = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(update.statusCode).toBe(201);
      const updateBody = update.json();

      const restart = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const restartBody = restart.json();
      expect(restartBody.sessionId).toBe(updateBody.sessionId);
      expect(restartBody.reused).toBe(true);

      await app.close();
    });

    it("stack actions on DIFFERENT compose projects never block each other", async () => {
      discoveredServices = [
        fixtureService(),
        fixtureService({
          composeProject: "pocket-dev",
          service: "api",
          containerName: "pocket-dev-api",
          workingDir: "/home/user/sanctuary",
        }),
      ];
      const app = await buildApp();
      const projectId = await createProject(app);

      const web = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const api = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:pocket-dev:api" },
      });
      expect(api.json().reused).toBeUndefined();
      expect(api.json().sessionId).not.toBe(web.json().sessionId);

      await app.close();
    });

    it("starts a genuinely new session once the reused one's DB row is no longer active", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const first = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/apply`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const firstSessionId = first.json().sessionId;

      app.db
        .update(sessions)
        .set({ status: "exited" })
        .where(eq(sessions.id, firstSessionId))
        .run();

      const second = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(second.json().reused).toBeUndefined();
      expect(second.json().sessionId).not.toBe(firstSessionId);

      await app.close();
    });

    it("starts a genuinely new session when the reused one's PROCESS has already died, even if the DB row is still 'active' (Hermes review)", async () => {
      // The real gap this covers: `sessions.status` records INTENT, not
      // live process state (AGENTS.md) — a `docker compose` process that
      // finished on its own (the common case) isn't reflected in the DB
      // until session-reconciler.ts's own periodic sweep next runs, which
      // can lag by up to its configured interval (5s-1h). The DB-flip test
      // above only proves the SQL predicate excludes non-active rows; it
      // never exercises this window, since it flips the row itself. Here
      // the row is left `status: "active"` — only the underlying systemd
      // scope is reported dead — so this only passes if
      // findActiveStackSession cross-checks `app.pty.isMasterAlive`, not
      // the DB column alone. Spied directly (mockMasterAlive's own pattern,
      // test/services/session-reconciler.test.ts) rather than routed
      // through the mocked node-pty/child_process spawns — isMasterAlive
      // shells out to `systemctl` independently of anything those mocks
      // control, so a real dead-vs-alive distinction has to be injected at
      // this layer, the same way the reconciler's own tests do it.
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const isMasterAlive = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(true);
      const projectId = await createProject(app);

      const first = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/apply`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      const firstSessionId = first.json().sessionId;

      // The compose command itself finished — the real systemd scope is
      // gone, but nothing tells the DB row about it yet.
      isMasterAlive.mockResolvedValue(false);

      const second = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(second.json().reused).toBeUndefined();
      expect(second.json().sessionId).not.toBe(firstSessionId);

      await app.close();
    });

    it("never leaks the internal ok:true discriminant onto the wire (Hermes review)", async () => {
      // `startStackSession`'s success variant is `{ ok: true, sessionId,
      // control, reused? }` — spreading (or sending) it directly onto the
      // reply would leak `ok` as a stray field none of the three response
      // consumers (frontend/mcp/cli) have any use for. Two DIFFERENT
      // compose projects (not two calls on the SAME one) so neither
      // request ever reaches findActiveStackSession's isMasterAlive check
      // — this file's own node:child_process mock only ever fires `exit`,
      // never `close`, which is what a real isMasterAlive call waits on
      // (see session-reconciler.test.ts's own comment on the identical
      // gotcha) and would hang the request for the test's full timeout.
      discoveredServices = [
        fixtureService(),
        fixtureService({
          composeProject: "pocket-dev",
          service: "api",
          containerName: "pocket-dev-api",
          workingDir: "/home/user/sanctuary",
        }),
      ];
      const app = await buildApp();
      const projectId = await createProject(app);

      // No willRecreate (restart/stop's own response shape).
      const restart = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });
      expect(restart.json()).not.toHaveProperty("ok");

      // With willRecreate (apply/rebuild/update's own response shape) — a
      // DIFFERENT compose project, so this is still a fresh create, not a
      // reuse check.
      const update = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/update`,
        payload: { controlId: "docker:pocket-dev:api" },
      });
      expect(update.json()).not.toHaveProperty("ok");

      await app.close();
    });

    it("the created session is named docker-stack:<composeProject> and name-locked", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });

      const sessionsRes = await app.inject({
        method: "GET",
        url: `/api/sessions?projectId=${projectId}&kind=dock`,
      });
      expect(sessionsRes.json()).toEqual([
        expect.objectContaining({
          id: res.json().sessionId,
          name: "docker-stack:sanctuary",
          nameLocked: true,
        }),
      ]);

      await app.close();
    });

    it("dock log-streaming resize fix, issue #1112 — the ephemeral control carries composeProject as a real field", async () => {
      // Without this, the frontend has to parse `<actionId>:<composeProject>`
      // back out of the control's own `id` (dockHelpers.ts's
      // EPHEMERAL_STACK_ACTION_PREFIXES) — and a control reconstructed from
      // a live `docker-stack:<composeProject>` session after a workspace
      // switch (Dock.tsx) has no actionId to parse an id like that from in
      // the first place, so it would land in groupDockerControls'
      // `ungrouped` instead of grouping with its own stack.
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });

      expect(res.json().control).toEqual(expect.objectContaining({ composeProject: "sanctuary" }));

      await app.close();
    });
  });

  // Issue #1223 — sessions_stack_identity_unique (schema.ts) is a DB-level,
  // defense-in-depth guard for the SAME identity withStackLock already
  // serializes within one process. It only ever fires when a conflicting
  // `docker-stack:<composeProject>` row was created OUTSIDE this process's
  // own lock — modeled here by inserting the conflicting row directly,
  // bypassing withStackLock/createSessionRecord entirely, the same way a
  // second backend process (or a hypothetical future `kind: "dock"` insert
  // that bypasses the lock) would leave one behind. isMasterAlive is spied
  // directly rather than routed through the mocked node-pty/child_process
  // spawns for the same reason the neighboring describe block above does
  // (see its "never leaks the internal ok:true discriminant" test) — this
  // file's own node:child_process mock only ever fires `exit`, never
  // `close`, which is what a real isMasterAlive call waits on
  // (session-reconciler.test.ts's own documented fix for the identical
  // gotcha).
  describe("DB-level stack-identity guard, out-of-lock duplicate (issue #1223)", () => {
    function insertActiveStackRow(app: Awaited<ReturnType<typeof buildApp>>, projectId: number) {
      const [row] = app.db
        .insert(sessions)
        .values({
          projectId,
          command: "docker compose -p sanctuary up -d",
          kind: "dock",
          status: "active",
          name: "docker-stack:sanctuary",
          nameLocked: true,
        })
        .returning()
        .all();
      return row;
    }

    it("reconciles a stale out-of-lock duplicate: flips it to exited, retries, and starts a NEW session", async () => {
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      // Simulates a second process (or any caller bypassing withStackLock)
      // having already created this stack's session — not through
      // startStackSession, so this row's existence has nothing to do with
      // this process's own mutex.
      const staleRow = insertActiveStackRow(app, projectId);

      // The row's process has actually exited — this is the exact case
      // this issue exists to tolerate, not reject.
      const isMasterAlive = vi.spyOn(app.pty, "isMasterAlive").mockResolvedValue(false);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.reused).toBeUndefined();
      expect(body.sessionId).not.toBe(staleRow.id);

      // The stale row itself must be flipped, not deleted — it's session
      // history, same posture as session-reconciler.ts's own sweep.
      const [flipped] = app.db.select().from(sessions).where(eq(sessions.id, staleRow.id)).all();
      expect(flipped?.status).toBe("exited");

      // Exactly one ACTIVE docker-stack session for this project now.
      const activeStackSessions = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projectId))
        .all()
        .filter((s) => s.name === "docker-stack:sanctuary" && s.status === "active");
      expect(activeStackSessions).toHaveLength(1);
      expect(activeStackSessions[0]?.id).toBe(body.sessionId);

      expect(isMasterAlive).toHaveBeenCalled();
      await app.close();
    });

    it("an out-of-lock duplicate whose process is genuinely still alive is reused via the conflict handler, no thrown error", async () => {
      // Deliberately does NOT mock isMasterAlive to a constant `true` —
      // that would let findActiveStackSession's own pre-existing check
      // short-circuit before createSessionRecord is ever called, leaving
      // this test's namesake code path (the NEW conflict handler in
      // startStackSession, added by this issue) completely unexercised.
      // Ordering is the only lever available to target it, since both
      // calls query the same row id: findActiveStackSession's own call is
      // always the FIRST isMasterAlive call inside withStackLock (it's the
      // first thing the callback does) — answer that `false` so it treats
      // the row as dead and falls through to the insert, which then hits
      // sessions_stack_identity_unique; only the conflict handler's own
      // (second) call answers `true`, confirming the row is genuinely
      // alive after all.
      discoveredServices = [fixtureService()];
      const app = await buildApp();
      const projectId = await createProject(app);

      const staleRow = insertActiveStackRow(app, projectId);
      const isMasterAlive = vi
        .spyOn(app.pty, "isMasterAlive")
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/docker/stack/restart`,
        payload: { controlId: "docker:sanctuary:web" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.reused).toBe(true);
      expect(body.sessionId).toBe(staleRow.id);

      // Both calls target the SAME row id — the only way to tell "reused
      // via findActiveStackSession's short-circuit" (one call) apart from
      // "reused via the conflict handler" (two calls) is this count.
      expect(isMasterAlive).toHaveBeenCalledTimes(2);
      expect(isMasterAlive).toHaveBeenNthCalledWith(1, String(staleRow.id));
      expect(isMasterAlive).toHaveBeenNthCalledWith(2, String(staleRow.id));

      // Untouched — it really is the live, correct session, not flipped.
      const [row] = app.db.select().from(sessions).where(eq(sessions.id, staleRow.id)).all();
      expect(row?.status).toBe("active");

      // No second row was created for this identity.
      const stackRows = app.db
        .select()
        .from(sessions)
        .where(eq(sessions.projectId, projectId))
        .all()
        .filter((s) => s.name === "docker-stack:sanctuary");
      expect(stackRows).toHaveLength(1);

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Issue #1182 — createKeyedLock is the actual mutex startStackSession
// wraps its check-then-create in. Tested directly, with fully controlled
// promises, rather than only through two racing `app.inject()` calls
// (the "two CONCURRENT stack actions..." test above): the real race
// window this closes is a single-microtask-wide gap in a
// synchronous-SQLite codebase, and Hermes review on PR #1182 found that
// window doesn't reliably get hit by two HTTP-level requests under
// `Promise.all` — on one host, that test passed even with the fix fully
// reverted, because the two requests simply never interleaved. These
// tests can't have that problem: they control every scheduling point
// directly, so they fail deterministically if createKeyedLock's
// serialization guarantee ever regresses, on any host.
describe("createKeyedLock (issue #1182)", () => {
  it("serializes two calls for the same key — the second's fn does not start until the first's fn has settled", async () => {
    const withLock = createKeyedLock();
    const order: string[] = [];
    const gate = deferred<void>();

    const callA = withLock("k", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
      return "a";
    });

    // Let callA's fn actually begin (it's scheduled via a promise chain,
    // not invoked synchronously) before starting callB, so the assertion
    // below proves callB's fn genuinely waits — not merely "hasn't been
    // scheduled yet regardless of the lock".
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);

    const callB = withLock("k", async () => {
      order.push("b-start");
      return "b";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]); // b's fn has NOT started — a still holds the lock

    gate.resolve();
    expect(await callA).toBe("a");
    expect(await callB).toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("runs calls for DIFFERENT keys concurrently, not serialized", async () => {
    const withLock = createKeyedLock();
    const order: string[] = [];
    const gate = deferred<void>();

    const callA = withLock("key-a", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const callB = withLock("key-b", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await callB;
    // b ran to completion without ever waiting on a's still-pending gate.
    expect(order).toEqual(["a-start", "b-start", "b-end"]);

    gate.resolve();
    await callA;
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("a rejected call does not wedge the lock for the next caller of the same key", async () => {
    const withLock = createKeyedLock();

    const failing = withLock("k", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    const next = await withLock("k", async () => "ok");
    expect(next).toBe("ok");
  });

  it("the second caller's fn genuinely re-runs — it is not handed the first caller's result", async () => {
    const withLock = createKeyedLock();
    let calls = 0;

    const a = await withLock("k", async () => {
      calls++;
      return calls;
    });
    const b = await withLock("k", async () => {
      calls++;
      return calls;
    });

    expect(a).toBe(1);
    // A coalescing cache (the shape git-status.ts/docker-service-detect.ts
    // use elsewhere) would have handed b the SAME result as a — 1, not 2 —
    // which is exactly wrong for startStackSession's `reused: true` contract.
    expect(b).toBe(2);
  });
});
