import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions } from "../../src/db/schema.js";
import {
  clearDevServerHostCache,
  resolveDevServerHostId,
} from "../../src/services/dev-server-host.js";
import { resolvePreviewTarget } from "../../src/services/preview-upstream.js";
import { getOrCreateProjectPreview } from "../../src/services/preview-registry.js";

const remote = vi.hoisted(() => ({ resolveDock: vi.fn() }));
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRemoteHostClient: () => ({ resolveDock: remote.resolveDock }),
  };
});

const MAC_CWD = "/Users/dev/app";
const PREVIEW_DEV = { id: "dev", title: "Dev", command: "npm run dev", preview: true };

// #3425 — the dev server runs where its preview control runs, which a start can
// place on another host than the project's own.
describe("resolveDevServerHostId and the preview target (#3425)", () => {
  let cwd: string;
  let app: FastifyInstance;
  let projectId: number;

  const startDock = (
    controlId: string,
    hostId: string | null,
    status: "active" | "killed" = "active",
  ) =>
    Number(
      app.db
        .insert(sessions)
        .values({
          projectId,
          command: "npm run dev",
          cwd,
          kind: "dock",
          dockControlId: controlId,
          hostId,
          status,
        })
        .run().lastInsertRowid,
    );

  beforeEach(async () => {
    clearDevServerHostCache();
    remote.resolveDock.mockReset().mockResolvedValue([PREVIEW_DEV]);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dev-server-host-"));
    fs.mkdirSync(path.join(cwd, ".crs"));
    fs.writeFileSync(
      path.join(cwd, ".crs", "dock.json"),
      JSON.stringify({ controls: [PREVIEW_DEV] }),
    );
    app = await buildTestApp();
    await app.ready();
    projectId = Number(
      app.db
        .insert(projects)
        .values({
          name: "p",
          cwd,
          devServerUrl: "5173",
          hostCwds: JSON.stringify({ mac: MAC_CWD }),
        })
        .run().lastInsertRowid,
    );
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const project = () => ({ id: projectId, hostId: "local" });

  it("is the project's host when nothing is running, and reads no config", async () => {
    expect(await resolveDevServerHostId(app, project())).toBe("local");
    expect(remote.resolveDock).not.toHaveBeenCalled();
  });

  it("is the project's host when every dock session runs there, without a config read", async () => {
    startDock("dev", "local");
    startDock("dev", null);
    expect(await resolveDevServerHostId(app, project())).toBe("local");
    expect(remote.resolveDock).not.toHaveBeenCalled();
  });

  it("follows the running preview control to the host it was started on", async () => {
    startDock("dev", "mac");
    expect(await resolveDevServerHostId(app, project())).toBe("mac");
    // Judged by the checkout on the host it runs on.
    expect(remote.resolveDock).toHaveBeenCalledWith(MAC_CWD);
  });

  it("judges a control by the dock.json of the host it runs on, not the project host's", async () => {
    remote.resolveDock.mockResolvedValue([
      { id: "mac-only", title: "Mac dev", command: "npm run dev", preview: true },
    ]);
    startDock("mac-only", "mac");
    expect(await resolveDevServerHostId(app, project())).toBe("mac");
  });

  it("ignores a stopped session", async () => {
    startDock("dev", "mac", "killed");
    expect(await resolveDevServerHostId(app, project())).toBe("local");
  });

  it("ignores a running control that is not the preview control", async () => {
    remote.resolveDock.mockResolvedValue([
      PREVIEW_DEV,
      { id: "logs", title: "Logs", command: "tail -f log" },
    ]);
    startDock("logs", "mac");
    expect(await resolveDevServerHostId(app, project())).toBe("local");
  });

  it("prefers the newest running session whose control is the preview control", async () => {
    startDock("dev", "mac");
    expect(await resolveDevServerHostId(app, project())).toBe("mac");
    startDock("dev", "local");
    // The project's own host now has the newest one; its dock.json says it is
    // the preview control too.
    expect(await resolveDevServerHostId(app, project())).toBe("local");
  });

  it("holds the control id briefly, so a burst of requests reads the config once", async () => {
    startDock("dev", "mac");
    await Promise.all(Array.from({ length: 5 }, () => resolveDevServerHostId(app, project())));
    await resolveDevServerHostId(app, project());
    expect(remote.resolveDock).toHaveBeenCalledTimes(1);
    clearDevServerHostCache();
    await resolveDevServerHostId(app, project());
    expect(remote.resolveDock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the project's host when the host's config cannot be read, without a read per request", async () => {
    remote.resolveDock.mockRejectedValue(new Error("ECONNREFUSED"));
    startDock("dev", "mac");
    expect(await resolveDevServerHostId(app, project())).toBe("local");
    expect(await resolveDevServerHostId(app, project())).toBe("local");
    expect(remote.resolveDock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the project's host for a project it cannot read", async () => {
    expect(await resolveDevServerHostId(app, { id: 99_999, hostId: "local" })).toBe("local");
  });

  it("a preview with no session targets the host its dev server runs on", async () => {
    const preview = getOrCreateProjectPreview(app, projectId);
    const before = await resolvePreviewTarget(app, preview.slug);
    expect(before).toMatchObject({ ok: true, target: { kind: "project", hostId: "local" } });

    startDock("dev", "mac");
    const after = await resolvePreviewTarget(app, preview.slug);
    expect(after).toMatchObject({
      ok: true,
      target: { kind: "project", hostId: "mac", devServerUrl: "5173" },
    });
  });
});
