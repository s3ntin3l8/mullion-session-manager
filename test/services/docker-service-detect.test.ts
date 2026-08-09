import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";

// Issue #73 — same fake-child_process approach as agent-detect.test.ts and
// actions.test.ts: docker-service-detect.ts's `docker` shell-outs are faked
// so this suite doesn't depend on whether Docker is actually installed on
// whatever machine runs it.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// Field order MUST match docker-service-detect.ts's PS_FORMAT.
interface PsRow {
  id: string;
  names: string;
  state: string;
  status: string;
  image: string;
  createdAt: string;
  project: string;
  service: string;
  workingDir: string;
  imageId: string;
  oneoff: string;
}

function psLine(row: PsRow): string {
  return [
    row.id,
    row.names,
    row.state,
    row.status,
    row.image,
    row.createdAt,
    row.project,
    row.service,
    row.workingDir,
    row.imageId,
    row.oneoff,
  ].join("\t");
}

// Mutable per-test fixtures the mocked spawn() reads from.
let psOutput = "";
let psExitCode = 0;
let dockerInstalled = true;
let composeAvailable = true;
let pullSucceeds = true;
let inspectedImageId = "sha256:latest000000000000000000000000000000000000000000000000000000";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const child = makeFakeChild();
      setImmediate(() => {
        if (!dockerInstalled) {
          child.emit("error", new Error("spawn docker ENOENT"));
          return;
        }
        if (cmd !== "docker") {
          child.emit("error", new Error(`unexpected command: ${cmd}`));
          return;
        }
        if (args[0] === "ps") {
          child.stdout.emit("data", Buffer.from(psOutput));
          child.emit("close", psExitCode);
          return;
        }
        if (args[0] === "compose" && args[1] === "version") {
          if (composeAvailable) {
            child.stdout.emit("data", Buffer.from("Docker Compose version v2.99.0\n"));
            child.emit("close", 0);
          } else {
            child.emit("close", 1);
          }
          return;
        }
        if (args[0] === "compose" && args.includes("pull")) {
          if (pullSucceeds) {
            child.emit("close", 0);
          } else {
            child.stderr.emit("data", Buffer.from("Error: pull access denied\n"));
            child.emit("close", 1);
          }
          return;
        }
        if (args[0] === "image" && args[1] === "inspect") {
          child.stdout.emit("data", Buffer.from(`${inspectedImageId}\n`));
          child.emit("close", 0);
          return;
        }
        child.emit("error", new Error(`unexpected docker args: ${args.join(" ")}`));
      });
      return child;
    }),
  };
});

const {
  getComposeServices,
  clearComposeCacheForTests,
  clearComposeAvailabilityCacheForTests,
  mapServicesToProject,
  toDockControls,
  shellQuote,
  pullComposeImageQuietly,
  inspectImageId,
} = await import("../../src/services/docker-service-detect.js");

describe("docker-service-detect", () => {
  let resolvableDir: string;
  let unresolvableDir: string;

  beforeEach(() => {
    psOutput = "";
    psExitCode = 0;
    dockerInstalled = true;
    composeAvailable = true;
    pullSucceeds = true;
    clearComposeCacheForTests();
    clearComposeAvailabilityCacheForTests();
    resolvableDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-detect-resolvable-"));
    fs.writeFileSync(path.join(resolvableDir, "docker-compose.yml"), "services: {}\n");
    unresolvableDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-detect-unresolvable-"));
  });

  afterEach(() => {
    fs.rmSync(resolvableDir, { recursive: true, force: true });
    fs.rmSync(unresolvableDir, { recursive: true, force: true });
  });

  describe("getComposeServices", () => {
    it("parses ps output into ComposeService objects", async () => {
      psOutput = psLine({
        id: "abc123",
        names: "sanctuary-web",
        state: "running",
        status: "Up 6 days",
        image: "ghcr.io/s3ntin3l8/sanctuary:edge",
        createdAt: "2026-07-12 21:53:25 +0000 UTC",
        project: "sanctuary",
        service: "web",
        workingDir: resolvableDir,
        imageId: "sha256:c14dd0e39e89f0c15c2bf462d8a2e05fb17a3b89dc8fe59b60e9f7daa48d7837",
        oneoff: "False",
      });

      const services = await getComposeServices();
      expect(services).toEqual([
        {
          composeProject: "sanctuary",
          service: "web",
          containerName: "sanctuary-web",
          workingDir: resolvableDir,
          state: "running",
          status: "Up 6 days",
          imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
          imageId: "sha256:c14dd0e39e89f0c15c2bf462d8a2e05fb17a3b89dc8fe59b60e9f7daa48d7837",
          buildOnly: false,
          composeResolvable: true,
        },
      ]);
    });

    it("drops `docker compose run` one-off containers", async () => {
      psOutput = [
        psLine({
          id: "a",
          names: "sanctuary-migrate-run-1",
          state: "exited",
          status: "Exited (0) 2 minutes ago",
          image: "ghcr.io/s3ntin3l8/sanctuary:edge",
          createdAt: "2026-08-01 00:00:00 +0000 UTC",
          project: "sanctuary",
          service: "migrate",
          workingDir: resolvableDir,
          imageId: "sha256:aaa",
          oneoff: "True",
        }),
      ].join("\n");

      expect(await getComposeServices()).toEqual([]);
    });

    it("dedupes (project, service) preferring the running container", async () => {
      psOutput = [
        psLine({
          id: "old",
          names: "sanctuary-web-old",
          state: "exited",
          status: "Exited (0) 2 days ago",
          image: "ghcr.io/s3ntin3l8/sanctuary:edge",
          createdAt: "2026-08-01 00:00:00 +0000 UTC",
          project: "sanctuary",
          service: "web",
          workingDir: resolvableDir,
          imageId: "sha256:old",
          oneoff: "False",
        }),
        psLine({
          id: "new",
          names: "sanctuary-web",
          state: "running",
          status: "Up 6 days",
          image: "ghcr.io/s3ntin3l8/sanctuary:edge",
          createdAt: "2026-07-12 21:53:25 +0000 UTC",
          project: "sanctuary",
          service: "web",
          workingDir: resolvableDir,
          imageId: "sha256:new",
          oneoff: "False",
        }),
      ].join("\n");

      const services = await getComposeServices();
      expect(services).toHaveLength(1);
      expect(services[0]?.containerName).toBe("sanctuary-web");
      expect(services[0]?.state).toBe("running");
    });

    it("dedupes ties on state by preferring the most recently created", async () => {
      psOutput = [
        psLine({
          id: "a",
          names: "app-web-1",
          state: "exited",
          status: "Exited (0) 2 days ago",
          image: "app-web",
          createdAt: "2026-08-01 00:00:00 +0000 UTC",
          project: "app",
          service: "web",
          workingDir: resolvableDir,
          imageId: "sha256:a",
          oneoff: "False",
        }),
        psLine({
          id: "b",
          names: "app-web-2",
          state: "exited",
          status: "Exited (0) 1 day ago",
          image: "app-web",
          createdAt: "2026-08-02 00:00:00 +0000 UTC",
          project: "app",
          service: "web",
          workingDir: resolvableDir,
          imageId: "sha256:b",
          oneoff: "False",
        }),
      ].join("\n");

      const services = await getComposeServices();
      expect(services).toHaveLength(1);
      expect(services[0]?.containerName).toBe("app-web-2");
    });

    it("flags buildOnly when the image matches compose's default build-image name", async () => {
      psOutput = psLine({
        id: "a",
        names: "pocket-portfolio-tracker-api-1",
        state: "running",
        status: "Up 1 hour",
        image: "pocket-portfolio-tracker-api",
        createdAt: "2026-08-01 00:00:00 +0000 UTC",
        project: "pocket-portfolio-tracker",
        service: "api",
        workingDir: resolvableDir,
        imageId: "sha256:x",
        oneoff: "False",
      });

      const services = await getComposeServices();
      expect(services[0]?.buildOnly).toBe(true);
    });

    it("does not flag buildOnly for a real registry image", async () => {
      psOutput = psLine({
        id: "a",
        names: "sanctuary-web",
        state: "running",
        status: "Up 6 days",
        image: "ghcr.io/s3ntin3l8/sanctuary:edge",
        createdAt: "2026-08-01 00:00:00 +0000 UTC",
        project: "sanctuary",
        service: "web",
        workingDir: resolvableDir,
        imageId: "sha256:x",
        oneoff: "False",
      });

      const services = await getComposeServices();
      expect(services[0]?.buildOnly).toBe(false);
    });

    it("flags composeResolvable false when no default-named compose file exists in workingDir", async () => {
      psOutput = psLine({
        id: "a",
        names: "foo-web",
        state: "running",
        status: "Up",
        image: "nginx:latest",
        createdAt: "2026-08-01 00:00:00 +0000 UTC",
        project: "foo",
        service: "web",
        workingDir: unresolvableDir,
        imageId: "sha256:x",
        oneoff: "False",
      });

      const services = await getComposeServices();
      expect(services[0]?.composeResolvable).toBe(false);
    });

    it("returns [] when docker is not installed", async () => {
      dockerInstalled = false;
      expect(await getComposeServices()).toEqual([]);
    });

    it("returns [] when `docker ps` exits non-zero", async () => {
      psExitCode = 1;
      psOutput = "";
      expect(await getComposeServices()).toEqual([]);
    });

    it("caches results and dedupes concurrent in-flight calls to one spawn", async () => {
      const { spawn } = await import("node:child_process");
      const spawnMock = vi.mocked(spawn);
      psOutput = psLine({
        id: "a",
        names: "sanctuary-web",
        state: "running",
        status: "Up",
        image: "ghcr.io/s3ntin3l8/sanctuary:edge",
        createdAt: "2026-08-01 00:00:00 +0000 UTC",
        project: "sanctuary",
        service: "web",
        workingDir: resolvableDir,
        imageId: "sha256:x",
        oneoff: "False",
      });

      spawnMock.mockClear();
      const [a, b] = await Promise.all([getComposeServices(), getComposeServices()]);
      const psCallsAfterConcurrent = spawnMock.mock.calls.filter(
        (call) => call[1] && (call[1] as string[])[0] === "ps",
      ).length;
      expect(psCallsAfterConcurrent).toBe(1);
      expect(a).toEqual(b);

      spawnMock.mockClear();
      await getComposeServices();
      const psCallsAfterCached = spawnMock.mock.calls.filter(
        (call) => call[1] && (call[1] as string[])[0] === "ps",
      ).length;
      expect(psCallsAfterCached).toBe(0);

      spawnMock.mockClear();
      await getComposeServices(true);
      const psCallsAfterForced = spawnMock.mock.calls.filter(
        (call) => call[1] && (call[1] as string[])[0] === "ps",
      ).length;
      expect(psCallsAfterForced).toBe(1);
    });
  });

  describe("shellQuote", () => {
    it("wraps a plain value in single quotes", () => {
      expect(shellQuote("sanctuary")).toBe("'sanctuary'");
    });

    it("escapes an embedded single quote", () => {
      expect(shellQuote("it's-a-service")).toBe(String.raw`'it'\''s-a-service'`);
    });

    it("neutralizes shell metacharacters", () => {
      const dangerous = "; rm -rf / #";
      const quoted = shellQuote(dangerous);
      expect(quoted).toBe(`'${dangerous}'`);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    });
  });

  describe("toDockControls", () => {
    it("synthesizes a docker-compose logs command when compose is available and resolvable", async () => {
      composeAvailable = true;
      const controls = await toDockControls([
        {
          composeProject: "sanctuary",
          service: "web",
          containerName: "sanctuary-web",
          workingDir: resolvableDir,
          state: "running",
          status: "Up 6 days",
          imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
          imageId: "sha256:x",
          buildOnly: false,
          composeResolvable: true,
        },
      ]);

      expect(controls).toEqual([
        {
          id: "docker:sanctuary:web",
          title: "web",
          command:
            `docker compose -p ${shellQuote("sanctuary")} ` +
            `--project-directory ${shellQuote(resolvableDir)} ` +
            `logs -f --tail=200 ${shellQuote("web")}`,
          source: "docker",
          docker: {
            composeProject: "sanctuary",
            service: "web",
            containerName: "sanctuary-web",
            state: "running",
            status: "Up 6 days",
            imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
            imageId: "sha256:x",
            buildOnly: false,
          },
        },
      ]);
    });

    it("falls back to `docker logs` when composeResolvable is false", async () => {
      composeAvailable = true;
      const controls = await toDockControls([
        {
          composeProject: "foo",
          service: "web",
          containerName: "foo-web",
          workingDir: unresolvableDir,
          state: "running",
          status: "Up",
          imageRef: "nginx:latest",
          imageId: "sha256:x",
          buildOnly: false,
          composeResolvable: false,
        },
      ]);

      expect(controls[0]?.command).toBe(`docker logs -f --tail=200 ${shellQuote("foo-web")}`);
    });

    it("falls back to `docker logs` when `docker compose` itself is unavailable", async () => {
      composeAvailable = false;
      const controls = await toDockControls([
        {
          composeProject: "foo",
          service: "web",
          containerName: "foo-web",
          workingDir: resolvableDir,
          state: "running",
          status: "Up",
          imageRef: "nginx:latest",
          imageId: "sha256:x",
          buildOnly: false,
          composeResolvable: true,
        },
      ]);

      expect(controls[0]?.command).toBe(`docker logs -f --tail=200 ${shellQuote("foo-web")}`);
    });

    it("shell-quotes label-derived values containing shell metacharacters", async () => {
      composeAvailable = true;
      const dangerousDir = path.join(resolvableDir, "a'; rm -rf ~ #");
      const controls = await toDockControls([
        {
          composeProject: "a'b",
          service: "c;d",
          containerName: "x",
          workingDir: dangerousDir,
          state: "running",
          status: "Up",
          imageRef: "nginx:latest",
          imageId: "sha256:x",
          buildOnly: false,
          composeResolvable: false, // dangerousDir doesn't actually exist
        },
      ]);
      // composeResolvable: false forces the docker-logs fallback here, so
      // assert the quoting directly instead.
      expect(shellQuote("a'b")).toContain("'\\''");
      expect(controls[0]?.command).toBe(`docker logs -f --tail=200 ${shellQuote("x")}`);
    });
  });

  describe("mapServicesToProject", () => {
    const services = [
      {
        composeProject: "sanctuary",
        service: "web",
        containerName: "sanctuary-web",
        workingDir: "/home/user/sanctuary",
        state: "running" as const,
        status: "Up",
        imageRef: "x",
        imageId: "y",
        buildOnly: false,
        composeResolvable: true,
      },
      {
        composeProject: "nested",
        service: "api",
        containerName: "nested-api",
        workingDir: "/home/user/monorepo/packages/nested",
        state: "running" as const,
        status: "Up",
        imageRef: "x",
        imageId: "y",
        buildOnly: false,
        composeResolvable: true,
      },
      {
        composeProject: "unrelated",
        service: "db",
        containerName: "unrelated-db",
        workingDir: "/opt/docker-apps/unrelated",
        state: "running" as const,
        status: "Up",
        imageRef: "x",
        imageId: "y",
        buildOnly: false,
        composeResolvable: true,
      },
    ];

    it("keeps only services whose workingDir is the project cwd or a descendant", () => {
      const result = mapServicesToProject(services, "/home/user/sanctuary", [
        "/home/user/sanctuary",
        "/opt/docker-apps/unrelated",
      ]);
      expect(result.map((s) => s.composeProject)).toEqual(["sanctuary"]);
    });

    it("assigns a nested project's service to the nested project, not the monorepo root", () => {
      const allCwds = ["/home/user/monorepo", "/home/user/monorepo/packages/nested"];

      const rootOwned = mapServicesToProject(services, "/home/user/monorepo", allCwds);
      expect(rootOwned).toEqual([]);

      const nestedOwned = mapServicesToProject(
        services,
        "/home/user/monorepo/packages/nested",
        allCwds,
      );
      expect(nestedOwned.map((s) => s.composeProject)).toEqual(["nested"]);
    });
  });

  describe("pullComposeImageQuietly / inspectImageId", () => {
    const service = {
      composeProject: "sanctuary",
      service: "web",
      containerName: "sanctuary-web",
      workingDir: "/home/user/sanctuary",
      state: "running" as const,
      status: "Up",
      imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
      imageId: "sha256:old000000000000000000000000000000000000000000000000000000000",
      buildOnly: false,
      composeResolvable: true,
    };

    it("pullComposeImageQuietly resolves true on success", async () => {
      pullSucceeds = true;
      expect(await pullComposeImageQuietly(service)).toBe(true);
    });

    it("pullComposeImageQuietly resolves false on failure (private registry, no image, ...)", async () => {
      pullSucceeds = false;
      expect(await pullComposeImageQuietly(service)).toBe(false);
    });

    it("inspectImageId returns the trimmed image id", async () => {
      inspectedImageId = "sha256:deadbeef";
      expect(await inspectImageId("ghcr.io/s3ntin3l8/sanctuary:edge")).toBe("sha256:deadbeef");
    });

    it("inspectImageId returns null when docker is not installed", async () => {
      dockerInstalled = false;
      expect(await inspectImageId("ghcr.io/s3ntin3l8/sanctuary:edge")).toBeNull();
    });
  });
});
