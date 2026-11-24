import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
} from "../helpers/internal-routes.js";
import path from "node:path";

// Issue #3427 — the agent's Docker discovery, compose actions and dev-server
// port routes, reached through app.inject() on the real internal routes.
const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());

const docker = vi.hoisted(() => ({
  services: [] as Record<string, unknown>[],
  composeAvailable: true,
  restart: vi.fn(async () => true),
  pull: vi.fn(async () => true),
}));
vi.mock("../../src/services/docker-service-detect.js", () => ({
  getComposeServices: vi.fn(async () => docker.services),
  isDockerComposeAvailable: vi.fn(async () => docker.composeAvailable),
  restartComposeService: docker.restart,
  stopComposeService: vi.fn(async () => false),
  startComposeService: vi.fn(async () => true),
  pullComposeImageQuietly: docker.pull,
  inspectImageId: vi.fn(async () => "sha256:new"),
  reconstructConfigHash: vi.fn(async () => "hash-b"),
}));

const { buildApp } = await import("../../src/app.js");

const headers = { authorization: `Bearer ${INTERNAL_TEST_TOKEN}` };

function service(workingDir: string, overrides: Record<string, unknown> = {}) {
  return {
    composeProject: "stack",
    service: "web",
    containerName: "stack-web",
    workingDir,
    state: "running",
    status: "Up",
    imageRef: "nginx:1",
    imageId: "sha256:old",
    buildable: false,
    pullable: true,
    composeResolvable: true,
    configFiles: [],
    envFile: null,
    configHash: "hash-a",
    ...overrides,
  };
}

describe("agent docker routes (#3427)", () => {
  const env = createInternalAgentEnv();
  let root: string;
  beforeAll(() => {
    env.setup();
    root = env.projectsRoot;
  });
  afterAll(() => env.teardown());
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    docker.services = [];
    docker.composeAvailable = true;
    docker.restart.mockClear();
    docker.pull.mockClear();
  });

  async function call(
    method: "GET" | "POST",
    url: string,
    payload?: object,
    setup?: (app: Awaited<ReturnType<typeof buildApp>>) => void,
  ) {
    const app = await buildApp();
    setup?.(app);
    const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    await app.close();
    return res;
  }

  it("lists only the services under the asked cwd, with the host's compose availability", async () => {
    const proj = path.join(root, "proj");
    docker.services = [
      service(proj),
      service(path.join(proj, "sub"), { service: "db" }),
      service(path.join(root, "proj-sibling"), { service: "no" }),
    ];
    const res = await call("GET", `/internal/docker-services?cwd=${encodeURIComponent(proj)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.composeAvailable).toBe(true);
    expect(body.services.map((s: { service: string }) => s.service)).toEqual(["web", "db"]);
  });

  it("answers an empty list for an agent without Docker", async () => {
    docker.composeAvailable = false;
    const res = await call("GET", `/internal/docker-services?cwd=${encodeURIComponent(root)}`);
    expect(res.json()).toEqual({ services: [], composeAvailable: false });
  });

  it("refuses a cwd outside the roots and a missing cwd", async () => {
    expect((await call("GET", "/internal/docker-services?cwd=/etc")).statusCode).toBe(400);
    expect((await call("GET", "/internal/docker-services")).statusCode).toBe(400);
  });

  it("runs lifecycle, check-update and will-recreate on the service it re-resolves itself", async () => {
    const proj = path.join(root, "proj");
    docker.services = [service(proj)];
    const body = (action: string) => ({
      cwd: proj,
      composeProject: "stack",
      service: "web",
      action,
    });
    const restart = await call("POST", "/internal/docker-compose-action", body("restart"));
    expect(restart.json()).toEqual({ success: true });
    expect(docker.restart).toHaveBeenCalledTimes(1);
    const stop = await call("POST", "/internal/docker-compose-action", body("stop"));
    expect(stop.json()).toEqual({ success: false });
    const check = await call("POST", "/internal/docker-compose-action", body("check-update"));
    expect(check.json()).toMatchObject({ updateAvailable: true, latestImageId: "sha256:new" });
    const recreate = await call("POST", "/internal/docker-compose-action", body("will-recreate"));
    expect(recreate.json()).toEqual({ willRecreate: true });
  });

  it("404s a service not under the cwd, and 400s an unknown action or a cwd outside the roots", async () => {
    docker.services = [service(path.join(root, "other"))];
    const base = { cwd: path.join(root, "proj"), composeProject: "stack", service: "web" };
    expect(
      (await call("POST", "/internal/docker-compose-action", { ...base, action: "restart" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call("POST", "/internal/docker-compose-action", { ...base, action: "down" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call("POST", "/internal/docker-compose-action", {
          ...base,
          cwd: "/etc",
          action: "restart",
        })
      ).statusCode,
    ).toBe(400);
    expect(docker.restart).not.toHaveBeenCalled();
  });

  it("answers the dev-server port a listed session announced, or null", async () => {
    const withBanner = (app: Awaited<ReturnType<typeof buildApp>>) =>
      vi
        .spyOn(app.pty, "get")
        .mockImplementation(
          (id: string) =>
            (id === "7"
              ? { getScrollback: () => Buffer.from("  Local: http://localhost:5173/\n") }
              : undefined) as ReturnType<typeof app.pty.get>,
        );
    const hit = await call(
      "GET",
      "/internal/dev-server-port?sessionIds=3,7",
      undefined,
      withBanner,
    );
    expect(hit.json()).toEqual({ port: "5173" });
    const miss = await call("GET", "/internal/dev-server-port?sessionIds=3", undefined, withBanner);
    expect(miss.json()).toEqual({ port: null });
    expect((await call("GET", "/internal/dev-server-port")).json()).toEqual({ port: null });
    expect((await call("GET", "/internal/dev-server-port?sessionIds=a;b")).statusCode).toBe(400);
  });
});
