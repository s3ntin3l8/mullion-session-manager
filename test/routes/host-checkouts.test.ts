import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { projects } from "../../src/db/schema.js";
import { HostHeartbeatTracker } from "../../src/services/host-heartbeat.js";
import { createHost } from "../../src/services/host-registry.js";
import type { DiscoveredCandidate } from "../../src/services/project-config.js";
import { applySettingsPatch } from "../../src/services/settings.js";

// Issue #2090 — the HTTP surface: host suggestions for a project, "detect now"
// for a host, and the hostCwdsMeta bookkeeping on PATCH. Remote discovery is
// faked per host id; everything else is the real app and DB.

const discovery = new Map<string, DiscoveredCandidate[]>();

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => discovery.get(hostId) ?? [],
    }),
  };
});

describe("host checkout detection routes", () => {
  let app: FastifyInstance;
  let tmp: string;
  let macId: string;
  let projectId: number;

  /** The project, as the API lists it (the DB is shared across this file's tests). */
  async function listed() {
    const all = (await app.inject({ method: "GET", url: "/api/projects" })).json() as Array<{
      id: number;
      hostCwds: Record<string, string>;
      hostCwdsMeta: { auto: string[]; declined: string[]; managed: string[] };
    }>;
    return all.find((p) => p.id === projectId)!;
  }

  beforeEach(async () => {
    discovery.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "host-checkouts-"));
    app = await buildTestApp();
    await app.ready();
    const tracker = new HostHeartbeatTracker();
    app.hostHeartbeatTracker = tracker;
    macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
    tracker.recordSuccess(macId);

    const cwd = path.join(tmp, "app");
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/app.git\n',
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "app", cwd },
    });
    projectId = created.json().id;
    discovery.set(macId, [
      {
        name: "app",
        cwd: "/Users/x/app",
        isGitRepo: true,
        isWorktree: false,
        origin: "https://github.com/acme/app.git",
      },
    ]);
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("GET /api/projects/:id/host-suggestions", () => {
    it("lists the matching clone per host, without writing anything", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/host-suggestions`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        hosts: [
          {
            hostId: macId,
            hostName: "mac",
            candidates: [{ cwd: "/Users/x/app", match: "origin" }],
            ambiguous: false,
            declined: false,
          },
        ],
      });
      const [row] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      expect(row.hostCwds).toBeNull();
    });

    it("404s an unknown project and 400s a malformed id", async () => {
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/999999/host-suggestions" }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/nope/host-suggestions" }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("POST /api/hosts/:id/detect-checkouts", () => {
    it("reports enabled:false and changes nothing while the setting is off", async () => {
      const res = await app.inject({ method: "POST", url: `/api/hosts/${macId}/detect-checkouts` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: false, added: [] });
      expect((await listed()).hostCwds).toEqual({});
    });

    it("maps the project once the setting is on, and the project API shows it as auto", async () => {
      applySettingsPatch(app, { autoDetectHostCheckouts: true });

      const res = await app.inject({ method: "POST", url: `/api/hosts/${macId}/detect-checkouts` });

      expect(res.json()).toEqual({
        enabled: true,
        added: [{ projectId, hostId: macId, cwd: "/Users/x/app" }],
      });
      const project = await listed();
      expect(project.hostCwds).toEqual({ [macId]: "/Users/x/app" });
      expect(project.hostCwdsMeta).toEqual({ auto: [macId], declined: [], managed: [] });
    });

    it("404s an unknown host", async () => {
      const res = await app.inject({ method: "POST", url: "/api/hosts/nope/detect-checkouts" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/projects/:id hostCwds bookkeeping", () => {
    async function autoFilled() {
      applySettingsPatch(app, { autoDetectHostCheckouts: true });
      await app.inject({ method: "POST", url: `/api/hosts/${macId}/detect-checkouts` });
    }

    it("a new project starts with an empty meta", async () => {
      expect((await listed()).hostCwdsMeta).toEqual({ auto: [], declined: [], managed: [] });
    });

    it("saving a kept entry clears its auto flag", async () => {
      await autoFilled();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { hostCwds: { [macId]: "/Users/x/app" } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().hostCwdsMeta).toEqual({ auto: [], declined: [], managed: [] });
    });

    it("removing an auto-filled entry declines the host, and auto-detect never re-adds it", async () => {
      await autoFilled();

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { hostCwds: {} },
      });
      expect(patched.json().hostCwdsMeta).toEqual({ auto: [], declined: [macId], managed: [] });

      const again = await app.inject({
        method: "POST",
        url: `/api/hosts/${macId}/detect-checkouts`,
      });
      expect(again.json().added).toEqual([]);
      expect((await listed()).hostCwds).toEqual({});

      // ...but the one-click suggestion is still offered, flagged.
      const suggestions = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/host-suggestions`,
      });
      expect(suggestions.json().hosts[0].declined).toBe(true);
    });

    it("setting the entry again un-declines the host", async () => {
      await autoFilled();
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { hostCwds: {} },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { hostCwds: { [macId]: "/Users/x/app" } },
      });

      expect(res.json().hostCwdsMeta).toEqual({ auto: [], declined: [], managed: [] });
    });

    it("a PATCH that does not carry hostCwds leaves the meta alone", async () => {
      await autoFilled();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { name: "renamed" },
      });

      expect(res.json().hostCwdsMeta).toEqual({ auto: [macId], declined: [], managed: [] });
    });
  });
});
