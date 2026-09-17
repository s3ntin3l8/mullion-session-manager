import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { previews } from "../../src/db/schema.js";
import { verifyPreviewToken } from "../../src/services/preview-auth.js";

const tmpDb = path.join(os.tmpdir(), `previews-test-${process.pid}.db`);

async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { createDir: true, name: "with-dev-server", cwd: "/tmp/previews-test" },
  });
  return res.json().id as number;
}

describe("previews route (issue #28)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("creates a project preview with a slug", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ kind: "project", projectId, externalUrl: null });
    expect(typeof body.slug).toBe("string");
    expect(body.slug.length).toBeGreaterThan(0);

    await app.close();
  });

  it("upserts by projectId — reopening the same project's preview reuses its slug", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const first = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().slug).toBe(first.json().slug);

    await app.close();
  });

  it("404s creating a preview for an unknown projectId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId: 999999 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a project preview missing projectId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("creates, resolves, and deletes an external preview", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com/path" },
    });
    expect(created.statusCode).toBe(201);
    const { slug } = created.json();
    expect(created.json()).toMatchObject({
      kind: "external",
      externalUrl: "https://example.com/path",
      projectId: null,
    });

    const resolved = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ slug, kind: "external" });

    const deleted = await app.inject({ method: "DELETE", url: `/api/previews/${slug}` });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(afterDelete.statusCode).toBe(404);

    await app.close();
  });

  it("rejects a malformed external url", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-http(s) external url", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "ftp://example.com" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404s resolving an unknown slug", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/previews/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s deleting an unknown slug", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/previews/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lists all previews and leaves get/delete working (create -> list -> get/delete round trip)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const projectPreview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const externalPreview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com/list-test" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json();
    expect(Array.isArray(rows)).toBe(true);

    const slugs = rows.map((r: { slug: string }) => r.slug);
    expect(slugs).toContain(projectPreview.json().slug);
    expect(slugs).toContain(externalPreview.json().slug);

    // get/delete are unaffected by the new list route.
    const slug = externalPreview.json().slug;
    const resolved = await app.inject({ method: "GET", url: `/api/previews/${slug}` });
    expect(resolved.statusCode).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: `/api/previews/${slug}` });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({ method: "GET", url: "/api/previews" });
    expect(afterDelete.json().map((r: { slug: string }) => r.slug)).not.toContain(slug);

    await app.close();
  });

  describe("POST /api/previews/:slug/token (issue #383)", () => {
    it("mints a bootstrap token for a known slug", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId },
      });
      const { slug } = created.json();

      const res = await app.inject({ method: "POST", url: `/api/previews/${slug}/token` });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().token).toBe("string");
      expect(res.json().token.length).toBeGreaterThan(0);

      await app.close();
    });

    it("404s for an unknown slug", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/previews/does-not-exist/token",
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("GET /api/previews/:slug/open (issue #1316)", () => {
    it("redirects to the preview root with no token when PREVIEW_AUTH_REQUIRED is off", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "project", projectId },
      });
      const { slug } = created.json();

      const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`http://preview-${slug}.preview.example.com/`);
      await app.close();
    });

    it("404s for an unknown slug", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/previews/does-not-exist/open" });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  it("orders results newest first (desc by createdAt)", async () => {
    const app = await buildApp();

    // Insert directly with explicit, well-separated createdAt values so the
    // ordering assertion doesn't depend on two real-time inserts landing in
    // different seconds (the column has second-level precision).
    app.db
      .insert(previews)
      .values({
        slug: "older-preview",
        kind: "external",
        externalUrl: "https://example.com/older",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      })
      .run();
    app.db
      .insert(previews)
      .values({
        slug: "newer-preview",
        kind: "external",
        externalUrl: "https://example.com/newer",
        createdAt: new Date("2021-01-01T00:00:00Z"),
      })
      .run();

    const listed = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listed.statusCode).toBe(200);
    const slugs = listed.json().map((r: { slug: string }) => r.slug);
    expect(slugs.indexOf("newer-preview")).toBeLessThan(slugs.indexOf("older-preview"));

    await app.close();
  });
});

describe("GET /api/previews/:slug/open with PREVIEW_AUTH_REQUIRED=true (issue #1316)", () => {
  const localTmpDb = path.join(os.tmpdir(), `previews-open-auth-test-${process.pid}.db`);
  const TEST_AUTH_TOKEN = "test-previews-open-dashboard-token-0123456789";
  const DASHBOARD_AUTH_HEADERS = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };

  beforeAll(() => {
    fs.rmSync(localTmpDb, { force: true });
    process.env.DATABASE_URL = `file:${localTmpDb}`;
    process.env.PREVIEW_BASE_HOST = "preview.example.com";
    process.env.PREVIEW_AUTH_REQUIRED = "true";
    process.env.MULLION_SESSION_SECRET = "test-previews-open-session-secret-0123456789"; // pragma: allowlist secret
    process.env.MULLION_AUTH_TOKEN = TEST_AUTH_TOKEN;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(localTmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
    delete process.env.PREVIEW_AUTH_REQUIRED;
    delete process.env.MULLION_SESSION_SECRET;
    delete process.env.MULLION_AUTH_TOKEN;
  });

  async function createAuthedProjectPreview(app: Awaited<ReturnType<typeof buildApp>>) {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "open-route-test", cwd: "/tmp/previews-open-test" },
      headers: DASHBOARD_AUTH_HEADERS,
    });
    const projectId = created.json().id as number;
    const preview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
      headers: DASHBOARD_AUTH_HEADERS,
    });
    return preview.json().slug as string;
  }

  it("401s an unauthenticated request the same as the JSON gate would, when PREVIEW_AUTH_DASHBOARD_URL is unset", async () => {
    // This route is exempted from src/plugins/auth.ts's generic /api/* gate
    // (issue #1316, addressing review feedback that a raw JSON 401 was a
    // dead end for a plain `<a href>` navigation) — but with no dashboard
    // URL configured to redirect to, there's truly nowhere else to send an
    // unauthenticated caller, so the handler itself falls back to the same
    // plain-JSON 401 that gate would have sent.
    const app = await buildApp();
    const slug = await createAuthedProjectPreview(app);

    const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("redirects an unauthenticated request to PREVIEW_AUTH_DASHBOARD_URL when configured (issue #1316)", async () => {
    process.env.PREVIEW_AUTH_DASHBOARD_URL = "https://dashboard.example.com";
    try {
      const app = await buildApp();
      const slug = await createAuthedProjectPreview(app);

      const res = await app.inject({ method: "GET", url: `/api/previews/${slug}/open` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("https://dashboard.example.com");
      await app.close();
    } finally {
      delete process.env.PREVIEW_AUTH_DASHBOARD_URL;
    }
  });

  it("mints a fresh bootstrap token and redirects an authenticated session to the preview, token in the query string", async () => {
    const app = await buildApp();
    const slug = await createAuthedProjectPreview(app);

    const res = await app.inject({
      method: "GET",
      url: `/api/previews/${slug}/open`,
      headers: DASHBOARD_AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(`http://preview-${slug}.preview.example.com`);
    const token = location.searchParams.get("__mullion_preview");
    expect(token).toBeTruthy();
    expect(verifyPreviewToken(app.config.MULLION_SESSION_SECRET, token ?? undefined, slug)).toBe(
      true,
    );
    await app.close();
  });

  it("404s for an unknown slug even when authenticated", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/previews/does-not-exist/open",
      headers: DASHBOARD_AUTH_HEADERS,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("previews route with PREVIEW_BASE_HOST unset (default, feature opt-in)", () => {
  const localTmpDb = path.join(os.tmpdir(), `previews-disabled-test-${process.pid}.db`);

  beforeAll(() => {
    fs.rmSync(localTmpDb, { force: true });
    process.env.DATABASE_URL = `file:${localTmpDb}`;
    delete process.env.PREVIEW_BASE_HOST;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(localTmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("registers no preview routes", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "external", url: "https://example.com" },
    });
    expect(res.statusCode).toBe(404);

    const listRes = await app.inject({ method: "GET", url: "/api/previews" });
    expect(listRes.statusCode).toBe(404);

    await app.close();
  });
});
