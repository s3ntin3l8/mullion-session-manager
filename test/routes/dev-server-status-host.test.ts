import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions } from "../../src/db/schema.js";
import { clearDevServerHostCache } from "../../src/services/dev-server-host.js";

const remote = vi.hoisted(() => ({
  getDevServerStatus: vi.fn(),
  resolveDock: vi.fn(),
  hostIds: [] as string[],
}));
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => {
      remote.hostIds.push(hostId);
      return { getDevServerStatus: remote.getDevServerStatus, resolveDock: remote.resolveDock };
    },
  };
});

// #3425 — /api/projects/:id/dev-server-status asks the host the dev server runs
// on, which a dock start can place on another host than the project's own.
describe("GET /api/projects/:id/dev-server-status follows the running preview control (#3425)", () => {
  let cwd: string;

  beforeEach(() => {
    clearDevServerHostCache();
    remote.hostIds.length = 0;
    remote.getDevServerStatus.mockReset().mockResolvedValue({ online: true });
    remote.resolveDock
      .mockReset()
      .mockResolvedValue([{ id: "dev", title: "Dev", command: "npm run dev" }]);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dss-host-"));
    fs.mkdirSync(path.join(cwd, ".crs"));
    fs.writeFileSync(
      path.join(cwd, ".crs", "dock.json"),
      JSON.stringify({ controls: [{ id: "dev", title: "Dev", command: "npm run dev" }] }),
    );
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function setup(withRemoteSession: boolean) {
    const app = await buildTestApp();
    await app.ready();
    const projectId = Number(
      app.db
        .insert(projects)
        .values({
          name: "p",
          cwd,
          devServerUrl: "5173",
          hostCwds: JSON.stringify({ mac: "/Users/x/app" }),
        })
        .run().lastInsertRowid,
    );
    if (withRemoteSession) {
      app.db
        .insert(sessions)
        .values({
          projectId,
          command: "npm run dev",
          cwd,
          kind: "dock",
          dockControlId: "dev",
          hostId: "mac",
        })
        .run();
    }
    return { app, projectId };
  }

  it("asks the host the preview control runs on, by port and scheme", async () => {
    const { app, projectId } = await setup(true);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/dev-server-status`,
    });
    expect(res.json()).toEqual({ online: true });
    // The host is asked for its dock config, then for the dev server's status.
    expect(new Set(remote.hostIds)).toEqual(new Set(["mac"]));
    expect(remote.getDevServerStatus).toHaveBeenCalledWith(5173, "http");
  });

  it("probes locally when the control is not running anywhere else", async () => {
    const { app, projectId } = await setup(false);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/dev-server-status`,
    });
    // Nothing listens on 5173 here; the point is that no agent was asked.
    expect(res.statusCode).toBe(200);
    expect(remote.hostIds).toEqual([]);
  });
});
