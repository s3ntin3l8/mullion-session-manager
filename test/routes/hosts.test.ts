import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { appVersion } from "../../src/routes/server-info.js";
import { clearUpdateCheckCacheForTests } from "../../src/services/update-checker.js";

const tmpDb = path.join(os.tmpdir(), `hosts-test-${process.pid}.db`);

describe("hosts route (issue #26)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("lists the seeded local host, with no token ever exposed", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/hosts" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "local", isLocal: true, baseUrl: null, hasToken: false }),
    ]);
    // The raw response body must never contain a token field at all.
    expect(res.body).not.toMatch(/authToken/i);
    await app.close();
  });

  it("creates a remote host and never returns its token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-1", baseUrl: "http://127.0.0.1:4001", token: "super-secret" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: "box-1",
      baseUrl: "http://127.0.0.1:4001",
      isLocal: false,
      hasToken: true,
    });
    expect(res.body).not.toMatch(/super-secret/);
    expect(typeof body.id).toBe("string");
    await app.close();
  });

  it("rejects a non-http(s) baseUrl", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "bad", baseUrl: "not-a-url", token: "t" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a baseUrl pointed at cloud instance metadata / link-local (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    for (const baseUrl of ["http://169.254.169.254", "http://100.64.0.1:8080"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ssrf", baseUrl, token: "t" },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("rejects an IPv6 link-local or AWS IMDS baseUrl (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    for (const baseUrl of ["http://[fe80::1]", "http://[fd00:ec2::254]"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ssrf-v6", baseUrl, token: "t" },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("rejects an IPv4-mapped IPv6 literal pointed at IMDS/link-local (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    for (const baseUrl of ["http://[::ffff:169.254.169.254]", "http://[::ffff:100.64.0.1]"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "ssrf-mapped-v6", baseUrl, token: "t" },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("still allows a loopback baseUrl (admin-trust boundary, not a link-local block)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "loopback", baseUrl: "http://127.0.0.1:4001", token: "t" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("still allows IPv6 loopback too, consistent with IPv4 loopback being allowed", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "loopback-v6", baseUrl: "http://[::1]:4001", token: "t" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("404s patching an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hosts/does-not-exist",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("refuses to edit the local host", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/hosts/local",
      payload: { name: "renamed" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rotates a host's name/baseUrl/token via PATCH", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-2", baseUrl: "http://127.0.0.1:4002", token: "old-token" },
    });
    const { id } = created.json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { name: "box-2-renamed", token: "new-token" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "box-2-renamed", hasToken: true });
    await app.close();
  });

  it("invalidates the heartbeat tracker's entry when a host's baseUrl/token is rotated via PATCH", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-2b", baseUrl: "http://127.0.0.1:4002", token: "t" },
    });
    const { id } = created.json();

    app.hostHeartbeatTracker?.recordSuccess(id);
    expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("online");

    // A renamed-only PATCH (no baseUrl/token change) must NOT invalidate —
    // the old health verdict is still measuring the same URL.
    await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { name: "renamed-only" },
    });
    expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("online");

    // A baseUrl change invalidates — the old verdict measured a different
    // URL and no longer means anything.
    await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { baseUrl: "http://127.0.0.1:4009" },
    });
    expect(app.hostHeartbeatTracker?.getHealth(id).status).toBe("pending");

    await app.close();
  });

  // Issue #213 cross-host capture — proves the wiring (this route calls the
  // decorator with the right args), not remote-event-subscriber.ts's own
  // reconcile behavior (already covered by
  // test/services/remote-event-subscriber.test.ts). Mocked out rather than
  // left to run for real: its real body would open an actual (harmless but
  // pointless-to-exercise-here) network connection attempt to the test
  // host's fake baseUrl.
  it("reconfigures remote event subscriptions after creating a host", async () => {
    const app = await buildApp();
    await app.ready();
    const spy = vi.spyOn(app, "reconfigureRemoteEventSubscriptions").mockImplementation(() => {});

    await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-3", baseUrl: "http://127.0.0.1:4003", token: "t" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();

    await app.close();
  });

  it("force-reconnects the events subscription when a host's baseUrl/token is rotated via PATCH", async () => {
    const app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-4", baseUrl: "http://127.0.0.1:4004", token: "t" },
    });
    const { id } = created.json();
    const spy = vi.spyOn(app, "reconfigureRemoteEventSubscriptions").mockImplementation(() => {});

    // Rename-only must NOT force a reconnect — same "no baseUrl/token
    // change" gate the heartbeat-invalidation test above exercises.
    await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { name: "renamed-only" },
    });
    expect(spy).not.toHaveBeenCalled();

    await app.inject({
      method: "PATCH",
      url: `/api/hosts/${id}`,
      payload: { baseUrl: "http://127.0.0.1:4009" },
    });
    expect(spy).toHaveBeenCalledWith({ forceReconnect: [id] });

    await app.close();
  });

  it("reconfigures remote event subscriptions after deleting a host", async () => {
    const app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-5", baseUrl: "http://127.0.0.1:4005", token: "t" },
    });
    const { id } = created.json();
    const spy = vi.spyOn(app, "reconfigureRemoteEventSubscriptions").mockImplementation(() => {});

    const res = await app.inject({ method: "DELETE", url: `/api/hosts/${id}` });
    expect(res.statusCode).toBe(204);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();

    await app.close();
  });

  it("refuses to delete the local host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/hosts/local" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("refuses to cascade-delete the local host, without touching its projects (Hermes review, PR #34)", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "local-project", cwd: "/tmp/local-project" },
    });
    const projectId = created.json().id as number;

    const res = await app.inject({ method: "DELETE", url: "/api/hosts/local?cascade=true" });
    expect(res.statusCode).toBe(400);

    // The guard must run before any cascade side effect — the local
    // project must still exist afterward, not have been swept up by the
    // cascade block ahead of deleteHost's own (too-late) local-host check.
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect((projects.json() as Array<{ id: number }>).some((p) => p.id === projectId)).toBe(true);

    await app.close();
  });

  it("404s deleting an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/hosts/does-not-exist" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409s deleting a host that still has projects, without cascade", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-3", baseUrl: "http://127.0.0.1:4003", token: "t" },
    });
    const { id } = created.json();
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "on-box-3", cwd: "/remote/path", hostId: id },
    });

    const res = await app.inject({ method: "DELETE", url: `/api/hosts/${id}` });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it("cascade-deletes a host, its projects, and their sessions (best-effort, host unreachable)", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      // Deliberately not listening — cascade termination must be best-effort
      // and not block the delete when the agent is unreachable.
      payload: { name: "box-4", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id: hostId } = created.json();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "on-box-4", cwd: "/remote/path", hostId },
    });
    const projectId = project.json().id as number;

    const res = await app.inject({ method: "DELETE", url: `/api/hosts/${hostId}?cascade=true` });
    expect(res.statusCode).toBe(204);

    const hosts = await app.inject({ method: "GET", url: "/api/hosts" });
    expect((hosts.json() as Array<{ id: string }>).some((h) => h.id === hostId)).toBe(false);

    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect((projects.json() as Array<{ id: number }>).some((p) => p.id === projectId)).toBe(false);

    await app.close();
  });

  it("local host always pings online", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/hosts/local/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: true });
    await app.close();
  });

  it("404s pinging an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/hosts/does-not-exist/ping" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("reports offline for an unreachable remote host", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-5", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/ping` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ online: false });

    await app.close();
  });

  // Issue #247 / roadmap 7.4 — end-to-end coverage against a real listening
  // agent lives in test/integration/multi-host.test.ts (the only file with
  // one); these cover the edge cases that don't need one.
  it("404s getting config for an unknown host", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/hosts/does-not-exist/config" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("503s getting config for an unreachable remote host", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-6-config", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const { id } = created.json();

    const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/config` });
    expect(res.statusCode).toBe(503);

    await app.close();
  });

  // Hermes review, PR #527 — a *reachable* agent that rejects the request
  // (here: an old build with no /internal/config route at all) must not be
  // folded into the same "Host X is unreachable" 503 a genuine connectivity
  // failure gets — see forwardHostRequestError's own doc comment and the
  // #244 precedent in projects.ts this mirrors.
  it("forwards a genuine 404 from the agent, not a misleading 'unreachable' 503", async () => {
    const stubServer = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "no such route" }));
    });
    await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = stubServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }

      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "old-agent", baseUrl: `http://127.0.0.1:${address.port}`, token: "t" },
      });
      const { id } = created.json();

      const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/config` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ message: "no such route" });

      await app.close();
    } finally {
      await new Promise<void>((resolve) => stubServer.close(() => resolve()));
    }
  });

  // Issue #647 / roadmap 7.8 — proxied host-update status/apply. Every
  // scenario needs a real listening agent stub (like the /config tests
  // above), routed by path since a single check touches both
  // /internal/config and /internal/updates/status; `updatable`/apply
  // scenarios also need MULLION_UPDATE_REPO's GitHub lookup
  // (resolveReleaseByTag) mocked via global fetch.
  describe("GET /api/hosts/:id/update and POST /api/hosts/:id/update/apply", () => {
    // A plain vi.stubGlobal("fetch", ...) here would ALSO intercept
    // RemoteHostClient's own calls to the real stub agent server below —
    // both go through the global fetch. Routed by URL instead: only a
    // https://api.github.com/* call is faked (via the githubResponses
    // queue); everything else — including every call this describe block
    // makes to its own startStubAgent servers — passes through to the real
    // fetch untouched.
    const realFetch = globalThis.fetch;
    let githubResponses: Response[];
    let githubCallCount: number;

    beforeEach(() => {
      githubResponses = [];
      githubCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          // Parsed and checked against the exact hostname (CodeQL
          // js/incomplete-url-substring-sanitization) rather than a
          // startsWith/substring check — "https://api.github.com" is a
          // string PREFIX of "https://api.github.com.evil.example/", which
          // a naive check would wrongly route to the GitHub fixture queue.
          // No untrusted input reaches this test-only router, but the
          // pattern is worth getting right regardless.
          if (new URL(url).hostname === "api.github.com") {
            githubCallCount++;
            const next = githubResponses.shift();
            if (!next) throw new Error("unexpected GitHub API call in test");
            return Promise.resolve(next);
          }
          return realFetch(input, init);
        }),
      );
      clearUpdateCheckCacheForTests();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function jsonResponse(status: number, body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    async function startStubAgent(
      routes: Record<string, { status: number; body: unknown }>,
    ): Promise<{ baseUrl: string; close: () => Promise<void> }> {
      const server = http.createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        const route = routes[path];
        if (!route) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "no such route" }));
          return;
        }
        res.writeHead(route.status, { "content-type": "application/json" });
        res.end(JSON.stringify(route.body));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }
      return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }

    it("400s the local host for both routes", async () => {
      const app = await buildApp();
      const status = await app.inject({ method: "GET", url: "/api/hosts/local/update" });
      const apply = await app.inject({ method: "POST", url: "/api/hosts/local/update/apply" });
      expect(status.statusCode).toBe(400);
      expect(apply.statusCode).toBe(400);
      await app.close();
    });

    it("404s an unknown host for both routes", async () => {
      const app = await buildApp();
      const status = await app.inject({ method: "GET", url: "/api/hosts/does-not-exist/update" });
      const apply = await app.inject({
        method: "POST",
        url: "/api/hosts/does-not-exist/update/apply",
      });
      expect(status.statusCode).toBe(404);
      expect(apply.statusCode).toBe(404);
      await app.close();
    });

    it("reports upToDate when the agent is already on the primary's version, skipping the release lookup", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: appVersion, projectsRoots: [], sessionsDir: "/x" },
        },
        "/internal/updates/status": { status: 200, body: { phase: "idle" } },
      });
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "same-version-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          hostVersion: appVersion,
          primaryVersion: appVersion,
          upToDate: true,
          updatable: false,
          unavailableReason: null,
          assetUrl: null,
          checksumUrl: null,
          status: { phase: "idle" },
        });
        // upToDate short-circuits the GitHub release lookup entirely.
        expect(githubCallCount).toBe(0);

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("reports updatable: true with resolved release assets when the agent is behind", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
        "/internal/updates/status": { status: 200, body: { phase: "idle" } },
      });
      githubResponses.push(
        jsonResponse(200, {
          tag_name: `v${appVersion}`,
          html_url: "https://github.com/x/y/releases/tag/vX",
          assets: [
            {
              name: `mullion-${appVersion}.tgz`,
              browser_download_url: "https://github.com/x/y/a.tgz",
            },
            {
              name: `mullion-${appVersion}.tgz.sha256`,
              browser_download_url: "https://github.com/x/y/a.tgz.sha256",
            },
          ],
        }),
      );
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "behind-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          hostVersion: "0.0.1",
          primaryVersion: appVersion,
          upToDate: false,
          updatable: true,
          unavailableReason: null,
          assetUrl: "https://github.com/x/y/a.tgz",
          checksumUrl: "https://github.com/x/y/a.tgz.sha256",
        });

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("reports updatable: false with a reason when the primary's own release has no asset yet", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
        "/internal/updates/status": { status: 200, body: { phase: "idle" } },
      });
      githubResponses.push(
        jsonResponse(200, { tag_name: `v${appVersion}`, html_url: "https://x", assets: [] }),
      );
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "no-asset-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.updatable).toBe(false);
        expect(body.unavailableReason).toEqual(expect.any(String));
        expect(body.assetUrl).toBeNull();

        await app.close();
      } finally {
        await agent.close();
      }
    });

    // The #647 "old agent build" signal — a 404 specifically from
    // /internal/updates/status (not /internal/config, which this agent DOES
    // have — it just predates the update routes) must read as "update this
    // agent by hand once," never "unreachable" (host-git.ts's own
    // statusCode === 404 discipline, applied here).
    it("surfaces a 404 from /internal/updates/status as updatable: false, not unreachable", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
      });
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "old-build-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ hostVersion: "0.0.1", updatable: false });
        expect(githubCallCount).toBe(0);

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("503s when the agent is unreachable", async () => {
      const app = await buildApp();
      const created = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "unreachable-agent", baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      const { id } = created.json();

      const res = await app.inject({ method: "GET", url: `/api/hosts/${id}/update` });
      expect(res.statusCode).toBe(503);

      await app.close();
    });

    it("apply 400s when the host is already on the primary's version, without spending a GitHub call", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: appVersion, projectsRoots: [], sessionsDir: "/x" },
        },
      });
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "already-current-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/update/apply` });
        expect(res.statusCode).toBe(400);
        expect(githubCallCount).toBe(0);

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("apply 400s when the primary's own release has no downloadable asset yet", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
      });
      githubResponses.push(
        jsonResponse(200, { tag_name: `v${appVersion}`, html_url: "https://x", assets: [] }),
      );
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "no-asset-agent-2", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/update/apply` });
        expect(res.statusCode).toBe(400);

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("proxies a valid apply to the agent's own applyUpdate and returns its 202", async () => {
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
        "/internal/updates/apply": {
          status: 202,
          body: { phase: "downloading", version: appVersion },
        },
      });
      githubResponses.push(
        jsonResponse(200, {
          tag_name: `v${appVersion}`,
          html_url: "https://x",
          assets: [
            {
              name: `mullion-${appVersion}.tgz`,
              browser_download_url: "https://github.com/x/y/a.tgz",
            },
            {
              name: `mullion-${appVersion}.tgz.sha256`,
              browser_download_url: "https://github.com/x/y/a.tgz.sha256",
            },
          ],
        }),
      );
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "apply-target-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/update/apply` });

        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual({ phase: "downloading", version: appVersion });

        await app.close();
      } finally {
        await agent.close();
      }
    });

    it("forwards a genuine 404 apply response from an old agent build, not a misleading 503", async () => {
      // /internal/config succeeds (an older build still has it — #647 only
      // ever added the update routes) so this genuinely reaches — and
      // 404s at — POST /internal/updates/apply specifically, not the
      // up-to-date guard's own resolveConfig() call.
      const agent = await startStubAgent({
        "/internal/config": {
          status: 200,
          body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
        },
      });
      githubResponses.push(
        jsonResponse(200, {
          tag_name: `v${appVersion}`,
          html_url: "https://x",
          assets: [
            {
              name: `mullion-${appVersion}.tgz`,
              browser_download_url: "https://github.com/x/y/a.tgz",
            },
            {
              name: `mullion-${appVersion}.tgz.sha256`,
              browser_download_url: "https://github.com/x/y/a.tgz.sha256",
            },
          ],
        }),
      );
      try {
        const app = await buildApp();
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "old-build-apply-agent", baseUrl: agent.baseUrl, token: "t" },
        });
        const { id } = created.json();

        const res = await app.inject({ method: "POST", url: `/api/hosts/${id}/update/apply` });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ message: "no such route" });

        await app.close();
      } finally {
        await agent.close();
      }
    });
  });

  // Issue #246 — GET /api/hosts merges the heartbeat tracker's live status
  // in at the route layer (see routes/hosts.ts); these exercise that merge
  // directly against the tracker rather than waiting on a real timer tick
  // (test/plugins/host-heartbeat.test.ts covers the real timer wiring).
  it("merges live heartbeat health into GET /api/hosts", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "box-6", baseUrl: "http://127.0.0.1:4006", token: "t" },
    });
    const { id } = created.json();

    type ApiHost = {
      id: string;
      health: string;
      lastSeenAt: string | null;
      lastCheckedAt: string | null;
    };

    // Never swept yet.
    let res = await app.inject({ method: "GET", url: "/api/hosts" });
    let host = (res.json() as ApiHost[]).find((h) => h.id === id);
    expect(host).toMatchObject({ health: "pending", lastSeenAt: null, lastCheckedAt: null });

    app.hostHeartbeatTracker?.recordSuccess(id);
    res = await app.inject({ method: "GET", url: "/api/hosts" });
    host = (res.json() as ApiHost[]).find((h) => h.id === id);
    expect(host?.health).toBe("online");
    expect(typeof host?.lastSeenAt).toBe("string");
    expect(typeof host?.lastCheckedAt).toBe("string");
    const lastSeenAtOnSuccess = host?.lastSeenAt;

    app.hostHeartbeatTracker?.recordFailure(id);
    app.hostHeartbeatTracker?.recordFailure(id);
    app.hostHeartbeatTracker?.recordFailure(id);
    res = await app.inject({ method: "GET", url: "/api/hosts" });
    host = (res.json() as ApiHost[]).find((h) => h.id === id);
    expect(host?.health).toBe("offline");
    // lastSeenAt (last success) must not advance on a failure, but
    // lastCheckedAt (last sweep result, success or failure) must.
    expect(host?.lastSeenAt).toBe(lastSeenAtOnSuccess);
    expect(typeof host?.lastCheckedAt).toBe("string");

    const localHost = (res.json() as ApiHost[]).find((h) => h.id === "local");
    expect(localHost).toMatchObject({ health: "online", lastSeenAt: null, lastCheckedAt: null });

    await app.close();
  });

  it("does not register a heartbeat tracker on the agent role", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "hosts-test-agent-token";
    process.env.PROJECTS_ROOTS = os.tmpdir();
    try {
      const app = await buildApp();
      await app.ready();
      expect(app.hostHeartbeatTracker).toBeUndefined();
      await app.close();
    } finally {
      delete process.env.MULLION_ROLE;
      delete process.env.MULLION_AGENT_TOKEN;
      delete process.env.PROJECTS_ROOTS;
    }
  });
});
