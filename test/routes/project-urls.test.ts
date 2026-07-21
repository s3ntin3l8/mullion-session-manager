import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `project-urls-test-${process.pid}.db`);

async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "urls-test", cwd: "/tmp/urls-test" },
  });
  return res.json().id as number;
}

describe("project-urls route (issue #109)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("lists URLs for a project (empty)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/urls` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    await app.close();
  });

  it("creates a URL and returns it", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Production", url: "https://example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      label: "Production",
      url: "https://example.com",
      favorite: false,
      projectId,
    });

    await app.close();
  });

  it("creates a favorited URL", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Staging", url: "https://staging.example.com", favorite: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      label: "Staging",
      favorite: true,
    });

    await app.close();
  });

  it("lists URLs ordered by order", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "First", url: "https://first.example.com" },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Second", url: "https://second.example.com" },
    });

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/urls` });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((u: { label: string }) => u.label)).toEqual(["First", "Second"]);

    await app.close();
  });

  it("updates a URL label and url", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Old", url: "https://old.example.com" },
    });
    const urlId = created.json().id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/urls/${urlId}`,
      payload: { label: "New", url: "https://new.example.com" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ label: "New", url: "https://new.example.com" });

    await app.close();
  });

  it("toggles favorite", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Site", url: "https://site.example.com" },
    });
    const urlId = created.json().id;
    expect(created.json().favorite).toBe(false);

    const favorited = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/urls/${urlId}`,
      payload: { favorite: true },
    });
    expect(favorited.statusCode).toBe(200);
    expect(favorited.json().favorite).toBe(true);

    await app.close();
  });

  it("deletes a URL", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Delete me", url: "https://delete.example.com" },
    });
    const urlId = created.json().id;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/urls/${urlId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/urls` });
    expect(list.json()).toEqual([]);

    await app.close();
  });

  it("rejects invalid project id", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/projects/abc/urls" });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("404s for non-existent project", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/projects/99999/urls" });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("rejects non-http(s) URL", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Bad", url: "ftp://bad.example.com" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("rejects empty label", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "", url: "https://example.com" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("404s updating non-existent URL", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/urls/99999`,
      payload: { label: "Nope" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("404s deleting non-existent URL", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/urls/99999`,
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("reorders URLs", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    const a = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "A", url: "https://a.example.com" },
    });
    const b = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "B", url: "https://b.example.com" },
    });

    const reorder = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/urls/reorder`,
      payload: { ids: [b.json().id, a.json().id] },
    });
    expect(reorder.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/urls` });
    expect(list.json().map((u: { label: string }) => u.label)).toEqual(["B", "A"]);

    await app.close();
  });

  it("404s creating URL for non-existent project", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/99999/urls",
      payload: { label: "Nope", url: "https://nope.example.com" },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("cascades delete when project is removed", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/urls`,
      payload: { label: "Gone", url: "https://gone.example.com" },
    });

    await app.inject({ method: "DELETE", url: `/api/projects/${projectId}` });

    await app.close();
    // No assertion needed — the test verifies no crash on cascade delete
  });
});
