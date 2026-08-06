import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createHost, getHostRow } from "../../src/services/host-registry.js";

const tmpDb = path.join(os.tmpdir(), `enrollment-test-${process.pid}.db`);

describe("POST /api/internal/register (issue #245 / roadmap 7.1)", () => {
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
    const created = createHost(app, {
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

  it("401s a claim attempt when the token matches no host row and enrollment is disabled", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { token: "no-such-token", baseUrl: "http://10.0.0.6:4000", hostname: "box-6" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("enrolls a brand-new host row when the token matches MULLION_ENROLLMENT_SECRET", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
    try {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: "fleet-wide-secret",
          baseUrl: "http://10.0.0.7:4000",
          hostname: "fresh-box",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const row = getHostRow(app, body.host_id)!;
      expect(row.origin).toBe("enrolled");
      expect(row.baseUrl).toBe("http://10.0.0.7:4000");
      await app.close();
    } finally {
      delete process.env.MULLION_ENROLLMENT_SECRET;
    }
  });

  it("401s an enroll attempt with the wrong secret, even with MULLION_ENROLLMENT_SECRET set", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
    try {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "wrong-secret", baseUrl: "http://10.0.0.8:4000", hostname: "x" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    } finally {
      delete process.env.MULLION_ENROLLMENT_SECRET;
    }
  });

  it("rejects a baseUrl pointed at cloud instance metadata / link-local, same as POST /api/hosts", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
    try {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: "fleet-wide-secret",
          baseUrl: "http://169.254.169.254",
          hostname: "x",
        },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    } finally {
      delete process.env.MULLION_ENROLLMENT_SECRET;
    }
  });

  it("renews a session when hostId + the current session id are presented", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
    try {
      const app = await buildApp();
      const registered = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "fleet-wide-secret", baseUrl: "http://10.0.0.9:4000", hostname: "x" },
      });
      const { host_id, session_id } = registered.json();

      const renewed = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: session_id,
          hostId: host_id,
          baseUrl: "http://10.0.0.9:4000",
          hostname: "x",
        },
      });
      expect(renewed.statusCode).toBe(200);
      const renewedBody = renewed.json();
      expect(renewedBody.host_id).toBe(host_id);
      expect(renewedBody.session_id).not.toBe(session_id);

      await app.close();
    } finally {
      delete process.env.MULLION_ENROLLMENT_SECRET;
    }
  });

  it("401s a renewal with a stale/wrong session id, without falling back to bootstrap validation", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
    try {
      const app = await buildApp();
      const registered = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "fleet-wide-secret", baseUrl: "http://10.0.0.10:4000", hostname: "x" },
      });
      const { host_id } = registered.json();

      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        // Presenting the *bootstrap* secret as a renewal token must NOT
        // succeed just because it happens to be a valid credential of a
        // different kind — a renewal only ever accepts that host's own
        // current session id.
        payload: {
          token: "fleet-wide-secret",
          hostId: host_id,
          baseUrl: "http://10.0.0.10:4000",
          hostname: "x",
        },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    } finally {
      delete process.env.MULLION_ENROLLMENT_SECRET;
    }
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

  // Issue #245 — MULLION_ENROLLMENT_ALLOWED_CIDRS, when set, additionally
  // restricts the *enroll* path (never the claim path, which already
  // requires knowing a specific row's own token).
  describe("MULLION_ENROLLMENT_ALLOWED_CIDRS", () => {
    it("allows an enroll request whose peer IP falls inside the configured range", async () => {
      process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
      process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS = "127.0.0.0/8";
      try {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: "fleet-wide-secret", baseUrl: "http://10.0.0.11:4000", hostname: "x" },
          // app.inject()'s default remoteAddress is 127.0.0.1.
        });
        expect(res.statusCode).toBe(200);
        await app.close();
      } finally {
        delete process.env.MULLION_ENROLLMENT_SECRET;
        delete process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS;
      }
    });

    it("403s an enroll request whose peer IP falls outside the configured range", async () => {
      process.env.MULLION_ENROLLMENT_SECRET = "fleet-wide-secret"; // pragma: allowlist secret
      process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS = "10.99.0.0/16";
      try {
        const app = await buildApp();
        const res = await app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: "fleet-wide-secret", baseUrl: "http://10.0.0.12:4000", hostname: "x" },
        });
        expect(res.statusCode).toBe(403);
        await app.close();
      } finally {
        delete process.env.MULLION_ENROLLMENT_SECRET;
        delete process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS;
      }
    });

    it("does not restrict the claim path at all", async () => {
      process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS = "10.99.0.0/16";
      try {
        const app = await buildApp();
        createHost(app, { name: "claimable", baseUrl: "http://x:1", token: "claim-tok" });
        const res = await app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: "claim-tok", baseUrl: "http://10.0.0.13:4000", hostname: "x" },
        });
        expect(res.statusCode).toBe(200);
        await app.close();
      } finally {
        delete process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS;
      }
    });
  });
});
