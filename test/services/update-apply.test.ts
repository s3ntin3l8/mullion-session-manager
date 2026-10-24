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
/** Which launchctl calls, if any, never exit — a hung launchctl. */
let launchctlHangsOn: string[] = [];
/** How long a given launchctl call takes before it exits, in ms. */
let launchctlDelaysMs: Record<string, number> = {};

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
      const finish = () => {
        // A hung launchctl: the calls we were told to hang never exit.
        if (command === "launchctl" && launchctlHangsOn.includes(args[0] ?? "")) {
          return;
        }
        if (command === "launchctl" && launchctlExitCode !== 0) {
          child.stderr.emit("data", Buffer.from("Bootstrap failed: 5: Input/output error\n"));
        }
        const code = command === "launchctl" ? launchctlExitCode : 0;
        child.emit("exit", code);
        // "close" as well as "exit": the production code waits for "close", so
        // the fake has to emit both (a real child emits "close" once its
        // stdio has drained).
        child.emit("close", code);
      };

      // A SLOW launchctl: it takes its time and then succeeds, which is how
      // the budget for the second call is spent down.
      const delay = command === "launchctl" ? (launchctlDelaysMs[args[0] ?? ""] ?? 0) : 0;
      if (delay > 0) {
        setTimeout(finish, delay);
      } else {
        setImmediate(finish);
      }
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
    launchctlHangsOn = [];
    launchctlDelaysMs = {};
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
    launchctlHangsOn = ["bootstrap"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-hung-"));
    try {
      stubSelfUpdateScript(home);
      const startedAt = Date.now();
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      const elapsed = Date.now() - startedAt;
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      // The message states the budget the call actually had — not the
      // constant, which would misreport a call killed at ~0ms.
      expect(result.message).toMatch(/timed out after (9\d{3}|10000)ms/);
      // The wait is bounded by the deadline, not by the test's own timeout.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("spends ONE deadline on the whole launch, not one per launchctl call", async () => {
    // The bootout hangs and eats the whole budget: the bootstrap must then be
    // short-circuited ("the deadline was already exhausted") rather than
    // given a fresh 10s of its own — and rather than being spawned and
    // killed at once, which could still register the job.
    setPlatform("darwin");
    // BOTH calls hang: with a shared budget the pair waits ONE deadline
    // (~10s); with a per-call budget it would wait two (~20s). The elapsed
    // time is what states the requirement — the message is incidental.
    launchctlHangsOn = ["bootout", "bootstrap"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-budget-"));
    try {
      stubSelfUpdateScript(home);
      const startedAt = Date.now();
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      const elapsed = Date.now() - startedAt;
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      // The SPECIFIC outcome: the budget was gone, so the bootstrap was never
      // even attempted. (A per-call budget would have started it and killed
      // it at once — the register-then-report-500 hazard.)
      expect(result.message).toMatch(/already exhausted/);
      expect(
        spawnCalls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap"),
      ).toHaveLength(0);
      // One budget for the pair: not two of them (which would be ~20s).
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  // Issue #1791 — the budget the message reports, and the floor's value.
  //
  // A SLOW bootout (it succeeds, but takes most of the budget) is what pins
  // both: the bootstrap is left with a PARTIAL budget, so its timeout message
  // must report that partial budget rather than the constant — and if the
  // budget it is left with is under the floor, the bootstrap must not be
  // spawned at all.
  it("reports the PARTIAL budget a slow bootout left, not the whole one", async () => {
    setPlatform("darwin");
    // 8s of the 10s budget: the bootstrap is left with ~2s, comfortably
    // above the floor, so it IS attempted and then times out on what is
    // actually left.
    launchctlDelaysMs = { bootout: 8_000 };
    // ...and the bootstrap then hangs, so its own (partial) budget is what
    // runs out.
    launchctlHangsOn = ["bootstrap"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-partial-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      // ~2s left, not 10s: the message reports the budget the call had.
      // (Reverting it to the constant prints "10000ms" and reds this.)
      expect(result.message).toMatch(/timed out after 1\d{3}ms/);
      // ...and the bootstrap was attempted (it had budget to try).
      expect(
        spawnCalls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap"),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("short-circuits when a slow bootout left less than the floor", async () => {
    setPlatform("darwin");
    // 9.5s of the 10s budget: the bootstrap is left with ~500ms — under the
    // floor — so it must NOT be spawned at all (starting it and killing it
    // at once could still register the job).
    launchctlDelaysMs = { bootout: 9_500 };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-floor-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/already exhausted/);
      // The bootstrap was never attempted.
      expect(
        spawnCalls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap"),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

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
