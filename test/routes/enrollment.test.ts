import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { createPairedHost, getHostRow } from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `enrollment-test-${process.pid}.db`);

function seedManualHost(
  app: Awaited<ReturnType<typeof buildApp>>,
  opts: { name: string; baseUrl?: string; token: string },
): { id: string } {
  const id = crypto.randomUUID();
  app.db
    .insert(hosts)
    .values({
      id,
      name: opts.name,
      baseUrl: opts.baseUrl ?? null,
      authTokenEnc: app.encryption.encryptString(opts.token),
      origin: "manual",
      approvedAt: new Date(),
    })
    .run();
  return { id };
}

describe("POST /api/internal/register (issue #245 / roadmap 7.1)", () => {
  // Claiming a host opens a fan-out connection to its (unroutable, fake)
  // baseUrl, and app.close() waits ~10 s on that connect; on a loaded CI shard
  // the default 20 s budget is not enough (seen on #2596).
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("claims an existing host row when the token matches its own authTokenEnc", async () => {
    const app = await buildApp();
    const created = seedManualHost(app, {
      name: "pre-provisioned",
      baseUrl: "http://placeholder:0",
      token: "claim-me",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "claim-me", baseUrl: "http://10.0.0.5:4000", hostname: "box-5" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.host_id).toBe(created.id);
    expect(typeof body.session_id).toBe("string");
    expect(typeof body.session_secret).toBe("string");
    expect(typeof body.expires_at).toBe("string");

    const row = getHostRow(app, created.id)!;
    expect(row.baseUrl).toBe("http://10.0.0.5:4000");

    await app.close();
  });

  it("401s a claim attempt when the token matches no host row", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "no-such-token", baseUrl: "http://10.0.0.6:4000", hostname: "box-6" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a baseUrl pointed at cloud instance metadata / link-local", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "any-token", baseUrl: "http://169.254.169.254", hostname: "x" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts Tailscale CGNAT baseUrls only when MULLION_ALLOW_TAILNET_HOSTS=true", async () => {
    const register = (app: Awaited<ReturnType<typeof buildApp>>, baseUrl: string) =>
      app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "tailnet-claim", baseUrl, hostname: "tailnet-box" },
      });

    let app = await buildApp();
    expect((await register(app, "http://100.64.0.10:4000")).statusCode).toBe(400);
    await app.close();

    process.env.MULLION_ALLOW_TAILNET_HOSTS = "true";
    try {
      app = await buildApp();
      seedManualHost(app, { name: "tailnet-box", token: "tailnet-claim" });
      expect((await register(app, "http://100.64.0.10:4000")).statusCode).toBe(200);
      expect((await register(app, "http://169.254.169.254")).statusCode).toBe(400);
      await app.close();
    } finally {
      delete process.env.MULLION_ALLOW_TAILNET_HOSTS;
    }
  });

  it("force-reconnects the events subscription after claiming a host", async () => {
    const app = await buildApp();
    await app.ready();
    const created = seedManualHost(app, {
      name: "pre-provisioned-2",
      baseUrl: "http://placeholder:0",
      token: "claim-me-2",
    });
    const spy = vi.spyOn(app, "reconfigureRemoteEventSubscriptions").mockImplementation(() => {});

    await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "claim-me-2", baseUrl: "http://10.0.0.50:4000", hostname: "box-50" },
    });

    expect(spy).toHaveBeenCalledWith({ forceReconnect: [created.id] });
    await app.close();
  });

  it("renews a session when hostId + the current session id are presented", async () => {
    const app = await buildApp();
    const registered = createPairedHost(app, { baseUrl: "http://10.0.0.9:4000", hostname: "x" });

    const renewed = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: registered.sessionId,
        hostId: registered.hostId,
        baseUrl: "http://10.0.0.9:4000",
        hostname: "x",
      },
    });
    expect(renewed.statusCode).toBe(200);
    const renewedBody = renewed.json();
    expect(renewedBody.host_id).toBe(registered.hostId);
    expect(renewedBody.session_id).not.toBe(registered.sessionId);

    await app.close();
  });

  it("refreshes hosts.platform on session renewal and preserves it when omitted", async () => {
    const app = await buildApp();
    const registered = createPairedHost(app, {
      baseUrl: "http://10.0.0.19:4000",
      hostname: "x",
      platform: "linux",
    });
    expect(getHostRow(app, registered.hostId)?.platform).toBe("linux");

    const updated = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: registered.sessionId,
        hostId: registered.hostId,
        baseUrl: "http://10.0.0.19:4000",
        hostname: "x",
        platform: "darwin",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(getHostRow(app, registered.hostId)?.platform).toBe("darwin");

    const omitted = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: updated.json().session_id,
        hostId: registered.hostId,
        baseUrl: "http://10.0.0.19:4000",
        hostname: "x",
      },
    });
    expect(omitted.statusCode).toBe(200);
    expect(getHostRow(app, registered.hostId)?.platform).toBe("darwin");

    await app.close();
  });

  it("force-reconnects the events subscription after a session renewal", async () => {
    const app = await buildApp();
    await app.ready();
    const registered = createPairedHost(app, { baseUrl: "http://10.0.0.52:4000", hostname: "x" });

    const spy = vi.spyOn(app, "reconfigureRemoteEventSubscriptions").mockImplementation(() => {});
    await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: registered.sessionId,
        hostId: registered.hostId,
        baseUrl: "http://10.0.0.52:4000",
        hostname: "x",
      },
    });

    expect(spy).toHaveBeenCalledWith({ forceReconnect: [registered.hostId] });
    await app.close();
  });

  it("401s a renewal with a stale/wrong session id, without falling back to bootstrap validation", async () => {
    const app = await buildApp();
    const created = seedManualHost(app, {
      name: "no-fallback",
      baseUrl: "http://10.0.0.10:4000",
      token: "claim-bootstrap-secret",
    });
    const claimed = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "claim-bootstrap-secret", baseUrl: "http://10.0.0.10:4000", hostname: "x" },
    });
    expect(claimed.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: "claim-bootstrap-secret",
        hostId: created.id,
        baseUrl: "http://10.0.0.10:4000",
        hostname: "x",
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400s a missing required field", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "x", baseUrl: "http://x:1" }, // no hostname
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/internal/deregister (issue #248 / roadmap 7.3)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function registerAgent(app: Awaited<ReturnType<typeof buildApp>>, baseUrl: string) {
    await app.ready();
    const reg = createPairedHost(app, { baseUrl, hostname: "x" });
    return { host_id: reg.hostId, session_id: reg.sessionId };
  }

  it("marks the host offline immediately when the current session id is presented", async () => {
    const app = await buildApp();
    const { host_id, session_id } = await registerAgent(app, "http://10.0.1.1:4000");

    expect(app.hostHeartbeatTracker?.getHealth(host_id).status).toBe("pending");

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: session_id },
    });
    expect(res.statusCode).toBe(204);
    expect(app.hostHeartbeatTracker?.getHealth(host_id).status).toBe("offline");

    await app.close();
  });

  it("401s with a wrong session id and does not mark the host offline", async () => {
    const app = await buildApp();
    const { host_id } = await registerAgent(app, "http://10.0.1.2:4000");

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: "not-the-right-session-id" },
    });
    expect(res.statusCode).toBe(401);
    expect(app.hostHeartbeatTracker?.getHealth(host_id).status).toBe("pending");

    await app.close();
  });

  it("401s for an unknown hostId", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: "does-not-exist", sessionId: "anything" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400s a missing required field", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: "x" }, // no sessionId
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("does not delete the host row or its projects (status-only, unlike DELETE /api/hosts/:id?cascade=true)", async () => {
    const app = await buildApp();
    const { host_id, session_id } = await registerAgent(app, "http://10.0.1.3:4000");

    const res = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: session_id },
    });
    expect(res.statusCode).toBe(204);
    expect(getHostRow(app, host_id)).toBeDefined();

    await app.close();
  });

  it("revokes the session credential — a repeat deregister with the same session id 401s", async () => {
    const app = await buildApp();
    const { host_id, session_id } = await registerAgent(app, "http://10.0.1.4:4000");

    const first = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: session_id },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: session_id },
    });
    expect(second.statusCode).toBe(401);

    await app.close();
  });

  it("revokes the session credential — the deregistered session can no longer renew", async () => {
    const app = await buildApp();
    const { host_id, session_id } = await registerAgent(app, "http://10.0.1.5:4000");

    await app.inject({
      method: "POST",
      url: "/api/internal/deregister",
      payload: { hostId: host_id, sessionId: session_id },
    });

    const renewal = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        token: session_id,
        hostId: host_id,
        baseUrl: "http://10.0.1.5:4000",
        hostname: "x",
      },
    });
    expect(renewal.statusCode).toBe(401);

    await app.close();
  });
});
