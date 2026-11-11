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

    it("name-matches a project whose own cwd is a Windows drive path (#2958)", async () => {
      const winId = createHost(app, { name: "win", baseUrl: "http://win.test", token: "t" }).id;
      app.hostHeartbeatTracker!.recordSuccess(winId);
      app.db
        .update(projects)
        .set({ hostId: winId, cwd: "D:\\Projects\\App" })
        .where(eq(projects.id, projectId))
        .run();
      // The project's own checkout reports its origin, so a same-named clone
      // with a different origin must be refused while an origin-less one is not.
      discovery.set(winId, [
        {
          name: "App",
          cwd: "D:\\Projects\\App",
          isGitRepo: true,
          isWorktree: false,
          origin: "https://github.com/acme/app.git",
        },
      ]);
      discovery.set(macId, [
        { name: "app", cwd: "/Users/x/app", isGitRepo: true, isWorktree: false },
        {
          name: "app",
          cwd: "/Users/x/other/app",
          isGitRepo: true,
          isWorktree: false,
          origin: "https://github.com/acme/other.git",
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/host-suggestions`,
      });

      expect(res.statusCode).toBe(200);
      const mac = res.json().hosts.find((h: { hostId: string }) => h.hostId === macId);
      expect(mac.candidates).toEqual([{ cwd: "/Users/x/app", match: "name" }]);
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

  describe("one Windows checkout, several spellings (#2944)", () => {
    const WIN = "D:\\Projects\\app";

    async function otherProject(name: string, hostCwds?: Record<string, string>) {
      const cwd = path.join(tmp, name);
      fs.mkdirSync(cwd, { recursive: true });
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name, cwd, ...(hostCwds ? { hostCwds } : {}) },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as number;
    }

    it("refuses to attach another spelling of a path another project already owns", async () => {
      await otherProject("owner", { [macId]: WIN });
      const attach = (id: number, cwd: string) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${id}/host-checkouts`,
          payload: { hostId: macId, cwd },
        });

      for (const spelling of ["D:/Projects/app", "d:\\projects\\app\\"]) {
        const res = await attach(projectId, spelling);
        expect(res.statusCode, spelling).toBe(409);
        expect(res.json().code).toBe("DUPLICATE_PROJECT");
      }
    });

    it("re-attaching the same location in another spelling is a no-op that keeps the stored one", async () => {
      const attach = (cwd: string) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/host-checkouts`,
          payload: { hostId: macId, cwd },
        });
      expect((await attach(WIN)).statusCode).toBe(200);
      const again = await attach("d:/projects/app");
      expect(again.statusCode).toBe(200);
      expect(again.json().hostCwds).toEqual({ [macId]: WIN });
      // A genuinely different path for the host is still refused.
      expect((await attach("D:/Projects/other")).statusCode).toBe(409);
    });

    it("does not suggest a clone that a project already owns under another spelling", async () => {
      await otherProject("owner", { [macId]: WIN });
      discovery.set(macId, [
        {
          name: "app",
          cwd: "d:/projects/app",
          isGitRepo: true,
          isWorktree: false,
          origin: "https://github.com/acme/app.git",
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/host-suggestions`,
      });

      expect(res.json()).toEqual({ hosts: [] });
    });
  });

  describe("PATCH /api/projects/:id hostCwds bookkeeping", () => {
    async function autoFilled() {
      applySettingsPatch(app, { autoDetectHostCheckouts: true });
      await app.inject({ method: "POST", url: `/api/hosts/${macId}/detect-checkouts` });
    }

    it("accepts a Windows drive path for a host and refuses a traversal one", async () => {
      const ok = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { hostCwds: { [macId]: "D:\\Projects\\app" } },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().hostCwds).toEqual({ [macId]: "D:\\Projects\\app" });

      const attach = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/host-checkouts`,
        payload: { hostId: macId, cwd: "D:\\Projects\\app" },
      });
      expect(attach.statusCode).toBe(200);

      for (const bad of ["/a/../b", "D:\\a\\..\\b"]) {
        const created = await app.inject({
          method: "POST",
          url: "/api/projects",
          payload: { name: "bad", cwd: tmp, hostCwds: { [macId]: bad } },
        });
        expect(created.statusCode, `create ${bad}`).toBe(400);
      }

      for (const bad of ["/a/../b", "D:\\a\\..\\b"]) {
        const patched = await app.inject({
          method: "PATCH",
          url: `/api/projects/${projectId}`,
          payload: { hostCwds: { [macId]: bad } },
        });
        expect(patched.statusCode, bad).toBe(400);
      }

      const traversal = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/host-checkouts`,
        payload: { hostId: macId, cwd: "D:\\a\\..\\b" },
      });
      expect(traversal.statusCode).toBe(400);
    });

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
