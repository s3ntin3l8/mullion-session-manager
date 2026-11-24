import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
} from "../helpers/internal-routes.js";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";

// Issue #3426 — the agent's dock port probe, reached through app.inject() on
// the real internal routes, as the primary reaches it.
const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");

const headers = { authorization: `Bearer ${INTERNAL_TEST_TOKEN}` };

function listen(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("POST /internal/dock-port-check", () => {
  const env = createInternalAgentEnv();
  const servers: net.Server[] = [];
  beforeAll(() => env.setup());
  afterAll(() => {
    for (const s of servers) s.close();
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
  });

  function checkout(controls: unknown[]) {
    const cwd = path.join(env.projectsRoot, `dock-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(cwd, ".crs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".crs", "dock.json"), JSON.stringify({ controls }));
    return cwd;
  }

  async function check(payload: object) {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/dock-port-check",
      headers,
      payload,
    });
    await app.close();
    return res;
  }

  it("reports a port held by another process", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const cwd = checkout([{ id: "dev", title: "Dev", command: "npm run dev", port }]);
    const res = await check({ cwd, command: "npm run dev", devServerUrl: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ port });
  });

  it("answers null when the port is free, the command is no control, or via devServerUrl on a free port", async () => {
    const server = await listen();
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r));
    const cwd = checkout([{ id: "dev", title: "Dev", command: "npm run dev", port }]);
    expect((await check({ cwd, command: "npm run dev" })).json()).toBeNull();
    expect((await check({ cwd, command: "tail -f log" })).json()).toBeNull();
  });

  it("falls back to a bare-port devServerUrl for the only control", async () => {
    const server = await listen();
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const cwd = checkout([{ id: "dev", title: "Dev", command: "npm run dev" }]);
    const res = await check({ cwd, command: "npm run dev", devServerUrl: String(port) });
    expect(res.json()).toEqual({ port });
  });

  it("refuses a cwd outside the agent's projects roots", async () => {
    const res = await check({ cwd: "/etc", command: "npm run dev" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unauthenticated request", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/dock-port-check",
      payload: { cwd: "/x", command: "y" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
