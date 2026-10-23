// Issue #1718 (roadmap 8.4) — the macOS self-update path.
//
// On Linux the updater runs inside a transient `systemd-run --user --scope`, so
// it survives the restart its own last step triggers. On macOS the equivalent
// is a ONE-SHOT LAUNCHD JOB: the app's own job is killed by that restart, so an
// updater running inside it would die mid-flight.
//
// These tests pin that shape: the plist that is written, the label it carries,
// and the `launchctl bootstrap` that loads it — plus the unchanged Linux path.
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";

const spawnCalls: Array<{ command: string; args: string[] }> = [];
/** The exit status the fake launchctl reports (0 = success). */
let launchctlExitCode = 0;
/** When set, the fake launchctl never exits — a hung launchctl. */
let launchctlHangs = false;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        unref: () => void;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.unref = () => undefined;
      // The production code kills the child on timeout; the fake has to
      // survive that call (and then stay silent — a killed child never
      // emits "close").
      child.kill = () => true;
      setImmediate(() => {
        if (command === "launchctl" && launchctlHangs) return; // a hung launchctl
        if (command === "launchctl" && launchctlExitCode !== 0) {
          child.stderr.emit("data", Buffer.from("Bootstrap failed: 5: Input/output error\n"));
        }
        const code = command === "launchctl" ? launchctlExitCode : 0;
        child.emit("exit", code);
        // "close" as well as "exit": the production code waits for "close", so
        // the fake has to emit both (a real child emits "close" once its
        // stdio has drained).
        child.emit("close", code);
      });
      return child;
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
      warn: (...args: unknown[]) => logs.push(args),
      debug: (...args: unknown[]) => logs.push(args),
    },
  } as unknown as FastifyInstance;
}

// The updater always invokes THIS running release's own copy of the script.
function stubSelfUpdateScript(mullionHome: string): void {
  const scriptPath = path.join(mullionHome, "current", "scripts", "self-update.sh");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n");
}

describe("spawnSelfUpdate", async () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnCalls.length = 0;
    launchctlExitCode = 0;
    launchctlHangs = false;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  it("bootstraps a one-shot launchd job on macOS", async () => {
    setPlatform("darwin");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-macos-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(
        fakeApp({ MULLION_HOME: home, MULLION_SERVICE_UNIT: "com.mullion.primary" }),
        {
          version: "9.9.9",
          assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
          checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
        },
      );
      expect(result.ok).toBe(true);

      // Two launchctl calls: the bootout of a label a failed previous update
      // left registered, then the bootstrap of this one.
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]!.command).toBe("launchctl");
      expect(spawnCalls[0]!.args[0]).toBe("bootout");
      const call = spawnCalls[1]!;
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

  it("boots the update job's label out before bootstrapping it", async () => {
    // `launchctl bootstrap` refuses an ALREADY-LOADED label, and a failed
    // update leaves this job registered — so the most likely retry (the same
    // version again) would be refused, silently doing nothing.
    setPlatform("darwin");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-bootout-"));
    try {
      stubSelfUpdateScript(home);
      await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      const calls = spawnCalls.filter((call) => call.command === "launchctl");
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0]).toBe("bootout");
      expect(calls[0]!.args[1]).toMatch(/com\.mullion\.update-9\.9\.9$/);
      expect(calls[1]!.args[0]).toBe("bootstrap");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a launchctl refusal instead of claiming the update started", async () => {
    // A refusal that is swallowed would be a 202 and a UI that says
    // "downloading" for a job that never started.
    setPlatform("darwin");
    launchctlExitCode = 5;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-refused-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/Bootstrap failed/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives up on a hung launchctl instead of hanging the request", async () => {
    // A hung launchctl would leave the UI's "Update now" button spinning with
    // no answer: the route waits for the spawn. The wait is bounded.
    setPlatform("darwin");
    launchctlHangs = true;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-hung-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/timed out/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("still uses systemd-run on linux", async () => {
    setPlatform("linux");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-linux-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
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

  it("refuses a version that is not MAJOR.MINOR.PATCH", async () => {
    // The version ends up in a FILENAME (the update job's plist) and in a
    // launchd LABEL, so it is validated where the path is built rather than
    // trusted from the route's schema alone.
    setPlatform("darwin");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-version-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "../../etc/passwd",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(spawnCalls).toHaveLength(0);
      expect(fs.existsSync(path.join(home, "logs"))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses when MULLION_HOME is not configured", async () => {
    setPlatform("darwin");
    const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: "  " }), {
      version: "9.9.9",
      assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
      checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
    });
    expect(result.ok).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});
