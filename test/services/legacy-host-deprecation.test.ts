import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ne } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { hosts } from "../../src/db/schema.js";
import { setDotenvPathForTests } from "../../src/plugins/env.js";
import { createPairedHost } from "../../src/services/host-registry.js";
import {
  LEGACY_ENROLLMENT_SECRET_WARNING,
  legacyHostDeprecationNotices,
  resetLegacyHostDeprecationNotices,
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
    setDotenvPathForTests(null);
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

  it("warns at startup when MULLION_ENROLLMENT_SECRET is set only in .env (not process.env)", async () => {
    delete process.env.MULLION_ENROLLMENT_SECRET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-deprecation-dotenv-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      "MULLION_ENROLLMENT_SECRET=fleet-secret-from-dotenv\n", // pragma: allowlist secret
    );
    setDotenvPathForTests(envPath);
    try {
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
    } finally {
      setDotenvPathForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

// Issue #3578 — boot-time notice when any host row is still on a removed-soon
// legacy path (`legacy-agent` or `manual-token`).
describe("the deprecated host boot notice (issue #3578)", () => {
  afterEach(async () => {
    const app = await buildApp();
    try {
      app.db.delete(hosts).where(ne(hosts.id, "local")).run();
    } finally {
      await app.close();
    }
    resetLegacyHostDeprecationNotices();
  });

  it("logs one warning per process listing both host names and kinds, and no credential or address", async () => {
    const plainToken = "super-secret-agent-token-3578"; // pragma: allowlist secret
    const legacyUrl = "http://192.168.99.41:3000";
    const manualUrl = "http://user:pass@192.168.99.42:3000"; // pragma: allowlist secret
    const seedApp = await buildApp();
    try {
      seedApp.db
        .insert(hosts)
        .values([
          {
            id: crypto.randomUUID(),
            name: "legacy-box",
            baseUrl: legacyUrl,
            authTokenEnc: null,
            origin: "enrolled",
            approvedAt: new Date(),
          },
          {
            id: crypto.randomUUID(),
            name: "manual-box",
            baseUrl: manualUrl,
            authTokenEnc: seedApp.encryption.encryptString(plainToken),
            origin: "manual",
            approvedAt: new Date(),
          },
        ])
        .run();
    } finally {
      await seedApp.close();
    }

    resetLegacyHostDeprecationNotices();
    const lines = await captureLogLines(async () => {
      const app = await buildApp();
      await app.close();
      // Booting a second time in the same process must not log a second warning.
      const secondApp = await buildApp();
      await secondApp.close();
    });

    const warned = lines.filter((line) =>
      line.includes("Deprecated host connection method(s) in use"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"level":40');
    expect(warned[0]).toContain("legacy-box (legacy-agent)");
    expect(warned[0]).toContain("manual-box (manual-token)");
    expect(warned[0]).toContain("removed in the next release");
    expect(warned[0]).toContain("Re-pair (Settings → Hosts)");
    expect(warned[0]).not.toContain(plainToken);
    expect(warned[0]).not.toContain(legacyUrl);
    expect(warned[0]).not.toContain(manualUrl);
    expect(warned[0]).not.toContain("192.168.99.");
  });

  it("never warns when no host row has a deprecatedKind", async () => {
    const seedApp = await buildApp();
    try {
      createPairedHost(seedApp, {
        baseUrl: "http://127.0.0.1:4743",
        hostname: "paired-box",
      });
    } finally {
      await seedApp.close();
    }

    resetLegacyHostDeprecationNotices();
    const lines = await captureLogLines(async () => {
      const app = await buildApp();
      try {
        expect([...legacyHostDeprecationNotices()]).toEqual([]);
      } finally {
        await app.close();
      }
    });
    expect(
      lines.filter((line) => line.includes("Deprecated host connection method(s)")),
    ).toHaveLength(0);
  });
});
