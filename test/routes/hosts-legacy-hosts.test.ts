import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createHost, getHostRow } from "../../src/services/host-registry.js";
import {
  LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING,
  LEGACY_ENROLLMENT_SECRET_WARNING,
  LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING,
  LEGACY_HOST_CREATE_REFUSED_MESSAGE,
  legacyHostDeprecationNotices,
} from "../../src/services/legacy-host-deprecation.js";

const tmpDb = path.join(os.tmpdir(), `hosts-legacy-hosts-test-${process.pid}.db`);

const FLEET_SECRET = "fleet-secret-3477"; // pragma: allowlist secret
// Unroutable on purpose: a claimed host's baseUrl is dialled for the event
// fan-out, and a refused connection is what this fixture wants (no live
// agent behind it).
const UNREACHABLE = "http://127.0.0.1:1";

describe("the legacy host gate: MULLION_ALLOW_LEGACY_HOSTS (issue #3477)", () => {
  // Claiming a host opens a fan-out connection to its (unroutable, fake)
  // baseUrl, and app.close() waits on that connect — the same reason
  // enrollment.test.ts raises the budget.
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
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("refuses POST /api/hosts with a 400 naming the replacements while the gate is off", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "legacy-host", baseUrl: UNREACHABLE, token: "some-token" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe(LEGACY_HOST_CREATE_REFUSED_MESSAGE);
      // The message must name the way out, not just say "no".
      expect(res.json().message).toContain("Add host");
      expect(res.json().message).toContain("automation token");
      // And nothing was created: the refusal happens before the insert.
      const list = await app.inject({ method: "GET", url: "/api/hosts" });
      expect(list.json().some((h: { name: string }) => h.name === "legacy-host")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("answers fleet-secret enrollment with the same 401 as an unknown token, and says why once per process", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const warn = vi.spyOn(app.log, "warn");
      const register = (token: string) =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token, baseUrl: UNREACHABLE, hostname: "box-1" },
        });

      const refused = await register(FLEET_SECRET);
      const unknown = await register("no-such-token");
      expect(refused.statusCode).toBe(401);
      // Indistinguishable from an unknown credential: same status, same body.
      expect(refused.json()).toEqual(unknown.json());
      expect(refused.json().message).toBe("invalid registration credential");
      // No host row came out of it.
      const list = await app.inject({ method: "GET", url: "/api/hosts" });
      expect(list.json().some((h: { name: string }) => h.name === "box-1")).toBe(false);

      // The reason is logged ONCE per process, however many agents are
      // turned away.
      await register(FLEET_SECRET);
      const notices = warn.mock.calls.filter(
        ([msg]) => String(msg) === LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0][0]).toContain("MULLION_ALLOW_LEGACY_HOSTS");
    } finally {
      await app.close();
    }
  });

  it("keeps an existing manual host working: it claims with its token and registers on every boot", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    const app = await buildApp();
    try {
      // A row created EARLIER — before the gate, or with the gate open. The
      // route that creates one is refused, so the row is seeded directly.
      // The token is unique per test: a claim matches the FIRST row whose
      // own token it is, and this file shares one database.
      const created = createHost(app, {
        name: "pre-existing",
        baseUrl: UNREACHABLE,
        token: "per-host-token-existing",
      });

      // A legacy agent: it holds no machine identity, so it presents its
      // bootstrap token on every boot and claims the same row again.
      const register = (hostname: string) =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: "per-host-token-existing", baseUrl: UNREACHABLE, hostname },
        });

      const first = await register("box-a");
      expect(first.statusCode).toBe(200);
      expect(first.json().host_id).toBe(created.id);
      // No machine identity was issued, so the row stays on the legacy path.
      expect(first.json().machine_credential).toBeUndefined();

      const second = await register("box-a");
      expect(second.statusCode).toBe(200);
      expect(second.json().host_id).toBe(created.id);
      // A fresh session each boot, the row itself unchanged.
      expect(second.json().session_id).not.toBe(first.json().session_id);
      expect(getHostRow(app, created.id)).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("keeps a session renewal working while the gate is off", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    const app = await buildApp();
    try {
      const created = createHost(app, {
        name: "renewing",
        baseUrl: UNREACHABLE,
        token: "per-host-token-renewing",
      });
      const claimed = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: "per-host-token-renewing", baseUrl: UNREACHABLE, hostname: "box-b" },
      });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().host_id).toBe(created.id);

      const renewed = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: claimed.json().session_id,
          hostId: created.id,
          baseUrl: UNREACHABLE,
          hostname: "box-b",
        },
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().host_id).toBe(created.id);
    } finally {
      await app.close();
    }
  });

  it("warns at boot that the fleet secret is refused while the gate is off", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      // The operator has to read off the boot log WHY the fleet stopped
      // enrolling: "deprecated" alone would leave them guessing.
      expect([...legacyHostDeprecationNotices()]).toEqual([
        LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING,
      ]);
      expect(legacyHostDeprecationNotices().has(LEGACY_ENROLLMENT_SECRET_WARNING)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("reports the gate on /api/server-info, which is what the UI reads", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    let app = await buildApp();
    let res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.json().allowLegacyHosts).toBe(false);
    await app.close();

    process.env.MULLION_ALLOW_LEGACY_HOSTS = "true";
    app = await buildApp();
    res = await app.inject({ method: "GET", url: "/api/server-info" });
    expect(res.json().allowLegacyHosts).toBe(true);
    await app.close();
  });

  it("behaves exactly as before with the gate on", async () => {
    process.env.MULLION_ALLOW_LEGACY_HOSTS = "true";
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name: "legacy-host", baseUrl: UNREACHABLE, token: "some-token" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().name).toBe("legacy-host");

      const enrolled = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: FLEET_SECRET, baseUrl: UNREACHABLE, hostname: "fresh-box" },
      });
      expect(enrolled.statusCode).toBe(200);
      expect(getHostRow(app, enrolled.json().host_id)!.origin).toBe("enrolled");
    } finally {
      await app.close();
    }
  });
});
