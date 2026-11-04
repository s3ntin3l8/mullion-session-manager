import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { previews, projects, sessions } from "../../src/db/schema.js";
import {
  bindBranchPreview,
  getOrCreateProjectPreview,
  listUpstreamPorts,
  upsertBranchPreview,
} from "../../src/services/preview-registry.js";

// Issue #2247 — a preview follows the execution host of the session it is
// bound to, never the project's own host, and keeps that target.
const tmpDb = path.join(os.tmpdir(), `preview-session-target-${process.pid}.db`);
const BASE = "preview.session-target.test";

describe("preview proxy session targets", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let stub: http.Server;
  let stubPort: number;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = BASE;
    stub = http.createServer((_req, res) => res.end("local-stub"));
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubPort = (stub.address() as AddressInfo).port;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    stub.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  async function addHost(baseUrl: string | null = "http://127.0.0.1:1") {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `st-host-${++n}`,
        ...(baseUrl === null ? {} : { baseUrl }),
        token: "t".repeat(24),
      },
    });
    return res.json().id as string;
  }

  function addProject(hostCwds: Record<string, string> = {}) {
    return app.db
      .insert(projects)
      .values({
        name: `st-${++n}`,
        cwd: "/tmp/st-project",
        hostId: "local",
        devServerUrl: String(stubPort),
        hostCwds: JSON.stringify(hostCwds),
      })
      .returning()
      .get();
  }

  function addSession(projectId: number, hostId: string | null) {
    return app.db
      .insert(sessions)
      .values({ projectId, command: "vite", kind: "dock", hostId })
      .returning()
      .get();
  }

  const get = (slug: string) =>
    app.inject({ method: "GET", url: "/", headers: { host: `preview-${slug}.${BASE}` } });

  it("serves a session-less preview from the project's own host (project-default)", async () => {
    const project = addProject();
    const preview = getOrCreateProjectPreview(app, project.id);
    const res = await get(preview.slug);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("local-stub");
  });

  it("routes a preview bound to a remote-host session to that host, not the project's", async () => {
    const hostId = await addHost(); // unreachable agent
    const project = addProject({ [hostId]: "/srv/st-project" });
    const session = addSession(project.id, hostId);
    const preview = getOrCreateProjectPreview(app, project.id, session.id);
    // The project's own stub is up and would answer 200; the remote hop fails.
    const res = await get(preview.slug);
    expect(res.statusCode).toBe(502);
  });

  it("503s, rather than falling back to the project's host, when the session's host is unavailable", async () => {
    const hostId = await addHost(null); // no baseUrl: not reachable at all
    const project = addProject({ [hostId]: "/srv/st-project" });
    const session = addSession(project.id, hostId);
    const preview = getOrCreateProjectPreview(app, project.id, session.id);
    const res = await get(preview.slug);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("local-stub");
  });

  it("503s a branch preview whose bound session is gone instead of using the project's host", async () => {
    const project = addProject();
    const session = addSession(project.id, null);
    const row = upsertBranchPreview(app, project.id, "feat/gone");
    bindBranchPreview(app, row.slug, { sessionId: session.id, upstreamPort: stubPort });
    expect((await get(row.slug)).statusCode).toBe(200);
    app.db.delete(sessions).where(eq(sessions.id, session.id)).run();
    expect((await get(row.slug)).statusCode).toBe(503);
  });

  it("keeps an open preview on its original host when a session elsewhere accepts a server", async () => {
    const hostId = await addHost();
    const project = addProject({ [hostId]: "/srv/st-project" });
    const first = addSession(project.id, null);
    const second = addSession(project.id, hostId);
    const preview = getOrCreateProjectPreview(app, project.id, first.id);
    const again = getOrCreateProjectPreview(app, project.id, second.id);
    expect(again.slug).toBe(preview.slug);
    expect(again.sessionId).toBe(first.id);
    expect((await get(preview.slug)).statusCode).toBe(200);

    // Once the original session is gone the preview may follow the newcomer.
    app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, first.id)).run();
    expect(getOrCreateProjectPreview(app, project.id, second.id).sessionId).toBe(second.id);
  });

  it("rebinds freely between sessions on the same host", async () => {
    const project = addProject();
    const a = addSession(project.id, null);
    const b = addSession(project.id, "local");
    getOrCreateProjectPreview(app, project.id, a.id);
    expect(getOrCreateProjectPreview(app, project.id, b.id).sessionId).toBe(b.id);
  });

  describe("listUpstreamPorts", () => {
    it("scopes held ports to the owning session's host", async () => {
      const hostA = await addHost();
      const hostB = await addHost();
      const project = addProject({ [hostA]: "/a", [hostB]: "/b" });
      const port = 45678;
      const onA = upsertBranchPreview(app, project.id, "feat/a");
      bindBranchPreview(app, onA.slug, {
        sessionId: addSession(project.id, hostA).id,
        upstreamPort: port,
      });
      expect(listUpstreamPorts(app, hostA).has(port)).toBe(true);
      // The same number on another host is not a conflict.
      expect(listUpstreamPorts(app, hostB).has(port)).toBe(false);
      expect(listUpstreamPorts(app, "local").has(port)).toBe(false);

      // A second preview on host B may hold the very same port.
      const onB = upsertBranchPreview(app, project.id, "feat/b");
      bindBranchPreview(app, onB.slug, {
        sessionId: addSession(project.id, hostB).id,
        upstreamPort: port,
      });
      expect(listUpstreamPorts(app, hostB).has(port)).toBe(true);
    });

    it("resolves a session with no host of its own to its project's host", () => {
      const project = addProject();
      const row = upsertBranchPreview(app, project.id, "feat/inherit");
      bindBranchPreview(app, row.slug, {
        sessionId: addSession(project.id, null).id,
        upstreamPort: 45679,
      });
      expect(listUpstreamPorts(app, "local").has(45679)).toBe(true);
    });

    it("ignores a branch preview row with no bound session", () => {
      const project = addProject();
      const row = upsertBranchPreview(app, project.id, "feat/unbound");
      app.db.update(previews).set({ upstreamPort: 45680 }).where(eq(previews.slug, row.slug)).run();
      expect(listUpstreamPorts(app, "local").has(45680)).toBe(false);
    });
  });
});
