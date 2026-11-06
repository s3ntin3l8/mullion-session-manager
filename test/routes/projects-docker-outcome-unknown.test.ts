// #2637 — a Docker stack action whose spawn outcome is unknown hands back the
// session createSessionRecord kept, instead of answering "nothing was created".
// Its own file: projects-docker.test.ts is at its file-size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { projects, sessions } from "../../src/db/schema.js";

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

const service = {
  composeProject: "sanctuary",
  service: "web",
  containerName: "sanctuary-web",
  workingDir: "/home/user/sanctuary",
  state: "running",
  status: "Up 6 days",
  imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
  imageId: "sha256:current",
  buildable: false,
  pullable: true,
  composeResolvable: true,
  configFiles: [],
  envFile: null,
  configHash: "hash-current",
};

vi.mock("../../src/services/docker-service-detect.js", () => ({
  getComposeServices: vi.fn(async () => [service]),
  mapServicesToProject: vi.fn((services: unknown[]) => services),
  toDockControls: vi.fn(async () => [
    {
      id: "docker:sanctuary:web",
      title: "web",
      command: "docker compose logs -f web",
      source: "docker" as const,
      docker: {
        composeProject: service.composeProject,
        service: service.service,
        containerName: service.containerName,
        state: service.state,
        status: service.status,
        imageRef: service.imageRef,
        imageId: service.imageId,
        buildable: service.buildable,
        pullable: service.pullable,
      },
    },
  ]),
  shellQuote: vi.fn((v: string) => `'${v}'`),
  composeContextFlags: vi.fn(() => "-p 'sanctuary'"),
  pullComposeImageQuietly: vi.fn(async () => true),
  inspectImageId: vi.fn(async () => null),
  restartComposeService: vi.fn(async () => true),
  stopComposeService: vi.fn(async () => true),
  startComposeService: vi.fn(async () => true),
  reconstructConfigHash: vi.fn(async () => null),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const lifecycle = await import("../../src/services/session-lifecycle.js");

const tmpDb = path.join(os.tmpdir(), `projects-docker-outcome-unknown-${process.pid}.db`);

describe("Docker stack action with an unknown spawn outcome (#2637)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("hands back the kept session as reused instead of reporting a failure", async () => {
    const app = await buildApp();
    const [project] = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/home/user/sanctuary" })
      .returning()
      .all();
    const [kept] = app.db
      .insert(sessions)
      .values({
        projectId: project.id,
        command: "docker compose up",
        kind: "dock",
        status: "active",
      })
      .returning()
      .all();
    const create = vi.spyOn(lifecycle, "createSessionRecord").mockResolvedValue({
      ok: false,
      reason: "outcome-unknown",
      sessionId: kept.id,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/docker/stack/apply`,
      payload: { controlId: "docker:sanctuary:web" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: kept.id, reused: true });
    expect(create).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
