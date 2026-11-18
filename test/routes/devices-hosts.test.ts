import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestAppOnPlatform, warmSqliteBinding } from "../helpers/app.js";
import { closeDb } from "../../src/db/client.js";
import { createHost } from "../../src/services/host-registry.js";
import { HostRequestError } from "../../src/services/remote-host-errors.js";

// GET /api/devices/hosts (#3270): which hosts could hold a device, and of what
// kind. Mocks the agent client, so no real systemd-run or network fires.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const kindsByHost = new Map<string, () => Promise<unknown>>();
const kindsCalls: string[] = [];
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: vi.fn((_app: unknown, hostId: string) => ({
      devices: {
        kinds: () => {
          kindsCalls.push(hostId);
          return kindsByHost.get(hostId)!();
        },
      },
    })),
  };
});

const tmpDb = path.join(os.tmpdir(), `devices-hosts-test-${process.pid}.db`);

describe("GET /api/devices/hosts", () => {
  let originalPlatform: NodeJS.Platform;
  beforeEach(async () => {
    await warmSqliteBinding();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    kindsByHost.clear();
    kindsCalls.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DEVICE_ENABLED;
  });

  async function build() {
    process.env.DEVICE_ENABLED = "true";
    return buildTestAppOnPlatform("linux");
  }
  const get = (app: Awaited<ReturnType<typeof build>>) =>
    app.inject({ method: "GET", url: "/api/devices/hosts" });

  it("lists only the primary when no agent is registered", async () => {
    const app = await build();
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ hostId: "local", status: "ok" });
    expect(body[0].deviceKinds).toEqual(app.deviceKinds);
    expect(kindsCalls).toEqual([]);
  });

  it("adds an agent that reports its kinds", async () => {
    const app = await build();
    const host = createHost(app, { name: "Mac mini", baseUrl: "http://agent:1", token: "t" });
    kindsByHost.set(host.id, async () => ({ deviceKinds: ["physical"], platforms: ["android"] }));
    const body = (await get(app)).json();
    expect(body[1]).toEqual({
      hostId: host.id,
      name: "Mac mini",
      status: "ok",
      deviceKinds: ["physical"],
    });
  });

  it("marks an agent that predates the route (404) unsupported", async () => {
    const app = await build();
    const host = createHost(app, { name: "Old", baseUrl: "http://agent:1", token: "t" });
    kindsByHost.set(host.id, async () => null);
    const body = (await get(app)).json();
    expect(body[1]).toMatchObject({ hostId: host.id, status: "unsupported", deviceKinds: [] });
  });

  it("marks a down agent unreachable and still answers 200", async () => {
    const app = await build();
    const down = createHost(app, { name: "Down", baseUrl: "http://agent:1", token: "t" });
    const up = createHost(app, { name: "Up", baseUrl: "http://agent:2", token: "t" });
    kindsByHost.set(down.id, async () => {
      throw new HostRequestError("down", 503, "");
    });
    kindsByHost.set(up.id, async () => ({ deviceKinds: ["emulator"], platforms: ["android"] }));
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.json().map((e: { hostId: string }) => [e.hostId, e]));
    expect(byId[down.id]).toMatchObject({ status: "unreachable", deviceKinds: [] });
    expect(byId[up.id]).toMatchObject({ status: "ok", deviceKinds: ["emulator"] });
  });

  it("gives up on a hung agent after 5 s", async () => {
    const app = await build();
    const host = createHost(app, { name: "Slow", baseUrl: "http://agent:1", token: "t" });
    kindsByHost.set(host.id, () => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = get(app);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()[1]).toMatchObject({ status: "unreachable" });
  });

  it("serves a second call within 10 s from the cache, then asks again", async () => {
    const app = await build();
    const host = createHost(app, { name: "Agent", baseUrl: "http://agent:1", token: "t" });
    kindsByHost.set(host.id, async () => ({ deviceKinds: ["emulator"], platforms: ["android"] }));
    vi.useFakeTimers();
    await get(app);
    await vi.advanceTimersByTimeAsync(9_000);
    await get(app);
    expect(kindsCalls).toEqual([host.id]);
    await vi.advanceTimersByTimeAsync(1_500);
    await get(app);
    expect(kindsCalls).toEqual([host.id, host.id]);
  });
});
