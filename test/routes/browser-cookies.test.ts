import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as BrowserCookiesService from "../../src/services/browser-cookies.js";

// The route layer only needs to exercise validation/wiring — the actual
// host-file reading and encrypt-at-rest behavior are covered by
// test/services/browser-cookie-import.test.ts and
// test/services/browser-cookies.test.ts respectively, so
// importCookieProfile is mocked here to isolate this from real file I/O.
vi.mock("../../src/services/browser-cookies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserCookiesService>();
  return { ...actual, importCookieProfile: vi.fn() };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { importCookieProfile } = await import("../../src/services/browser-cookies.js");

const tmpDb = path.join(os.tmpdir(), `browser-cookies-route-test-${process.pid}.db`);

describe("browser cookies route (issue #184)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  describe("GET /api/projects/:projectId/browser-cookies", () => {
    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/projects/999999/browser-cookies" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("400s for a non-integer project id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/projects/not-a-number/browser-cookies",
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns an empty array when nothing has been imported", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/browser-cookies`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      await app.close();
    });
  });

  describe("POST /api/projects/:projectId/browser-cookies/import", () => {
    it("400s on a missing required field", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: { browser: "chrome", profilePath: "/tmp/Cookies" }, // missing label
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("400s on an invalid browser value", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: { browser: "safari", profilePath: "/tmp/Cookies", label: "work" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/browser-cookies/import",
        payload: { browser: "chrome", profilePath: "/tmp/Cookies", label: "work" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("imports successfully and returns the profile summary", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      vi.mocked(importCookieProfile).mockReturnValue({
        id: 1,
        projectId,
        label: "work",
        browser: "chrome",
        cookieCount: 5,
        importedAt: new Date(),
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: { browser: "chrome", profilePath: "/tmp/Cookies", label: "work" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ label: "work", browser: "chrome", cookieCount: 5 });
      // Asserting on the full FastifyInstance arg (rather than
      // expect.anything()) makes vitest's diff machinery choke trying to
      // traverse its internals (sockets etc.) on any mismatch — only the
      // args that matter here are checked.
      expect(importCookieProfile).toHaveBeenCalledWith(expect.anything(), projectId, {
        browser: "chrome",
        profilePath: "/tmp/Cookies",
        label: "work",
      });

      await app.close();
    });

    it("returns 400 with the error message when the import itself fails (e.g. profile not found)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      vi.mocked(importCookieProfile).mockImplementation(() => {
        throw new Error("Cookie database not found: /tmp/nope");
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: { browser: "firefox", profilePath: "/tmp/nope", label: "work" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("not found");

      await app.close();
    });
  });

  describe("DELETE /api/projects/:projectId/browser-cookies/:id", () => {
    it("400s for a non-integer id", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/browser-cookies/not-a-number`,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("404s when the profile doesn't exist", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/browser-cookies/999999`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("deletes an existing profile", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      // importCookieProfile is mocked in this file (see the vi.mock factory
      // above) and doesn't touch the DB, so a real row is inserted directly
      // — the route's DELETE handler itself goes through the real,
      // unmocked deleteCookieProfile/DB path.
      const { browserCookies } = await import("../../src/db/schema.js");
      const [row] = app.db
        .insert(browserCookies)
        .values({
          projectId,
          label: "work",
          browser: "chrome",
          cookiesEnc: "enc:x",
          cookieCount: 0,
        })
        .returning()
        .all();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/browser-cookies/${row.id}`,
      });
      expect(res.statusCode).toBe(204);

      const after = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/browser-cookies`,
      });
      expect(after.json()).toEqual([]);

      await app.close();
    });
  });

  // Issue #522 — list/upload/delete are primary-only DB operations and
  // never needed a remote-hosted project's agent at all (RemoteHostClient
  // dispatch for them has been removed); import is the one operation that
  // genuinely can't run against a remote host's filesystem from here and
  // 400s instead. None of this file's other describe blocks exercise a
  // project with hostId set, which is exactly why the old (dead, always-500)
  // RemoteHostClient dispatch went unnoticed.
  describe("a remote-hosted project (hostId set)", () => {
    async function createRemoteProject(app: Awaited<ReturnType<typeof buildApp>>) {
      // baseUrl is never actually dialed by any of these routes anymore —
      // list/upload/delete run locally, and import 400s before reaching
      // RemoteHostClient at all. Any well-formed http(s) URL is enough to
      // satisfy /api/hosts' own validation.
      const hostRes = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "remote", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const hostId = hostRes.json().id as string;
      const projectRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "remote-project", cwd: "/tmp", hostId },
      });
      return projectRes.json().id as number;
    }

    it("list still runs locally, returning this primary's own (empty) DB state", async () => {
      const app = await buildApp();
      const projectId = await createRemoteProject(app);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/browser-cookies`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      await app.close();
    });

    it("import 400s, pointing at Upload, instead of proxying to the agent", async () => {
      const app = await buildApp();
      const projectId = await createRemoteProject(app);
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/browser-cookies/import`,
        payload: { browser: "chrome", profilePath: "/tmp/Cookies", label: "work" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/use Upload instead/);
      await app.close();
    });

    it("delete still runs locally, 404ing for an unknown profile id", async () => {
      const app = await buildApp();
      const projectId = await createRemoteProject(app);
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/browser-cookies/999999`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});
