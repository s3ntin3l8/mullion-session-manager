import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  LEGACY_ENROLLMENT_SECRET_WARNING,
  LEGACY_FLEET_ENROLLMENT_WARNING,
  legacyHostDeprecationNotices,
} from "../../src/services/legacy-host-deprecation.js";

// Issue #3476 — the deprecation notices for the legacy host kinds. They SAY
// so; nothing is refused or gated on them yet.
describe("the legacy host deprecation notices (issue #3476)", () => {
  afterEach(() => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("warns exactly once at startup when the fleet enrollment secret is set", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret-3476"; // pragma: allowlist secret
    const app = await buildApp();
    try {
      // The notice is logged while the app is still building (buildApp boots
      // the plugin tree before it returns), so the module's own record is
      // what says it was said.
      expect([...legacyHostDeprecationNotices()]).toEqual([LEGACY_ENROLLMENT_SECRET_WARNING]);
    } finally {
      await app.close();
    }
  });

  it("never warns when the fleet enrollment secret is not set", async () => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
    const app = await buildApp();
    try {
      expect([...legacyHostDeprecationNotices()]).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("warns once per process on the first fleet-secret enrollment, and not again", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret-3476"; // pragma: allowlist secret
    const app = await buildApp();
    try {
      const warn = vi.spyOn(app.log, "warn");
      const register = (hostname: string) =>
        app.inject({
          method: "POST",
          url: "/api/internal/register",
          payload: {
            token: "fleet-secret-3476", // pragma: allowlist secret
            hostname,
            baseUrl: "http://127.0.0.1:4751",
          },
        });
      expect((await register("box-1")).statusCode).toBe(200);
      expect((await register("box-2")).statusCode).toBe(200);
      const warnings = warn.mock.calls.filter(
        ([msg]) => String(msg) === LEGACY_FLEET_ENROLLMENT_WARNING,
      );
      expect(warnings).toHaveLength(1);
      expect(legacyHostDeprecationNotices().has(LEGACY_FLEET_ENROLLMENT_WARNING)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
