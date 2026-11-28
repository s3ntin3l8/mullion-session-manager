import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { getHostRow } from "../../src/services/host-registry.js";
import {
  LEGACY_ENROLLMENT_SECRET_WARNING,
  legacyHostDeprecationNotices,
} from "../../src/services/legacy-host-deprecation.js";

const tmpDb = path.join(os.tmpdir(), `hosts-legacy-hosts-test-${process.pid}.db`);

const FLEET_SECRET = "fleet-secret-3535"; // pragma: allowlist secret
// Unroutable on purpose: a claimed host's baseUrl is dialled for the event
// fan-out, and a refused connection is what this fixture wants (no live
// agent behind it).
const UNREACHABLE = "http://127.0.0.1:1";

function seedManualHost(
  app: Awaited<ReturnType<typeof buildApp>>,
  opts: { name: string; baseUrl?: string; token: string },
): string {
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
  return id;
}

describe("removed legacy host entry points (issue #3535)", () => {
  // Claiming a host opens a fan-out connection to its (unroutable, fake)
  // baseUrl, and app.close() waits on that connect.
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

  afterEach(() => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("POST /api/hosts no longer exists (404)", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "legacy-host", baseUrl: UNREACHABLE, token: "some-token" },
      });
      expect(res.statusCode).toBe(404);
      const list = await app.inject({ method: "GET", url: "/api/hosts" });
      expect(list.json().some((h: { name: string }) => h.name === "legacy-host")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("POST /api/internal/register with the former fleet secret answers 401 and creates no host row", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const register = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token, baseUrl: UNREACHABLE, hostname: "box-1" },
        });

      const refused = await register(FLEET_SECRET);
      const unknown = await register("no-such-token");
      expect(refused.statusCode).toBe(401);
      expect(refused.json()).toEqual(unknown.json());
      expect(refused.json().message).toBe("invalid registration credential");

      const list = await app.inject({ method: "GET", url: "/api/hosts" });
      expect(list.json().some((h: { name: string }) => h.name === "box-1")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("keeps an existing pre-provisioned host working: it claims with its per-host token and renews", async () => {
    const app = await buildApp();
    try {
      const hostId = seedManualHost(app, {
        name: "pre-existing",
        baseUrl: UNREACHABLE,
        token: "per-host-token-existing",
      });

      const first = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "per-host-token-existing", baseUrl: UNREACHABLE, hostname: "box-a" },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().host_id).toBe(hostId);
      expect(first.json().machine_credential).toBeUndefined();

      const renewed = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: first.json().session_id,
          hostId,
          baseUrl: UNREACHABLE,
          hostname: "box-a",
        },
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().host_id).toBe(hostId);
      expect(getHostRow(app, hostId)).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("paired host via POST /api/internal/pair still lists with origin 'enrolled' and rotate-token returns 400", async () => {
    const app = await buildApp();
    try {
      const pairingRes = await app.inject({
        method: "POST",
        url: "/api/host-pairings",
        payload: { label: "paired-box" },
      });
      expect(pairingRes.statusCode).toBe(200);
      const { code } = pairingRes.json() as { code: string };

      const pairRes = await app.inject({
        method: "POST",
        url: "/api/internal/pair",
        payload: {
          code,
          requestId: crypto.randomUUID(),
          hostname: "paired-box",
          baseUrl: UNREACHABLE,
        },
      });
      expect(pairRes.statusCode).toBe(200);
      const { host_id: hostId } = pairRes.json() as { host_id: string };

      const listRes = await app.inject({ method: "GET", url: "/api/hosts" });
      expect(listRes.statusCode).toBe(200);
      const listed = listRes.json().find((h: { id: string }) => h.id === hostId);
      expect(listed).toBeDefined();
      expect(listed.origin).toBe("enrolled");

      const rotateRes = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/rotate-token`,
      });
      expect(rotateRes.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("warns at boot if MULLION_ENROLLMENT_SECRET is still set, and omits allowLegacyHosts from /api/server-info", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      expect([...legacyHostDeprecationNotices()]).toContain(LEGACY_ENROLLMENT_SECRET_WARNING);
      const info = await app.inject({ method: "GET", url: "/api/server-info" });
      expect(info.statusCode).toBe(200);
      expect("allowLegacyHosts" in info.json()).toBe(false);
    } finally {
      await app.close();
    }
  });
});
