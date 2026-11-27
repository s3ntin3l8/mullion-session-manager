import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  LEGACY_ENROLLMENT_SECRET_WARNING,
  legacyHostDeprecationNotices,
} from "../../src/services/legacy-host-deprecation.js";

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

// Issue #3535 (follows #3476, #3477) — fleet-secret enrollment has been
// removed; if MULLION_ENROLLMENT_SECRET is still set in the environment, the
// primary logs a boot-time warning saying it is gone and naming what replaces
// it.
describe("the removed legacy host boot notice (issue #3535)", () => {
  afterEach(() => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
  });

  it("warns exactly once at startup when the removed fleet enrollment secret is set", async () => {
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret-3535"; // pragma: allowlist secret
    const lines = await captureLogLines(async () => {
      const app = await buildApp();
      try {
        expect([...legacyHostDeprecationNotices()]).toEqual([LEGACY_ENROLLMENT_SECRET_WARNING]);
      } finally {
        await app.close();
      }
    });
    const warned = lines.filter((line) => line.includes("MULLION_ENROLLMENT_SECRET is set"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"level":40');
    expect(warned[0]).toContain("removed");
    expect(warned[0]).toContain("Add host");
    expect(warned[0]).toContain("automation tokens");
  });

  it("never warns when MULLION_ENROLLMENT_SECRET is not set", async () => {
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
});
