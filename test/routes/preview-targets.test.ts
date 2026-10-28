import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  getOrCreateProjectPreview,
  upsertBranchPreview,
} from "../../src/services/preview-registry.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { projects, previews } from "../../src/db/schema.js";
import { normalizePreviewDestination } from "../../src/services/preview-targets.js";

describe("named project previews", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let server: http.Server;
  let port: number;
  let projectId: number;
  const target = {
    id: "docker-web",
    name: "Docker · web",
    destination: "192.168.1.20:8080",
    connectionOrigin: "primary",
  };
  const path = () => `/api/projects/${projectId}/preview-targets`;
  beforeAll(async () => {
    process.env.PREVIEW_BASE_HOST = "preview.test";
    app = await buildApp();
    projectId = app.db
      .insert(projects)
      .values({ name: "named-targets", cwd: "/tmp/named-targets" })
      .returning()
      .get().id;
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          path: req.url,
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.PREVIEW_BASE_HOST;
  });

  it.each(["", "feature/collision"])(
    "retries a random slug collision for project branch %s",
    (branch) => {
      const id = app.db
        .insert(projects)
        .values({ name: "collision", cwd: "/tmp/collision" })
        .returning()
        .get().id;
      const occupied = crypto.randomUUID();
      const fresh = crypto.randomUUID();
      app.db
        .insert(previews)
        .values({ slug: occupied, kind: "external", externalUrl: "https://example.test" })
        .run();
      const random = vi
        .spyOn(crypto, "randomUUID")
        .mockReturnValueOnce(occupied)
        .mockReturnValueOnce(fresh);
      try {
        const preview = branch
          ? upsertBranchPreview(app, id, branch)
          : getOrCreateProjectPreview(app, id);
        expect(preview.slug).toBe(fresh);
        expect(random).toHaveBeenCalledTimes(2);
      } finally {
        random.mockRestore();
      }
    },
  );

  it.each([
    ["5173", "http://127.0.0.1:5173/"],
    ["192.168.1.20:8080/docs?a=1", "http://192.168.1.20:8080/docs?a=1"],
    ["localhost:3000", "http://localhost:3000/"],
    ["https://example.com/docs", "https://example.com/docs"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["0", null],
    ["65536", null],
    ["http://localhost:0", null],
    ["javascript:alert(1)", null],
    ["ftp://example.com", null],
    ["http://user:pass@example.com", null], // pragma: allowlist secret
    ["http://169.254.169.254", null],
    ["", null],
  ])("normalizes %s", (input, expected) =>
    expect(normalizePreviewDestination(input!)).toBe(expected),
  );

  it("loads and atomically saves the default and independently named destinations", async () => {
    expect((await app.inject({ url: path() })).json()).toMatchObject({
      devServerUrl: null,
      targets: [],
    });
    const saved = await app.inject({
      method: "PUT",
      url: path(),
      payload: { devServerUrl: "3005", targets: [target] },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      devServerUrl: "3005",
      targets: [{ ...target, destination: "http://192.168.1.20:8080/" }],
    });
    const bad = await app.inject({
      method: "PUT",
      url: path(),
      payload: { devServerUrl: "4000", targets: [{ ...target, destination: "javascript:bad" }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: path() })).json().devServerUrl).toBe("3005");
  });

  it("rejects duplicate IDs, blank names, invalid defaults and foreign target ownership", async () => {
    for (const config of [
      { devServerUrl: null, targets: [target, target] },
      { devServerUrl: null, targets: [{ ...target, name: " " }] },
      { devServerUrl: "bad", targets: [] },
    ])
      expect((await app.inject({ method: "PUT", url: path(), payload: config })).statusCode).toBe(
        400,
      );
    const otherId = app.db
      .insert(projects)
      .values({ name: "other-targets", cwd: "/tmp/other-targets" })
      .returning()
      .get().id;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${otherId}/preview-targets`,
          payload: { devServerUrl: null, targets: [target] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: "/api/projects/999999/preview-targets" })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/projects/999999/preview-targets",
          payload: { devServerUrl: null, targets: [] },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/previews",
          payload: { kind: "target", projectId: otherId, targetId: target.id },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("keeps named targets separate from checkout previews, preserves slugs on edit, and removes them on deletion", async () => {
    const open = () =>
      app.inject({
        method: "POST",
        url: "/api/previews",
        payload: { kind: "target", projectId, targetId: target.id },
      });
    const first = await open();
    expect(first.statusCode).toBe(201);
    const slug = first.json().slug;
    expect((await open()).json().slug).toBe(slug);
    const checkout = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    expect(checkout.statusCode).toBe(201);
    expect(checkout.json().slug).not.toBe(slug);
    await app.inject({
      method: "PUT",
      url: path(),
      payload: {
        devServerUrl: null,
        targets: [{ ...target, destination: `http://127.0.0.1:${port}/docs?configured=yes` }],
      },
    });
    expect((await open()).json().slug).toBe(slug);
    const proxied = await app.inject({
      url: "/page?q=one",
      headers: { host: `preview-${slug}.preview.test`, authorization: "Bearer must-not-leak" },
    });
    expect(proxied.statusCode).toBe(200);
    expect(proxied.json()).toEqual({ path: "/docs/page?q=one&configured=yes" });
    await app.inject({
      method: "PUT",
      url: path(),
      payload: {
        devServerUrl: null,
        targets: [{ ...target, destination: `http://127.0.0.1:${port}//?configured=yes` }],
      },
    });
    const pinned = await app.inject({
      url: "/192.168.1.20:9000/private",
      headers: { host: `preview-${slug}.preview.test` },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().path).toBe("//192.168.1.20:9000/private?configured=yes");
    await app.inject({ method: "PUT", url: path(), payload: { devServerUrl: null, targets: [] } });
    expect((await app.inject({ url: `/api/previews/${slug}` })).statusCode).toBe(404);
    expect(
      app.db.select().from(projects).where(eq(projects.id, projectId)).get()!.devServerUrl,
    ).toBeNull();
  });
  it("explains that named targets require proxy mode while preserving legacy disabled behavior", async () => {
    await app.close();
    delete process.env.PREVIEW_BASE_HOST;
    app = await buildApp();
    const result = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "target", projectId, targetId: "web" },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().message).toContain("PREVIEW_BASE_HOST");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/previews",
          payload: { kind: "project", projectId },
        })
      ).statusCode,
    ).toBe(404);
  });
});
