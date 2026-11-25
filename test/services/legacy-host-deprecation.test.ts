import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  LEGACY_ENROLLMENT_SECRET_WARNING,
  LEGACY_FLEET_ENROLLMENT_WARNING,
  legacyHostDeprecationNotices,
} from "../../src/services/legacy-host-deprecation.js";

/**
 * Capture the log lines the app writes while `fn` runs.
 *
 * The startup notice is logged while buildApp() is still booting the plugin
 * tree, so no logger spy can be installed after the fact — the line is only
 * observable in the process's own output. Pino writes to process.stdout, and
 * a tampered process.stdout.write (which this spy is) makes pino use the
 * stream itself instead of writing to the file descriptor, so the line lands
 * here.
 */
async function captureLogLines(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

// Issue #3476 — the deprecation notices for the legacy host kinds. They SAY
// so; nothing is refused or gated on them yet.
describe("the legacy host deprecation notices (issue #3476)", () => {
  afterEach(() => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("warns exactly once at startup when the fleet enrollment secret is set", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret-3476"; // pragma: allowlist secret
    const lines = await captureLogLines(async () => {
      const app = await buildApp();
      try {
        // The notice is logged while the app is still building (buildApp
        // boots the plugin tree before it returns), so the module's own
        // record is what says it was said — and the LOGGED LINE is what
        // says the operator saw it.
        expect([...legacyHostDeprecationNotices()]).toEqual([LEGACY_ENROLLMENT_SECRET_WARNING]);
      } finally {
        await app.close();
      }
    });
    const warned = lines.filter((line) => line.includes("MULLION_ENROLLMENT_SECRET is set"));
    expect(warned).toHaveLength(1);
    // A warn (level 40), not an info line that nobody reads.
    expect(warned[0]).toContain('"level":40');
    expect(warned[0]).toContain("deprecated");
  });

  it("never warns when the fleet enrollment secret is not set", async () => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
    const lines = await captureLogLines(async () => {
      const app = await buildApp();
      try {
        expect([...legacyHostDeprecationNotices()]).toEqual([]);
      } finally {
        await app.close();
      }
    });
    expect(lines.filter((line) => line.includes("MULLION_ENROLLMENT_SECRET"))).toHaveLength(0);
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
