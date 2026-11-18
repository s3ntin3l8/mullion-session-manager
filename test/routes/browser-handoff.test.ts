import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  previews,
  projectPreviewTargets,
  projects,
  sessionBrowsers,
  sessions,
} from "../../src/db/schema.js";
import { isLoopbackHostname } from "../../src/services/browser-handoff.js";

// #3373 — "open this address in the other browser". Both routes translate an
// address between the preview (an iframe through the preview proxy) and the
// session's agent's browser, read-only: they never bind or launch a browser.
const tmpDb = path.join(os.tmpdir(), `browser-handoff-test-${process.pid}.db`);

describe("browser handoff routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cwd-"));

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
  });

  async function addHost() {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: `handoff-host-${++n}`,
        baseUrl: "http://127.0.0.1:1",
        token: "t".repeat(24),
      },
    });
    return res.json().id as string;
  }
  // Every project also has a checkout on the Mullion server, so a local
  // session in a project hosted elsewhere is a real placement.
  function addProject(hostId: string, devServerUrl: string | null) {
    return app.db
      .insert(projects)
      .values({
        name: `handoff-${++n}`,
        cwd,
        hostId,
        devServerUrl,
        hostCwds: JSON.stringify({ local: cwd, [hostId]: cwd }),
      })
      .returning({ id: projects.id })
      .get().id;
  }
  function addSession(projectId: number, hostId: string) {
    return app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd, hostId })
      .returning({ id: sessions.id })
      .get().id;
  }
  function addPreview(values: Partial<typeof previews.$inferInsert>) {
    const slug = `slug-${++n}`;
    app.db
      .insert(previews)
      .values({ slug, kind: "project", ...values })
      .run();
    return slug;
  }
  async function addressFor(sessionId: number, slug?: string) {
    const q = slug ? `?slug=${encodeURIComponent(slug)}` : "";
    return app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/browser/address-for-preview${q}`,
    });
  }
  async function previewFor(sessionId: number, url: string) {
    return app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/browser/preview-for-address?url=${encodeURIComponent(url)}`,
    });
  }
  function bindings(sessionId: number) {
    return app.db
      .select()
      .from(sessionBrowsers)
      .where(eq(sessionBrowsers.sessionId, sessionId))
      .all();
  }

  describe("preview -> agent's browser", () => {
    it("loads a local project's bare-port dev server as localhost, and binds nothing", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const res = await addressFor(sessionId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, url: "http://localhost:5173/" });
      expect(bindings(sessionId)).toEqual([]);
    });

    it("sends a dev server named by a public host as is", async () => {
      const projectId = addProject("local", "https://dev.example.com:8443/app");
      const sessionId = addSession(projectId, "local");
      expect((await addressFor(sessionId)).json()).toEqual({
        ok: true,
        url: "https://dev.example.com:8443/app",
      });
    });

    it("resolves localhost on the session's own host for a remote session", async () => {
      const hostA = await addHost();
      const projectId = addProject(hostA, "http://10.0.0.5:3000/app");
      const sessionId = addSession(projectId, hostA);
      // A remote project's dev server is always its host's loopback (only the
      // port and path are used), and the session's browser runs there too.
      expect((await addressFor(sessionId)).json()).toEqual({
        ok: true,
        url: "http://localhost:3000/app",
      });
      expect(bindings(sessionId)).toEqual([]);
    });

    it("refuses a loopback dev server on another host than the session's browser", async () => {
      const hostA = await addHost();
      const projectId = addProject(hostA, "5173");
      const sessionId = addSession(projectId, "local");
      const body = (await addressFor(sessionId)).json();
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/runs on handoff-host-\d+, and this session's browser on/);
    });

    it("takes the host from the session's recorded browser binding", async () => {
      const hostA = await addHost();
      const projectId = addProject(hostA, "5173");
      const sessionId = addSession(projectId, "local");
      app.db
        .insert(sessionBrowsers)
        .values({ sessionId, projectId, targetHostId: hostA, targetCheckoutRoot: cwd })
        .run();
      expect((await addressFor(sessionId)).json()).toEqual({
        ok: true,
        url: "http://localhost:5173/",
      });
    });

    it("loads a branch preview's own port, on its dock session's host", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const dock = addSession(projectId, "local");
      const slug = addPreview({ projectId, branch: "feat-x", sessionId: dock, upstreamPort: 4100 });
      expect((await addressFor(sessionId, slug)).json()).toEqual({
        ok: true,
        url: "http://localhost:4100/",
      });
    });

    it("loads a named preview target from its connection origin", async () => {
      const hostA = await addHost();
      const projectId = addProject(hostA, null);
      const targetId = `t-${++n}`;
      app.db
        .insert(projectPreviewTargets)
        .values({
          id: targetId,
          projectId,
          name: "Admin",
          destination: "http://localhost:9000/admin",
          connectionOrigin: "primary",
        })
        .run();
      const slug = addPreview({ kind: "target", projectId, targetId });
      const local = addSession(projectId, "local");
      const remote = addSession(projectId, hostA);
      expect((await addressFor(local, slug)).json()).toEqual({
        ok: true,
        url: "http://localhost:9000/admin",
      });
      expect((await addressFor(remote, slug)).json().ok).toBe(false);
    });

    it("refuses an external preview's slug and another project's preview", async () => {
      const projectId = addProject("local", "5173");
      const other = addProject("local", "5174");
      const sessionId = addSession(projectId, "local");
      const external = addPreview({ kind: "external", externalUrl: "https://example.com/" });
      const foreign = addPreview({ projectId: other, branch: "b", upstreamPort: 4200 });
      expect((await addressFor(sessionId, external)).json().ok).toBe(false);
      expect((await addressFor(sessionId, foreign)).json().ok).toBe(false);
      expect((await addressFor(sessionId, "no-such-slug")).json().ok).toBe(false);
    });

    it("refuses a project with no dev server", async () => {
      const projectId = addProject("local", null);
      const sessionId = addSession(projectId, "local");
      expect((await addressFor(sessionId)).json()).toEqual({
        ok: false,
        reason: "This preview has no address to open",
      });
    });

    it("answers 404 for an unknown session and 400 for a bad id", async () => {
      expect((await addressFor(999_999)).statusCode).toBe(404);
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/abc/browser/address-for-preview",
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("agent's browser -> preview", () => {
    it("opens the project's dev server through the proxy, keeping the path", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      for (const url of ["http://localhost:5173/a/b?x=1#h", "http://127.0.0.1:5173/a/b?x=1#h"]) {
        expect((await previewFor(sessionId, url)).json()).toEqual({
          kind: "project",
          label: "",
          path: "/a/b?x=1#h",
        });
      }
      expect(bindings(sessionId)).toEqual([]);
    });

    it("round-trips: the address it hands the agent comes back as the same preview", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const { url } = (await addressFor(sessionId)).json();
      expect((await previewFor(sessionId, url)).json()).toMatchObject({
        kind: "project",
        path: "/",
      });
    });

    it("finds a branch preview by its port", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const dock = addSession(projectId, "local");
      const slug = addPreview({ projectId, branch: "feat-y", sessionId: dock, upstreamPort: 4300 });
      expect((await previewFor(sessionId, "http://localhost:4300/x")).json()).toEqual({
        kind: "project",
        previewSlug: slug,
        label: "feat-y",
        path: "/x",
      });
    });

    it("finds a named preview target, with the path below its base", async () => {
      const projectId = addProject("local", null);
      const sessionId = addSession(projectId, "local");
      const targetId = `t-${++n}`;
      app.db
        .insert(projectPreviewTargets)
        .values({
          id: targetId,
          projectId,
          name: "Docs",
          destination: "https://docs.example.com/base",
        })
        .run();
      expect((await previewFor(sessionId, "https://docs.example.com/base/page")).json()).toEqual({
        kind: "project",
        targetId,
        label: "Docs",
        path: "/page",
      });
    });

    it("opens any other public page as an external address", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      expect((await previewFor(sessionId, "https://example.com/x")).json()).toEqual({
        kind: "external",
        url: "https://example.com/x",
      });
    });

    it("refuses a localhost page that is not one of the project's dev servers", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const body = (await previewFor(sessionId, "http://localhost:6000/")).json();
      expect(body.kind).toBe("disabled");
      expect(body.reason).toMatch(/localhost:6000 is not one of this project's dev servers/);
    });

    it("refuses the dev server's port when the session's browser runs on another host", async () => {
      const hostA = await addHost();
      const projectId = addProject(hostA, "5173");
      const sessionId = addSession(projectId, "local");
      expect((await previewFor(sessionId, "http://localhost:5173/")).json().kind).toBe("disabled");
      const remote = addSession(projectId, hostA);
      expect((await previewFor(remote, "http://localhost:5173/")).json().kind).toBe("project");
    });

    it("refuses anything that is not http or https", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      for (const url of ["about:blank", "file:///etc/passwd", "not a url"]) {
        expect((await previewFor(sessionId, url)).json().kind).toBe("disabled");
      }
    });

    it("answers 400 without a url and 404 for an unknown session", async () => {
      const projectId = addProject("local", "5173");
      const sessionId = addSession(projectId, "local");
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/browser/preview-for-address`,
      });
      expect(res.statusCode).toBe(400);
      expect((await previewFor(999_999, "https://example.com/")).statusCode).toBe(404);
    });
  });

  it("treats localhost, *.localhost, 127/8 and ::1 as loopback", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
    for (const h of ["example.com", "10.0.0.1", "localhost.example.com"]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});
