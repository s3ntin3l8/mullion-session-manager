import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { createHost, enrollHost, getHostRow, listHosts } from "../../src/services/host-registry.js";
import {
  LEGACY_ENROLLMENT_SECRET_REFUSED_WARNING,
  LEGACY_ENROLLMENT_SECRET_WARNING,
  LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_WARNING,
  LEGACY_FLEET_ENROLLMENT_REFUSED_WARNING,
  LEGACY_FLEET_ENROLLMENT_REUSED_WARNING,
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
    delete process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS;
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

  it("keeps an agent that enrolled with the fleet secret registering on every boot while the gate is off", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      // The host enrolled BEFORE the gate: an "enrolled" row with no token of
      // its own and no machine identity. It is seeded directly, because the
      // path that creates one is refused now.
      const baseUrl = "http://127.0.0.2:1";
      const seeded = enrollHost(app, { hostname: "fleet-box", baseUrl });
      const register = (payload: Record<string, unknown> = {}) =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: FLEET_SECRET, baseUrl, hostname: "fleet-box", ...payload },
        });

      // A legacy agent holds no identity of its own, so it presents the fleet
      // secret on every boot — and must be served by the row it already owns.
      const first = await register();
      expect(first.statusCode).toBe(200);
      expect(first.json().host_id).toBe(seeded.hostId);
      expect(first.json().machine_credential).toBeUndefined();

      // The next boot: the same row, a fresh session, no second row.
      const second = await register();
      expect(second.statusCode).toBe(200);
      expect(second.json().host_id).toBe(seeded.hostId);
      expect(second.json().session_id).not.toBe(first.json().session_id);
      expect(listHosts(app).filter((h) => h.baseUrl === baseUrl)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("hands a fleet-secret host that asks for an identity one on the row it already owns", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const baseUrl = "http://127.0.0.3:1";
      const seeded = enrollHost(app, { hostname: "upgrading-box", baseUrl });

      // An agent that now runs a release which persists a machine identity
      // asks for one on its first registration after the upgrade.
      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: {
          token: FLEET_SECRET,
          baseUrl,
          hostname: "upgrading-box",
          wantsMachineCredential: true,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().host_id).toBe(seeded.hostId);
      expect(res.json().machine_credential).toMatch(/^[0-9a-f]{64}$/);
      // The host left the legacy path — on the same row, so no second one.
      expect(getHostRow(app, seeded.hostId)!.machineCredentialEnc).toBeTruthy();
      expect(listHosts(app).filter((h) => h.baseUrl === baseUrl)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("does not let the fleet secret take over a row that holds an identity", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const baseUrl = "http://127.0.0.4:1";
      const seeded = enrollHost(app, {
        hostname: "identified-box",
        baseUrl,
        wantsMachineCredential: true,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: FLEET_SECRET, baseUrl, hostname: "identified-box" },
      });
      expect(res.statusCode).toBe(401);
      // The row keeps its own identity; the fleet secret took nothing over.
      expect(getHostRow(app, seeded.hostId)!.machineCredentialEnc).toBeTruthy();
      expect(listHosts(app).filter((h) => h.baseUrl === baseUrl)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a fleet-secret registration from a disallowed address with the same 401, and says why", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    process.env.MULLION_ENROLLMENT_ALLOWED_CIDRS = "10.99.0.0/16";
    const app = await buildApp();
    try {
      const warn = vi.spyOn(app.log, "warn");
      const baseUrl = "http://127.0.0.5:1";
      const seeded = enrollHost(app, { hostname: "far-box", baseUrl });

      const res = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: FLEET_SECRET, baseUrl, hostname: "far-box" },
      });
      // A 403 here would tell the caller that its secret was the right one.
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe("invalid registration credential");
      // The row is untouched.
      expect(getHostRow(app, seeded.hostId)).toBeDefined();

      const notices = warn.mock.calls.filter(
        ([msg]) => String(msg) === LEGACY_FLEET_ENROLLMENT_REFUSED_ADDRESS_WARNING,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0][0]).toContain("MULLION_ENROLLMENT_ALLOWED_CIDRS");
    } finally {
      await app.close();
    }
  });

  it("says once per process that an existing host still registers with the fleet secret", async () => {
    delete process.env.MULLION_ALLOW_LEGACY_HOSTS;
    process.env.MULLION_ENROLLMENT_SECRET = FLEET_SECRET;
    const app = await buildApp();
    try {
      const warn = vi.spyOn(app.log, "warn");
      const baseUrl = "http://127.0.0.6:1";
      enrollHost(app, { hostname: "noticed-box", baseUrl });
      const register = () =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: { token: FLEET_SECRET, baseUrl, hostname: "noticed-box" },
        });

      await register();
      await register();
      const notices = warn.mock.calls.filter(
        ([msg]) => String(msg) === LEGACY_FLEET_ENROLLMENT_REUSED_WARNING,
      );
      expect(notices).toHaveLength(1);
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

      // The legacy path itself is untouched: a second registration with the
      // same advertised address reuses the row instead of creating a second
      // one, exactly as before the gate existed.
      const rowsBefore = listHosts(app).length;
      const again = await app.inject({
        method: "POST",
        url: "/api/internal/register",
        payload: { token: FLEET_SECRET, baseUrl: UNREACHABLE, hostname: "fresh-box" },
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().host_id).toBe(enrolled.json().host_id);
      expect(listHosts(app)).toHaveLength(rowsBefore);
    } finally {
      await app.close();
    }
  });
});
