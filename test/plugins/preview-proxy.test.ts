import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createExternalPreview } from "../../src/services/preview-registry.js";
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_TOKEN_QUERY_PARAM,
  mintPreviewCookie,
  mintPreviewToken,
} from "../../src/services/preview-auth.js";
import {
  resetPreviewAuthFailuresForTests,
  resetPreviewRequestCountsForTests,
} from "../../src/plugins/preview-proxy.js";

const tmpDb = path.join(os.tmpdir(), `preview-proxy-test-${process.pid}.db`);
const PREVIEW_BASE_HOST = "preview.test";

let stubServer: http.Server;
let stubPort: number;

// A fixed set the /emit-location stub route selects from by `kind` — see
// that route's own comment on why this isn't just the query param's value
// forwarded straight into the Location header.
function locationForKind(kind: string | null): string {
  switch (kind) {
    case "same-origin":
      return `http://127.0.0.1:${stubPort}/en?a=1#f`;
    case "same-origin-created":
      return `http://127.0.0.1:${stubPort}/created`;
    case "same-origin-subpath":
      return `http://127.0.0.1:${stubPort}/sub/other`;
    case "external":
      return "https://example.com/x";
    case "malformed":
      return "not a valid url ::::";
    default:
      return "";
  }
}

async function createProjectWithDevServer(
  app: Awaited<ReturnType<typeof buildApp>>,
  devServerUrl: string | null,
  // Empty by default — only the "with PREVIEW_AUTH_REQUIRED=true" describe
  // block below needs this: it also sets MULLION_AUTH_TOKEN (required by
  // app.ts's own boot invariant once PREVIEW_AUTH_REQUIRED is on), which
  // turns authPlugin's gate on for these dashboard-host setup requests too.
  headers: Record<string, string> = {},
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "proxy-test", cwd: "/tmp/preview-proxy-test" },
    headers,
  });
  const projectId = created.json().id as number;
  if (devServerUrl !== null) {
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { devServerUrl },
      headers,
    });
  }
  return projectId;
}

async function createProjectPreview(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: number,
  headers: Record<string, string> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/previews",
    payload: { kind: "project", projectId },
    headers,
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
      // Query-driven so tests can request an arbitrary status/Location
      // combination (absolute same-origin, absolute base-path, external,
      // malformed, non-3xx) without a dedicated stub route per case.
      // Matched by suffix, not startsWith: a devServerUrl base path (e.g.
      // "/sub") is prepended by buildUpstreamUrl before this ever sees the
      // request, so the actual incoming path is "/sub/emit-location". The
      // emitted Location is looked up from `kind` against a fixed,
      // server-side map rather than reflected straight from the query
      // string — CodeQL's js/server-side-unvalidated-url-redirection query
      // otherwise (correctly, for real server code) flags an
      // attacker-controlled value flowing into a Location header; `kind`
      // only ever selects among these constants, never becomes the header
      // value itself.
      if (req.url && new URL(req.url, "http://placeholder").pathname.endsWith("/emit-location")) {
        const params = new URL(req.url, "http://placeholder").searchParams;
        const status = Number(params.get("status") ?? "307");
        res.writeHead(status, { Location: locationForKind(params.get("kind")) });
        res.end();
        return;
      }
      // Any method other than GET/HEAD: echo back what actually arrived
      // (method, path, headers, body) instead of the default GET-only
      // {host, path} payload below — this is what the request-body-
      // streaming and forwarded-header-stripping tests inspect.
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
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
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, headers: req.headers }));
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

  it("refuses an external-kind preview whose stored URL points at loopback (issue #250)", async () => {
    const app = await buildApp();
    // Seeds the row directly via the service layer rather than
    // POST /api/previews: the route's SSRF guard (previews.test.ts,
    // url-guard.test.ts) rejects a loopback URL like this stub server's,
    // by design. Before issue #250 that made this a *proxy mechanics* test
    // — the row couldn't be created through the product, but once it
    // existed the proxy happily fetched it. The connect-time guard now
    // re-runs the same policy against the row on every request instead of
    // trusting that it was validated when it was written, so the fetch
    // never leaves the process.
    //
    // That's why there is no hermetic "external preview proxies a body"
    // test any more: under the external policy the only reachable stub is
    // one bound to loopback, which is exactly what the guard exists to
    // refuse. The proxying itself is unchanged and identical for both
    // kinds — resolveUpstreamBase hands back a base URL and everything
    // downstream is shared (see its own comment) — and is covered by the
    // project-kind cases above.
    const preview = createExternalPreview(app, `http://127.0.0.1:${stubPort}/ext-path`);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${preview.slug}.${PREVIEW_BASE_HOST}` },
    });
    // 502, not a 404/503: the external row resolved fine and produced its
    // stored origin — the guard is what stopped it, one step later.
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain(`http://127.0.0.1:${stubPort}`);
    await app.close();
  });

  // The other half of that split — a *project*-kind preview on the very same
  // loopback stub must keep working, since an admin-configured dev server on
  // loopback is the normal case — is already covered above by "honors a
  // full-URL devServerUrl's own host". Together the two pin the policy split:
  // collapse them into one policy and exactly one of the pair breaks.

  it("502s a remote-hosted project's preview when its owning agent is unreachable (issue #28 phase 6)", async () => {
    // The real two-hop-through-a-live-agent path is covered end-to-end in
    // test/integration/multi-host-preview.test.ts (two real buildApp()
    // instances) — this just proves the primary attempts the two-hop
    // forward (via RemoteHostClient.openPreviewHttp) rather than the old
    // phase-5-and-earlier "not supported yet" 503, and fails gracefully
    // (502, not a 500/hang) when the agent can't actually be reached.
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
    expect(res.statusCode).toBe(502);
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

  it("strips forwarded-address headers before the upstream hop (the actual 421 regression)", async () => {
    // A Traefik-style front end sets these on every request it forwards; a
    // dev server that trusts x-forwarded-host over host (as this bug's
    // reporting app did) would see the *public* preview hostname instead
    // of its own — reproducing the "Misdirected Request" 421 this whole
    // change exists to fix. Also proves an unrelated pass-through header
    // still survives, so this isn't just "everything got dropped".
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: `preview-${slug}.${PREVIEW_BASE_HOST}`,
        "x-forwarded-host": `preview-${slug}.${PREVIEW_BASE_HOST}`,
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
        "x-forwarded-for": "203.0.113.5",
        "x-forwarded-prefix": "/whatever",
        forwarded: "for=203.0.113.5;proto=https",
        "x-real-ip": "203.0.113.5",
        "x-keep": "still-here",
      },
    });

    expect(res.statusCode).toBe(200);
    const upstreamHeaders = res.json().headers as Record<string, string | undefined>;
    expect(res.json().host).toBe(`127.0.0.1:${stubPort}`);
    expect(upstreamHeaders["x-forwarded-host"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-proto"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-port"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-for"]).toBeUndefined();
    expect(upstreamHeaders["x-forwarded-prefix"]).toBeUndefined();
    expect(upstreamHeaders["forwarded"]).toBeUndefined();
    expect(upstreamHeaders["x-real-ip"]).toBeUndefined();
    expect(upstreamHeaders["x-keep"]).toBe("still-here");
    await app.close();
  });

  // Finding AS4 — a `kind: "project"` preview with a local devServerUrl (or
  // a `kind: "external"` preview — same direct-fetch hop, see
  // buildUpstreamRequestHeaders' own call at this site) must never forward
  // either credential a client attaches to reach the preview proxy itself
  // onward to a target this proxy doesn't control. Mirrors the agent-side
  // hop's own `extraExcluded: ["authorization"]` (http-proxy.ts/internal.ts)
  // — this is the primary's own direct-fetch hop, which used to pass no
  // exclusions at all.
  it("never forwards Authorization or the mullion_preview auth cookie to the upstream dev server", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);
    const cookieValue = mintPreviewCookie(app.config.MULLION_SESSION_SECRET, slug);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: `preview-${slug}.${PREVIEW_BASE_HOST}`,
        authorization: "Bearer forwarded-token-must-not-leak",
        "proxy-authorization": "Basic forwarded-proxy-token-must-not-leak",
      },
      cookies: {
        [PREVIEW_COOKIE_NAME]: cookieValue,
        "unrelated-cookie": "keep-me",
      },
    });

    expect(res.statusCode).toBe(200);
    const upstreamHeaders = res.json().headers as Record<string, string | undefined>;
    expect(upstreamHeaders["authorization"]).toBeUndefined();
    expect(upstreamHeaders["proxy-authorization"]).toBeUndefined();
    // The preview auth cookie is stripped, but an unrelated cookie the
    // browser happens to also send survives — proves this isn't just
    // dropping the whole Cookie header.
    expect(upstreamHeaders["cookie"]).not.toContain(PREVIEW_COOKIE_NAME);
    expect(upstreamHeaders["cookie"]).toContain("unrelated-cookie=keep-me");
    await app.close();
  });

  it("strips a Cookie header down to nothing when the preview auth cookie was the only cookie present", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);
    const cookieValue = mintPreviewCookie(app.config.MULLION_SESSION_SECRET, slug);

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
      cookies: { [PREVIEW_COOKIE_NAME]: cookieValue },
    });

    expect(res.statusCode).toBe(200);
    const upstreamHeaders = res.json().headers as Record<string, string | undefined>;
    expect(upstreamHeaders["cookie"]).toBeUndefined();
    await app.close();
  });

  // Finding AS5 — preview-host traffic is exempt from securityPlugin's
  // app-wide rate limiter (see that plugin's own comment on why), and the
  // only compensating counter (previewAuthFailures) was only ever reachable
  // inside the PREVIEW_AUTH_REQUIRED branch, which defaults off. This test
  // runs with PREVIEW_AUTH_REQUIRED unset (this describe block's default
  // env), proving the new isPreviewRequestRateLimited meter now bounds
  // preview-host request volume regardless.
  it("caps preview-host request volume per-IP even with PREVIEW_AUTH_REQUIRED unset", async () => {
    resetPreviewRequestCountsForTests();
    // A low, test-only ceiling (app.config.PREVIEW_RATE_LIMIT_MAX, env.ts) —
    // the real default (2000/min) exists to survive a legitimate dev
    // server's cold-load fan-out and would make this loop impractically
    // slow; the mechanism under test (isPreviewRequestRateLimited) doesn't
    // care what the number is, only that it's enforced.
    process.env.PREVIEW_RATE_LIMIT_MAX = "5";
    try {
      const app = await buildApp();
      const projectId = await createProjectWithDevServer(app, String(stubPort));
      const slug = await createProjectPreview(app, projectId);
      // TEST-NET-3 (RFC 5737) — unique to this test so its counter can't
      // collide with any other test's default injected remoteAddress.
      const REMOTE = "203.0.113.20";

      let lastStatus = 0;
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          remoteAddress: REMOTE,
        });
        lastStatus = res.statusCode;
      }
      expect(lastStatus).toBe(429);

      // A different client (distinct remoteAddress) is unaffected — the
      // bound is per-IP, not global.
      const otherClient = await app.inject({
        method: "GET",
        url: "/",
        headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        remoteAddress: "203.0.113.21",
      });
      expect(otherClient.statusCode).toBe(200);
      await app.close();
    } finally {
      delete process.env.PREVIEW_RATE_LIMIT_MAX;
      resetPreviewRequestCountsForTests();
    }
  });

  it("relativizes an absolute same-origin redirect Location", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: `/emit-location?status=307&kind=same-origin`,
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("/en?a=1#f");
    await app.close();
  });

  it("leaves an external redirect Location untouched", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: `/emit-location?status=302&kind=external`,
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.headers.location).toBe("https://example.com/x");
    await app.close();
  });

  it("relativizes an absolute same-origin Location within a devServerUrl base path", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, `http://127.0.0.1:${stubPort}/sub`);
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: `/emit-location?status=307&kind=same-origin-subpath`,
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.headers.location).toBe("/other");
    await app.close();
  });

  it("relativizes a same-origin Location even on a non-3xx status", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: `/emit-location?status=201&kind=same-origin-created`,
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe("/created");
    await app.close();
  });

  it("leaves a malformed Location header untouched", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "GET",
      url: `/emit-location?status=302&kind=malformed`,
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.headers.location).toBe("not a valid url ::::");
    await app.close();
  });

  it("proxies a POST body through to the dev server without a stale content-length", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "POST",
      url: "/api/whatever",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}`, "content-type": "application/json" },
      payload: JSON.stringify({ hello: "world" }),
    });

    expect(res.statusCode).toBe(200);
    const echoed = res.json();
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe(JSON.stringify({ hello: "world" }));
    expect(echoed.headers["content-length"]).toBeUndefined();
    await app.close();
  });

  it("proxies a bodyless DELETE without inventing chunked framing", async () => {
    const app = await buildApp();
    const projectId = await createProjectWithDevServer(app, String(stubPort));
    const slug = await createProjectPreview(app, projectId);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/whatever/1",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });

    expect(res.statusCode).toBe(200);
    const echoed = res.json();
    expect(echoed.method).toBe("DELETE");
    expect(echoed.headers["transfer-encoding"]).toBeUndefined();
    expect(echoed.headers["content-length"]).toBeUndefined();
    await app.close();
  });

  it("404s a POST to an unknown preview host rather than reaching Mullion's own API", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: `preview-does-not-exist.${PREVIEW_BASE_HOST}` },
      payload: { name: "should-not-be-created", cwd: "/tmp" },
    });
    expect(res.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/projects" });
    const names = (list.json() as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain("should-not-be-created");
    await app.close();
  });

  describe("preview-host auth token (issue #383)", () => {
    const TEST_SECRET = "test-preview-auth-secret-0123456789";

    afterAll(() => {
      delete process.env.PREVIEW_AUTH_REQUIRED;
      delete process.env.MULLION_SESSION_SECRET;
    });

    it("gate off (default): a garbage token param is ignored and passed straight through unstripped — byte-identical to before this feature existed", async () => {
      const app = await buildApp();
      const projectId = await createProjectWithDevServer(app, String(stubPort));
      const slug = await createProjectPreview(app, projectId);

      const res = await app.inject({
        method: "GET",
        url: `/?${PREVIEW_TOKEN_QUERY_PARAM}=garbage`,
        headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
      });

      expect(res.statusCode).toBe(200);
      // Gate off means buildUpstreamUrl's stripPreviewToken flag never runs
      // — the param rides straight through to the upstream dev server,
      // proving nothing about the proxy's query-string handling changed.
      expect(res.json().path).toBe(`/?${PREVIEW_TOKEN_QUERY_PARAM}=garbage`);
      await app.close();
    });

    describe("with PREVIEW_AUTH_REQUIRED=true", () => {
      const TEST_AUTH_TOKEN = "test-preview-proxy-dashboard-token-0123456789";
      // src/app.ts's own boot invariant requires in-process auth to be
      // configured whenever PREVIEW_AUTH_REQUIRED is on (see issue #383) —
      // so this also turns authPlugin's dashboard-host gate on, which is why
      // every createProjectWithDevServer/createProjectPreview setup call
      // below passes this as a Bearer header (those go to the dashboard
      // host, not a preview Host, so they don't get authPlugin's preview
      // bypass).
      const DASHBOARD_AUTH_HEADERS = { authorization: `Bearer ${TEST_AUTH_TOKEN}` };

      beforeAll(() => {
        process.env.PREVIEW_AUTH_REQUIRED = "true";
        process.env.MULLION_SESSION_SECRET = TEST_SECRET;
        process.env.MULLION_AUTH_TOKEN = TEST_AUTH_TOKEN;
      });

      afterAll(() => {
        delete process.env.MULLION_AUTH_TOKEN;
      });

      it("401s with no credential at all", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);

        const res = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers["content-type"]).toMatch(/text\/html/);
        await app.close();
      });

      it("a valid bootstrap token redirects, sets the preview cookie, and strips the token from the redirect Location", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const token = mintPreviewToken(TEST_SECRET, slug);

        const res = await app.inject({
          method: "GET",
          url: `/some/path?foo=bar&${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`,
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("/some/path?foo=bar");
        const cookie = res.cookies.find((c) => c.name === PREVIEW_COOKIE_NAME);
        expect(cookie).toBeDefined();
        expect(cookie?.httpOnly).toBe(true);
        // app.inject() is always plain HTTP with no x-forwarded-proto here,
        // so this is the plain-http fallback branch — see the sibling https
        // test below for the Secure/SameSite=None/Partitioned branch.
        expect(cookie?.sameSite).toBe("Lax");
        await app.close();
      });

      it("sets Secure/SameSite=None/Partitioned when the request arrived over https (via X-Forwarded-Proto, since app.inject() has no real TLS socket)", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const token = mintPreviewToken(TEST_SECRET, slug);

        const res = await app.inject({
          method: "GET",
          url: `/?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`,
          headers: {
            host: `preview-${slug}.${PREVIEW_BASE_HOST}`,
            "x-forwarded-proto": "https",
          },
        });

        expect(res.statusCode).toBe(302);
        const cookie = res.cookies.find((c) => c.name === PREVIEW_COOKIE_NAME);
        expect(cookie).toBeDefined();
        expect(cookie?.secure).toBe(true);
        expect(cookie?.sameSite).toBe("None");
        expect((cookie as unknown as { partitioned?: boolean }).partitioned).toBe(true);
        await app.close();
      });

      it("a valid preview cookie proxies normally (200)", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const cookieValue = mintPreviewCookie(TEST_SECRET, slug);

        const res = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          cookies: { [PREVIEW_COOKIE_NAME]: cookieValue },
        });
        expect(res.statusCode).toBe(200);
        await app.close();
      });

      it("401s a tampered token", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const token = mintPreviewToken(TEST_SECRET, slug);

        const res = await app.inject({
          method: "GET",
          url: `/?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}x`,
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        });
        expect(res.statusCode).toBe(401);
        await app.close();
      });

      it("401s a token minted for a different slug (defense in depth)", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const otherProjectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const otherSlug = await createProjectPreview(app, otherProjectId, DASHBOARD_AUTH_HEADERS);
        const tokenForOtherSlug = mintPreviewToken(TEST_SECRET, otherSlug);

        const res = await app.inject({
          method: "GET",
          url: `/?${PREVIEW_TOKEN_QUERY_PARAM}=${encodeURIComponent(tokenForOtherSlug)}`,
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
        });
        expect(res.statusCode).toBe(401);
        await app.close();
      });

      it("401s a preview cookie minted for a different slug", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const otherProjectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const otherSlug = await createProjectPreview(app, otherProjectId, DASHBOARD_AUTH_HEADERS);
        const cookieForOtherSlug = mintPreviewCookie(TEST_SECRET, otherSlug);

        const res = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          cookies: { [PREVIEW_COOKIE_NAME]: cookieForOtherSlug },
        });
        expect(res.statusCode).toBe(401);
        await app.close();
      });

      it("never forwards a stale/invalid token query param to the stub upstream dev server once a valid cookie takes over", async () => {
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        const cookieValue = mintPreviewCookie(TEST_SECRET, slug);

        // A stale/invalid token still riding the URL (e.g. a bookmarked link
        // from before the cookie existed) alongside an already-valid cookie —
        // the cookie check takes over and the request proxies normally, but
        // the (invalid) token param must still never reach the upstream dev
        // server, its access logs, or its outbound Referer.
        const res = await app.inject({
          method: "GET",
          url: `/asset.js?${PREVIEW_TOKEN_QUERY_PARAM}=invalid-or-expired`,
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          cookies: { [PREVIEW_COOKIE_NAME]: cookieValue },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().path).toBe("/asset.js");
        await app.close();
      });

      it("rate-limits repeated failed preview-auth attempts (429) per-IP, without throttling a valid cookie (CodeQL js/missing-rate-limiting)", async () => {
        // This describe block's other cases each fail auth once against the
        // shared default injected remoteAddress — clear first so this test's
        // own count starts from zero regardless of run order.
        resetPreviewAuthFailuresForTests();
        const app = await buildApp();
        const projectId = await createProjectWithDevServer(
          app,
          String(stubPort),
          DASHBOARD_AUTH_HEADERS,
        );
        const slug = await createProjectPreview(app, projectId, DASHBOARD_AUTH_HEADERS);
        // TEST-NET-3 (RFC 5737) — unique to this test so its counter can't
        // collide with any other test's default injected remoteAddress.
        const REMOTE = "203.0.113.5";

        let lastStatus = 0;
        for (let i = 0; i < 31; i++) {
          const res = await app.inject({
            method: "GET",
            url: "/",
            headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
            remoteAddress: REMOTE,
          });
          lastStatus = res.statusCode;
        }
        // Max is 30 failed attempts per window — the 31st trips the limiter.
        expect(lastStatus).toBe(429);

        // A different client (distinct remoteAddress) is unaffected — the
        // bound is per-IP, not global.
        const otherClient = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          remoteAddress: "203.0.113.6",
        });
        expect(otherClient.statusCode).toBe(401);

        // A valid cookie from the SAME (rate-limited-for-failures) client
        // still proxies normally — only failed attempts count against the
        // bound, so a legitimately authenticated session is never throttled
        // by its own traffic volume.
        const cookieValue = mintPreviewCookie(TEST_SECRET, slug);
        const authed = await app.inject({
          method: "GET",
          url: "/",
          headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
          cookies: { [PREVIEW_COOKIE_NAME]: cookieValue },
          remoteAddress: REMOTE,
        });
        expect(authed.statusCode).toBe(200);

        resetPreviewAuthFailuresForTests();
        await app.close();
      });
    });
  });
});
