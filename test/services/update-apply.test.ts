// Issue #1718 (roadmap 8.4) — the macOS self-update path.
//
// On Linux the updater runs inside a transient `systemd-run --user --scope`, so
// it survives the restart its own last step triggers. On macOS the equivalent
// is a ONE-SHOT LAUNCHD JOB: the app's own job is killed by that restart, so an
// updater running inside it would die mid-flight.
//
// These tests pin that shape: the plist that is written, the label it carries,
// and the `launchctl bootstrap` that loads it — plus the unchanged Linux path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";

const spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return {
        on: () => undefined,
        unref: () => undefined,
      };
    },
  };
});

const { spawnSelfUpdate } = await import("../../src/services/update-apply.js");

function fakeApp(config: {
  MULLION_HOME: string;
  MULLION_SERVICE_UNIT?: string;
  MULLION_ROLE?: string;
}): FastifyInstance {
  const logs: unknown[] = [];
  return {
    config: {
      MULLION_HOME: config.MULLION_HOME,
      MULLION_SERVICE_UNIT: config.MULLION_SERVICE_UNIT ?? "",
      MULLION_ROLE: config.MULLION_ROLE ?? "primary",
    },
    log: {
      info: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    },
  } as unknown as FastifyInstance;
}

// The updater always invokes THIS running release's own copy of the script.
function stubSelfUpdateScript(mullionHome: string): void {
  const scriptPath = path.join(mullionHome, "current", "scripts", "self-update.sh");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n");
}

describe("spawnSelfUpdate", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnCalls.length = 0;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  it("bootstraps a one-shot launchd job on macOS", () => {
    setPlatform("darwin");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-macos-"));
    try {
      stubSelfUpdateScript(home);
      const result = spawnSelfUpdate(
        fakeApp({ MULLION_HOME: home, MULLION_SERVICE_UNIT: "com.mullion.primary" }),
        {
          version: "9.9.9",
          assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
          checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
        },
      );
      expect(result.ok).toBe(true);

      // One launchctl call: the bootstrap of the update job.
      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe("launchctl");
      expect(call.args[0]).toBe("bootstrap");
      expect(call.args[1]).toBe(`gui/${process.getuid?.() ?? 501}`);

      // The plist it points at is a job of its own — that is what survives the
      // restart the update triggers.
      const plistPath = call.args[2]!;
      expect(plistPath).toBe(path.join(home, "logs", "com.mullion.update-9.9.9.plist"));
      const plist = fs.readFileSync(plistPath, "utf8");
      expect(plist).toContain("<key>Label</key>");
      expect(plist).toContain("com.mullion.update-9.9.9");
      expect(plist).toContain("self-update.sh");
      expect(plist).toContain("com.mullion.primary");
      // The job's own children must survive the restart it triggers.
      expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still uses systemd-run on linux", () => {
    setPlatform("linux");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-linux-"));
    try {
      stubSelfUpdateScript(home);
      const result = spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(true);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.command).toBe("systemd-run");
      expect(spawnCalls[0]!.args).toContain("--scope");
      // No launchd plist is written on linux.
      expect(fs.existsSync(path.join(home, "logs"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses when MULLION_HOME is not configured", () => {
    setPlatform("darwin");
    const result = spawnSelfUpdate(fakeApp({ MULLION_HOME: "  " }), {
      version: "9.9.9",
      assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
      checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
    });
    expect(result.ok).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});
