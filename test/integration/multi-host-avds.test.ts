import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import type * as ChildProcess from "node:child_process";
import { WebSocket as NodeWebSocket } from "ws";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { warmSqliteBinding } from "../helpers/app.js";
import { overrideDefaultRequestTimeoutForTests } from "../../src/services/remote-host-client.js";

// Issue #3299 end to end: primary <-> agent over loopback HTTP + WS for
// available system images, SDK license status, system-image install/uninstall
// streaming, and SDK license acceptance streaming.

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual, { passthrough: ["git"] });
});
vi.mock("../../src/services/avd-manager.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listInstalledSystemImages: vi.fn(),
    listAvailableSystemImages: vi.fn(),
    installSystemImage: vi.fn(),
    uninstallSystemImage: vi.fn(),
    acceptLicenses: vi.fn(),
    licensesMayBePending: vi.fn(),
  };
});

const { buildApp } = await import("../../src/app.js");
const {
  listInstalledSystemImages,
  listAvailableSystemImages,
  installSystemImage,
  uninstallSystemImage,
  acceptLicenses,
  licensesMayBePending,
} = await import("../../src/services/avd-manager.js");

const AGENT_TOKEN = "avd-agent-token";
const primaryDb = path.join(
  os.tmpdir(),
  `multi-host-avds-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);

type Built = Awaited<ReturnType<typeof buildAndListen>>;

async function buildAndListen(env: Record<string, string>, platform?: NodeJS.Platform) {
  const full: Record<string, string> = {
    SESSIONS_DIR: path.join(
      os.tmpdir(),
      `multi-host-avds-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
    ),
    ...env,
  };
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(full)) {
    prev[key] = process.env[key];
    process.env[key] = full[key];
  }
  const originalPlatform = process.platform;
  if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    return { app, port: address.port };
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    for (const key of Object.keys(full)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("System image management and SDK licenses on an agent host (issue #3299)", () => {
  let agent: Built;
  let primary: Built;
  let hostId: string;
  let deadHostId: string;
  let restoreTimeout: (() => void) | undefined;

  function openPrimaryWs(urlPath: string): Promise<{
    ws: NodeWebSocket;
    messages: Array<Record<string, unknown>>;
    waitForMessage: (
      predicate: (m: Record<string, unknown>) => boolean,
    ) => Promise<Record<string, unknown>>;
    waitForClose: () => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${primary.port}${urlPath}`);
      const messages: Array<Record<string, unknown>> = [];
      const waiters: Array<{
        predicate: (m: Record<string, unknown>) => boolean;
        resolve: (m: Record<string, unknown>) => void;
      }> = [];
      const closeWaiters: Array<() => void> = [];
      let closed = false;

      ws.on("message", (data) => {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>;
        messages.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(parsed)) {
            const w = waiters[i];
            waiters.splice(i, 1);
            w.resolve(parsed);
          }
        }
      });
      ws.on("close", () => {
        closed = true;
        for (const cb of closeWaiters.splice(0)) cb();
      });
      ws.on("error", reject);
      ws.on("open", () => {
        resolve({
          ws,
          messages,
          waitForMessage(predicate) {
            const existing = messages.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((res) => waiters.push({ predicate, resolve: res }));
          },
          waitForClose() {
            if (closed) return Promise.resolve();
            return new Promise((res) => closeWaiters.push(res));
          },
        });
      });
    });
  }

  beforeAll(async () => {
    restoreTimeout = overrideDefaultRequestTimeoutForTests(15_000);
    fs.rmSync(primaryDb, { force: true });
    await warmSqliteBinding();
    agent = await buildAndListen(
      {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: AGENT_TOKEN,
        DEVICE_ENABLED: "true",
        DEVICE_AVDMANAGER_PATH: "/usr/bin/avdmanager",
        DEVICE_SDKMANAGER_PATH: "/usr/bin/sdkmanager",
        DEVICE_ANDROID_SDK_ROOT: "/opt/android-sdk",
      },
      "linux",
    );
    primary = await buildAndListen({ DATABASE_URL: `file:${primaryDb}` });

    const register = async (name: string, port: number, token: string) =>
      (
        await primary.app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name, baseUrl: `http://127.0.0.1:${port}`, token },
        })
      ).json().id as string;
    hostId = await register("avd-agent", agent.port, AGENT_TOKEN);
    deadHostId = await register("dead-agent", await closedPort(), "unused-token");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await primary.app.close();
    await agent.app.close();
    fs.rmSync(primaryDb, { force: true });
    restoreTimeout?.();
  });

  beforeEach(() => {
    vi.mocked(listInstalledSystemImages)
      .mockReset()
      .mockReturnValue([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tagDisplay: "Google APIs",
          abi: "x86_64",
        },
      ]);
    vi.mocked(listAvailableSystemImages)
      .mockReset()
      .mockResolvedValue([
        {
          packagePath: "system-images;android-35;google_apis;x86_64",
          apiLevel: "35",
          tag: "google_apis",
          tagDisplay: "Google APIs",
          abi: "x86_64",
          installed: true,
        },
        {
          packagePath: "system-images;android-34;google_apis;x86_64",
          apiLevel: "34",
          tag: "google_apis",
          tagDisplay: "Google APIs",
          abi: "x86_64",
          installed: false,
        },
      ]);
    vi.mocked(installSystemImage).mockReset().mockResolvedValue(undefined);
    vi.mocked(uninstallSystemImage).mockReset().mockResolvedValue(undefined);
    vi.mocked(acceptLicenses).mockReset().mockResolvedValue(undefined);
    vi.mocked(licensesMayBePending).mockReset().mockReturnValue(true);
  });

  it("rejects unauthenticated requests to the agent's system-image and license routes", async () => {
    for (const url of ["/internal/system-images/available", "/internal/sdk-licenses/status"]) {
      const res = await agent.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }

    for (const wsPath of ["/internal/ws/system-image-install", "/internal/ws/sdk-licenses"]) {
      const statusCode = await new Promise<number | undefined>((resolve) => {
        const ws = new NodeWebSocket(`ws://127.0.0.1:${agent.port}${wsPath}`);
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode);
          ws.close();
        });
        ws.on("error", () => resolve(undefined));
      });
      expect(statusCode).toBe(401);
    }
  });

  it("lists available system images and license status on an agent host, and handles unreachable/unknown", async () => {
    const availRes = await primary.app.inject({
      method: "GET",
      url: `/api/system-images/available?hostId=${encodeURIComponent(hostId)}`,
    });
    expect(availRes.statusCode).toBe(200);
    expect(availRes.json().systemImages).toHaveLength(2);

    const statusRes = await primary.app.inject({
      method: "GET",
      url: `/api/sdk-licenses/status?hostId=${encodeURIComponent(hostId)}`,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({ pending: true });

    const deadAvail = await primary.app.inject({
      method: "GET",
      url: `/api/system-images/available?hostId=${encodeURIComponent(deadHostId)}`,
    });
    expect(deadAvail.statusCode).toBe(503);

    const deadStatus = await primary.app.inject({
      method: "GET",
      url: `/api/sdk-licenses/status?hostId=${encodeURIComponent(deadHostId)}`,
    });
    expect(deadStatus.statusCode).toBe(503);

    const unknownAvail = await primary.app.inject({
      method: "GET",
      url: "/api/system-images/available?hostId=no-such-host",
    });
    expect(unknownAvail.statusCode).toBe(400);
  });

  it("streams install progress and done frames through the primary proxy", async () => {
    vi.mocked(installSystemImage).mockImplementationOnce(async (_sdk, _root, _pkg, opts) => {
      opts?.onLine?.("Downloading package...");
      opts?.onLine?.("100% Done");
    });

    const conn = await openPrimaryWs(
      `/ws/system-image-install?hostId=${encodeURIComponent(hostId)}`,
    );
    conn.ws.send(
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-34;google_apis;x86_64",
      }),
    );
    const done = await conn.waitForMessage((m) => m.type === "done");
    expect(done).toEqual({ type: "done" });
    expect(conn.messages).toEqual([
      { type: "progress", message: "Downloading package..." },
      { type: "progress", message: "100% Done" },
      { type: "done" },
    ]);
    expect(installSystemImage).toHaveBeenCalledWith(
      "/usr/bin/sdkmanager",
      "/opt/android-sdk",
      "system-images;android-34;google_apis;x86_64",
      expect.any(Object),
    );
    conn.ws.close();
    await conn.waitForClose();
  });

  it("streams sdk-licenses progress and done frames through the primary proxy", async () => {
    vi.mocked(acceptLicenses).mockImplementationOnce(async (_sdk, _root, opts) => {
      opts?.onLine?.("All SDK package licenses accepted.");
    });

    const conn = await openPrimaryWs(`/ws/sdk-licenses?hostId=${encodeURIComponent(hostId)}`);
    conn.ws.send(JSON.stringify({ type: "accept-licenses" }));
    const done = await conn.waitForMessage((m) => m.type === "done");
    expect(done).toEqual({ type: "done" });
    expect(conn.messages).toEqual([
      { type: "progress", message: "All SDK package licenses accepted." },
      { type: "done" },
    ]);
    conn.ws.close();
    await conn.waitForClose();
  });

  it("sends an error frame and closes when the target host is down", async () => {
    for (const wsPath of [
      `/ws/system-image-install?hostId=${encodeURIComponent(deadHostId)}`,
      `/ws/sdk-licenses?hostId=${encodeURIComponent(deadHostId)}`,
    ]) {
      const conn = await openPrimaryWs(wsPath);
      const errFrame = await conn.waitForMessage((m) => m.type === "error");
      expect(errFrame.message).toBeTruthy();
      await conn.waitForClose();
    }
  });

  it("enforces the host-global SDK operation lock across two proxied sockets", async () => {
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((res) => {
      releaseInstall = res;
    });
    vi.mocked(installSystemImage).mockImplementationOnce(async (_sdk, _root, _pkg, opts) => {
      opts?.onLine?.("Installing...");
      await installGate;
    });

    const conn1 = await openPrimaryWs(
      `/ws/system-image-install?hostId=${encodeURIComponent(hostId)}`,
    );
    conn1.ws.send(
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-34;google_apis;x86_64",
      }),
    );
    await conn1.waitForMessage((m) => m.type === "progress");

    const conn2 = await openPrimaryWs(
      `/ws/system-image-install?hostId=${encodeURIComponent(hostId)}`,
    );
    conn2.ws.send(
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-34;google_apis;x86_64",
      }),
    );
    const err = await conn2.waitForMessage((m) => m.type === "error");
    expect(err).toEqual({ type: "error", message: "An SDK operation is already in progress" });

    releaseInstall();
    await conn1.waitForMessage((m) => m.type === "done");
    conn1.ws.close();
    conn2.ws.close();
    await Promise.all([conn1.waitForClose(), conn2.waitForClose()]);
  });

  it("releases the agent's host-global lock when a proxied socket disconnects mid-install", async () => {
    let releaseInstall!: () => void;
    const installGate = new Promise<void>((res) => {
      releaseInstall = res;
    });
    vi.mocked(installSystemImage).mockImplementationOnce(async (_sdk, _root, _pkg, opts) => {
      opts?.onLine?.("Working...");
      await installGate;
    });

    const conn1 = await openPrimaryWs(
      `/ws/system-image-install?hostId=${encodeURIComponent(hostId)}`,
    );
    conn1.ws.send(
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-34;google_apis;x86_64",
      }),
    );
    await conn1.waitForMessage((m) => m.type === "progress");

    // Drop the browser socket while the install is still running.
    conn1.ws.close();
    await conn1.waitForClose();

    // Finish the in-flight install on the agent.
    releaseInstall();
    await new Promise((r) => setTimeout(r, 20));

    const conn2 = await openPrimaryWs(
      `/ws/system-image-install?hostId=${encodeURIComponent(hostId)}`,
    );
    conn2.ws.send(
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-34;google_apis;x86_64",
      }),
    );
    const done = await conn2.waitForMessage((m) => m.type === "done");
    expect(done).toEqual({ type: "done" });
    conn2.ws.close();
    await conn2.waitForClose();
  });
});
