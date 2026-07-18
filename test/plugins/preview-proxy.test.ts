import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createExternalPreview } from "../../src/services/preview-registry.js";

const tmpDb = path.join(os.tmpdir(), `preview-proxy-test-${process.pid}.db`);
const PREVIEW_BASE_HOST = "preview.test";

let stubServer: http.Server;
let stubPort: number;

async function createProjectWithDevServer(
  app: Awaited<ReturnType<typeof buildApp>>,
  devServerUrl: string | null,
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "proxy-test", cwd: "/tmp/preview-proxy-test" },
  });
  const projectId = created.json().id as number;
  if (devServerUrl !== null) {
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { devServerUrl },
    });
  }
  return projectId;
}

async function createProjectPreview(app: Awaited<ReturnType<typeof buildApp>>, projectId: number) {
  const res = await app.inject({
    method: "POST",
    url: "/api/previews",
    payload: { kind: "project", projectId },
  });
  return res.json().slug as string;
}

describe("preview proxy plugin (issue #28, phase 2)", () => {
  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = PREVIEW_BASE_HOST;

    stubServer = http.createServer((req, res) => {
      if (req.url === "/redirect-me") {
        res.writeHead(302, { Location: "/elsewhere" });
        res.end();
        return;
      }
      if (req.url === "/two-cookies") {
        res.writeHead(200, {
          "set-cookie": ["a=1", "b=2"],
          "content-type": "text/plain",
        });
        res.end("cookies");
        return;
      }
      res.writeHead(200, {
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
        "x-upstream-marker": "dev-server",
        "content-type": "application/json",
      });
      // JSON, not interpolated into HTML: req.headers.host/req.url are
      // attacker-influenced in a real deployment (the whole request is
      // forwarded verbatim — see buildUpstreamRequestHeaders), and
      // CodeQL correctly flags string-interpolating them into an HTML
      // response body as a reflected-XSS pattern even though this is a
      // throwaway test stub, not the app itself.
      res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
    });
    await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
    stubPort = (stubServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it("proxies a request to the project's dev server and strips framing headers", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/some/asset.js",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("/some/asset.js");
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
    // Non-stripped upstream headers still pass through untouched.
    expect(res.headers["x-upstream-marker"]).toBe("dev-server");

    await app.close();
  });

  it("rewrites the upstream Host header to the dev server's own host", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
    await app.close();
  });

  it("forwards every value of a multi-value response header (Set-Cookie)", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/two-cookies",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    await app.close();
  });

  it("forwards a redirect as-is rather than following it", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/redirect-me",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/elsewhere");
    await app.close();
  });

  it("responds with no body for HEAD", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "HEAD",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    await app.close();
  });

  it("404s an unknown slug", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-does-not-exist.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("503s when the project has no devServerUrl configured", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, null);
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("502s when the dev server is unreachable", async () => {
    const app = await buildApp();
    // Port 1 is a real, always-refused loopback port (same convention the
    // multi-host tests use for "unreachable").
    const projectId = await createProjectWithDevServer(app, "1");
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it("leaves ordinary dashboard-host requests unaffected", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.statusCode).toBe(200);
    expect(res.json().previewsEnabled).toBe(true);
    await app.close();
  });

  it("honors a full-URL devServerUrl's own host, not just a bare port", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, `http://127.0.0.1:${stubPort}/`);
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
    await app.close();
  });

  it("preserves a full-URL devServerUrl's own base path as a prefix", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, `http://127.0.0.1:${stubPort}/sub`);
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/asset.js?v=1",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(200);
    // "/sub" (devServerUrl's own path) + "/asset.js?v=1" (the browser's
    // request) — not just "/asset.js?v=1", which is what plain
    // `new URL(requestPath, base)` resolution would silently collapse to
    // (an absolute-path reference replaces the base's path entirely; see
    // buildUpstreamUrl's own comment).
    expect(res.json().path).toBe("/sub/asset.js?v=1");
    await app.close();
  });

  it("proxies an external-kind preview to its stored URL (issue #28 phase 5)", async () => {
    const app = await buildApp();
    // Seeds the row directly via the service layer rather than
    // POST /api/previews: the route's SSRF guard (previews.test.ts,
    // url-guard.test.ts) rejects a loopback URL like this stub server's,
    // by design — this test is about the *proxy* correctly handling an
    // "external" target once one exists, not about re-testing that guard.
    const preview = createExternalPreview(app, `http://127.0.0.1:${stubPort}/ext-path`);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${preview.slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(JSON.parse(res.body).path).toBe("/ext-path/");
    await app.close();
  });

  it("503s a remote-hosted project's preview — not proxied until issue #28 phase 6", async () => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-box", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-proxy-test", cwd: "/x", hostId: host.json().id },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { devServerUrl: "5173" },
    });
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("installs no onRequest hook when PREVIEW_BASE_HOST is unset, even for a real slug", async () => {
    // Create a genuinely valid, resolvable preview while the feature is
    // enabled — proving the DB row exists and would serve successfully
    // (per the very first test in this file) — then rebuild the app with
    // PREVIEW_BASE_HOST unset and confirm that exact same slug's Host
    // header no longer does anything special. A made-up slug would 404
    // either way (hook installed-but-unresolvable vs. hook not installed
    // at all look identical); reusing a real one is what actually proves
    // the hook itself is gone, not just that this particular slug failed
    // to resolve.
    const upApp = await buildApp();
    const projectId = await createProjectWithDevServer(upApp, String(stubPort));
    const slug = await createProjectPreview(upApp, projectId);
    await upApp.close();

    delete process.env.PREVIEW_BASE_HOST;
    const downApp = await buildApp();
    // Not "/" — rootRoute serves that unconditionally regardless of Host,
    // which would make this pass even if the hook were still (wrongly)
    // installed and merely failing to route "/" correctly. A path no
    // other route claims isolates what's actually under test.
    const res = await downApp.inject({
      method: "GET",
      url: "/definitely-not-a-real-route",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    expect(res.statusCode).toBe(404);
    process.env.PREVIEW_BASE_HOST = PREVIEW_BASE_HOST;
    await downApp.close();
  });
});
