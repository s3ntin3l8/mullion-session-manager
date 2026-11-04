import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");
const { AGENT_LAUNCH_OPTIONS, AGENT_OPERATIONS, LEGACY_BASELINE, PROTOCOL_VERSION } =
  await import("../../src/shared/agent-protocol.js");

// Issue #2569 — a launch whose options the target host did not negotiate is
// refused BEFORE any worktree or process exists, rather than starting on an
// agent that would silently drop the field.

const tmpDb = path.join(os.tmpdir(), `session-launch-host-support-${process.pid}.db`);
const LOCAL_CWD = "/tmp/proj-launch-support";
const REMOTE_CWD = "/srv/launch-support";

describe("launch gating on negotiated agent support (issue #2569)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(ne(hosts.id, LOCAL_HOST_ID)).run();
  });

  async function addHost(name: string, loadAverage1m: number): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, {
      platform: "linux",
      logicalCores: 8,
      loadAverage1m,
      memory: { totalBytes: 1000, freeBytes: 500 },
      sessions: { tracked: 0, alive: 0 },
    });
    return hostId;
  }

  function negotiate(
    hostId: string,
    protocol: {
      protocolVersion: number;
      legacy: boolean;
      operations: readonly string[];
      launchOptions: readonly string[];
    },
  ) {
    app.hostAgentTracker?.record(hostId, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      protocol: {
        ...protocol,
        operations: [...protocol.operations],
        launchOptions: [...protocol.launchOptions],
      },
    });
  }

  const legacy = {
    ...LEGACY_BASELINE,
    legacy: true,
  };
  /** A different release of the same protocol: everything but `model`. */
  const modern = (without: string[] = []) => ({
    protocolVersion: PROTOCOL_VERSION,
    legacy: false,
    operations: [...AGENT_OPERATIONS],
    launchOptions: AGENT_LAUNCH_OPTIONS.filter((o) => !without.includes(o)),
  });

  function installFakeBackends() {
    const byHost = new Map<string, ReturnType<typeof makeBackend>>();
    function makeBackend() {
      return {
        createWorktree: vi.fn().mockResolvedValue({
          created: true,
          path: `${REMOTE_CWD}/.mullion-worktrees/mullion-session-x`,
          branch: "mullion/session-x",
        }),
        removeWorktree: vi.fn().mockResolvedValue(true),
        deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
        terminate: vi.fn().mockResolvedValue(undefined),
        stashSeed: vi.fn().mockResolvedValue(undefined),
        spawn: vi.fn().mockResolvedValue({}),
        liveStatus: vi.fn().mockResolvedValue({}),
      };
    }
    const backendFor = (hostId: string) => {
      let backend = byHost.get(hostId);
      if (!backend) {
        backend = makeBackend();
        byHost.set(hostId, backend);
      }
      return backend;
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(
      ((_app: unknown, hostIdArg: string) =>
        backendFor(hostIdArg) as unknown as ReturnType<
          typeof sessionBackendModule.resolveBackend
        >) as unknown as typeof sessionBackendModule.resolveBackend,
    );
    return { backendFor };
  }

  async function mappedProject(name: string, remotes: string[], placement = "pinned") {
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name, cwd: LOCAL_CWD },
    });
    const projectId = projectRes.json().id as number;
    app.db
      .update(projects)
      .set({
        placement: placement as "pinned" | "auto",
        hostCwds: JSON.stringify(Object.fromEntries(remotes.map((r) => [r, REMOTE_CWD]))),
      })
      .where(eq(projects.id, projectId))
      .run();
    return projectId;
  }

  it("refuses a launch carrying `model` on a legacy peer before any side effect", async () => {
    const remote = await addHost("legacy-peer", 0.2);
    negotiate(remote, legacy);
    const projectId = await mappedProject("legacy-model", [remote]);
    const { backendFor } = installFakeBackends();

    const result = await createSessionRecord(app, {
      projectId,
      command: "claude",
      hostId: remote,
      cwd: REMOTE_CWD,
      model: "opus",
      worktree: { baseRef: "main" },
    });

    expect(result).toMatchObject({ ok: false, reason: "host-unsupported" });
    const detail = result.ok === false && "detail" in result ? result.detail : "";
    expect(detail).toContain(remote);
    expect(detail).toContain("model");
    expect(detail).toContain("Update");
    expect(backendFor(remote).createWorktree).not.toHaveBeenCalled();
    expect(backendFor(remote).spawn).not.toHaveBeenCalled();
    expect(app.db.select().from(sessions).all()).toHaveLength(0);
  });

  it("refuses over the API with a 409 that points at the host's Update action", async () => {
    const remote = await addHost("legacy-api", 0.2);
    negotiate(remote, legacy);
    const projectId = await mappedProject("legacy-api", [remote]);
    installFakeBackends();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "claude", targetHostId: remote, model: "opus" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/model.*update/i);
  });

  it("starts on a peer on a different release that lists the option", async () => {
    const remote = await addHost("newer-peer", 0.2);
    negotiate(remote, modern());
    const projectId = await mappedProject("modern-model", [remote]);
    const { backendFor } = installFakeBackends();

    const result = await createSessionRecord(app, {
      projectId,
      command: "claude",
      hostId: remote,
      cwd: REMOTE_CWD,
      model: "opus",
    });

    expect(result.ok).toBe(true);
    expect(backendFor(remote).spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses a peer that does not list `model`, even on a current protocol", async () => {
    const remote = await addHost("no-model-peer", 0.2);
    negotiate(remote, modern(["model"]));
    const projectId = await mappedProject("no-model", [remote]);
    const { backendFor } = installFakeBackends();

    const result = await createSessionRecord(app, {
      projectId,
      command: "claude",
      hostId: remote,
      cwd: REMOTE_CWD,
      model: "opus",
    });

    expect(result).toMatchObject({ ok: false, reason: "host-unsupported" });
    expect(backendFor(remote).spawn).not.toHaveBeenCalled();
  });

  it("refuses a peer whose protocol is outside the supported range", async () => {
    const remote = await addHost("future-peer", 0.2);
    negotiate(remote, { ...modern(), protocolVersion: PROTOCOL_VERSION + 1 });
    const projectId = await mappedProject("incompatible", [remote]);
    const { backendFor } = installFakeBackends();

    const result = await createSessionRecord(app, {
      projectId,
      command: "claude",
      hostId: remote,
      cwd: REMOTE_CWD,
    });

    expect(result).toMatchObject({ ok: false, reason: "host-unsupported" });
    expect(backendFor(remote).spawn).not.toHaveBeenCalled();
  });

  it("Auto skips a less-loaded legacy peer and places on a host that lists `model`", async () => {
    const oldPeer = await addHost("auto-old", 0.1);
    const newPeer = await addHost("auto-new", 4);
    negotiate(oldPeer, legacy);
    negotiate(newPeer, modern());
    const projectId = await mappedProject("auto-model", [oldPeer, newPeer], "auto");
    installFakeBackends();

    const result = await createSessionRecord(app, {
      projectId,
      command: "claude",
      model: "opus",
      unattended: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.hostId).toBe(newPeer);
    expect(result.row.placementReason).toContain("skipped");
    expect(result.row.placementReason).toContain("model");
  });
});
