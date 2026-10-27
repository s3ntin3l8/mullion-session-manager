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
import type * as SessionShell from "../../src/services/session-shell.js";
import type { SpawnSelfUpdateResult } from "../../src/services/update-apply.js";

/**
 * spawnSelfUpdate's result is a discriminated union — the failure branch
 * carries `message`, the success branch a `body` — and an
 * `expect(...).toBe(false)` does not narrow a union. This picks the
 * failure branch out explicitly, so the message assertions below stay
 * exactly as they were written.
 */
function asFailure(result: SpawnSelfUpdateResult): Extract<SpawnSelfUpdateResult, { ok: false }> {
  if (result.ok) throw new Error("expected the update to have failed");
  return result;
}

const spawnCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> =
  [];
/** What the faked session-shell lookup answers: a path, or null for "no Git Bash". */
let gitBash: string | null = "C:/Program Files/Git/bin/bash.exe";
/** The fake child the last spawn returned, so a test can make it fail the way a real one can. */
let lastChild: EventEmitter | null = null;
/** When set, spawn throws this instead of returning a child. */
let spawnThrows: Error | null = null;

// The Windows updater runs in Git Bash, found through session-shell.ts — faked,
// so these tests do not depend on whether the machine they run on has one.
vi.mock("../../src/services/session-shell.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionShell>();
  return {
    ...actual,
    sessionShell: () => {
      if (gitBash === null) throw new actual.NoSessionShellError();
      return gitBash;
    },
  };
});
/** The exit status the fake launchctl reports (0 = success). */
let launchctlExitCode = 0;
/** Which launchctl calls, if any, never exit — a hung launchctl. */
let launchctlHangsOn: string[] = [];
/** How long a given launchctl call takes before it exits, in ms. */
let launchctlDelaysMs: Record<string, number> = {};
/**
 * How many `launchctl print` probes report the label as STILL registered
 * (exit 0) before the rest report it gone (exit non-zero).
 *
 * `launchctl print` is the probe the label wait uses (issue #1924): exit 0
 * while the label is registered, non-zero ("Could not find service") once
 * it is not. The default — 0 — is "already gone", which is the common case
 * (nothing was registered under that label).
 */
let launchctlPrintStillRegisteredTimes = 0;
/** When true, `launchctl print` ALWAYS reports the label as registered. */
let launchctlPrintNeverGoes = false;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options?: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      if (spawnThrows) throw spawnThrows;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        unref: () => void;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      lastChild = child;
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
        // The label probe has its OWN exit status: `print` answers "still
        // registered" (0) or "gone" (non-zero), which is the opposite
        // convention from the other launchctl calls.
        if (command === "launchctl" && args[0] === "print") {
          const stillRegistered = launchctlPrintNeverGoes
            ? true
            : launchctlPrintStillRegisteredTimes > 0;
          if (launchctlPrintStillRegisteredTimes > 0) launchctlPrintStillRegisteredTimes--;
          const code = stillRegistered ? 0 : 113;
          if (!stillRegistered) {
            child.stderr.emit(
              "data",
              Buffer.from('Bad request.\nCould not find service "x" in domain for user gui: 501\n'),
            );
          }
          child.emit("exit", code);
          child.emit("close", code);
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
    launchctlPrintStillRegisteredTimes = 0;
    launchctlPrintNeverGoes = false;
    gitBash = "C:/Program Files/Git/bin/bash.exe";
    lastChild = null;
    spawnThrows = null;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  // The Windows path (issue #2161, part of #1728): the updater is Git Bash
  // running self-update.sh, spawned DETACHED — which is what lets it outlive
  // the scheduled task being stopped by its own last step — with its output
  // in logs/update-<version>.log.
  describe("on Windows", () => {
    const apply = (home: string, config: Partial<Parameters<typeof fakeApp>[0]> = {}) =>
      spawnSelfUpdate(fakeApp({ MULLION_HOME: home, ...config }), {
        version: "1.2.3",
        assetUrl: "https://github.com/o/r/releases/download/v1.2.3/mullion-1.2.3.tgz",
        checksumUrl: "https://github.com/o/r/releases/download/v1.2.3/mullion-1.2.3.tgz.sha256",
      });
    const slashed = (p: string) => p.replaceAll("\\", "/");

    it("starts the update in a detached Git Bash, logging to logs/update-<version>.log", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        const result = await apply(home, { MULLION_ROLE: "agent" });
        expect(result).toEqual({
          ok: true,
          status: 202,
          body: { phase: "downloading", version: "1.2.3" },
        });

        expect(spawnCalls).toHaveLength(1);
        const call = spawnCalls[0]!;
        expect(call.command).toBe("C:/Program Files/Git/bin/bash.exe");
        // -l: a login shell, so /usr/bin is on PATH as it is for a session.
        expect(call.args).toEqual([
          "-l",
          slashed(path.join(home, "current", "scripts", "self-update.sh")),
          "1.2.3",
          "https://github.com/o/r/releases/download/v1.2.3/mullion-1.2.3.tgz",
          "https://github.com/o/r/releases/download/v1.2.3/mullion-1.2.3.tgz.sha256",
          slashed(home),
          slashed(process.execPath),
          "Mullion-agent",
        ]);
        // Detached, like the pty-host master: outside the task's process
        // tree, so stopping the task does not stop the updater.
        expect(call.options).toMatchObject({ detached: true, windowsHide: true, cwd: home });
        const stdio = call.options!.stdio as unknown[];
        expect(stdio[0]).toBe("ignore");
        expect(typeof stdio[1]).toBe("number");
        expect(stdio[2]).toBe(stdio[1]);
        expect(fs.existsSync(path.join(home, "logs", "update-1.2.3.log"))).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("uses neither systemd-run nor launchctl", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        await apply(home);
        expect(spawnCalls.map((c) => c.command)).not.toContain("systemd-run");
        expect(spawnCalls.map((c) => c.command)).not.toContain("launchctl");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("restarts the task the launcher named, and falls back to the role's task", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        await apply(home, { MULLION_SERVICE_UNIT: "My-Task", MULLION_ROLE: "agent" });
        expect(spawnCalls[0]!.args.at(-1)).toBe("My-Task");
        spawnCalls.length = 0;
        await apply(home, { MULLION_ROLE: "agent" });
        expect(spawnCalls[0]!.args.at(-1)).toBe("Mullion-agent");
        spawnCalls.length = 0;
        // Not a systemd unit name, which names no task on Windows.
        await apply(home, { MULLION_ROLE: "primary" });
        expect(spawnCalls[0]!.args.at(-1)).toBe("Mullion-primary");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("says so, and starts nothing, when there is no Git Bash to run the updater in", async () => {
      setPlatform("win32");
      gitBash = null;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        const result = await apply(home);
        expect(result).toMatchObject({ ok: false, status: 500 });
        expect(asFailure(result).message).toMatch(/no Git Bash found/);
        expect(spawnCalls).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("does not claim the update started when its log cannot be opened", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        // A file where the logs directory has to be.
        fs.writeFileSync(path.join(home, "logs"), "in the way");
        const result = await apply(home);
        expect(result).toMatchObject({ ok: false, status: 500 });
        expect(asFailure(result).message).toMatch(/could not open the update log/);
        expect(spawnCalls).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("writes a failed status when bash cannot be started, since the caller was already told 202", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        expect(await apply(home)).toMatchObject({ ok: true, status: 202 });
        // The failure arrives asynchronously, as a real spawn's does.
        lastChild!.emit("error", new Error("spawn bash.exe ENOENT"));
        const status = JSON.parse(fs.readFileSync(path.join(home, ".update-status.json"), "utf8"));
        expect(status).toMatchObject({ phase: "failed", version: "1.2.3" });
        expect(status.error).toMatch(/could not start the updater: spawn bash\.exe ENOENT/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("reports a spawn that throws as a failed launch, not an unhandled error", async () => {
      setPlatform("win32");
      spawnThrows = new Error("EPERM: operation not permitted");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        const result = await apply(home);
        expect(result).toMatchObject({ ok: false, status: 500 });
        expect(asFailure(result).message).toMatch(/could not start the updater: EPERM/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("still refuses a second update while one is in flight", async () => {
      setPlatform("win32");
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-windows-"));
      try {
        stubSelfUpdateScript(home);
        fs.writeFileSync(
          path.join(home, ".update-status.json"),
          JSON.stringify({
            phase: "installing",
            version: "1.2.3",
            updatedAt: Math.floor(Date.now() / 1000),
          }),
        );
        const result = await apply(home);
        expect(result).toMatchObject({ ok: false, status: 409 });
        expect(spawnCalls).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

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

      // Three launchctl calls: the bootout of a label a failed previous
      // update left registered, the probe that waits for it to actually
      // unload (issue #1924), then the bootstrap of this one.
      expect(spawnCalls).toHaveLength(3);
      expect(spawnCalls[0]!.command).toBe("launchctl");
      expect(spawnCalls[0]!.args[0]).toBe("bootout");
      expect(spawnCalls[1]!.args[0]).toBe("print");
      const call = spawnCalls[2]!;
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
      expect(calls).toHaveLength(3);
      expect(calls[0]!.args[0]).toBe("bootout");
      expect(calls[0]!.args[1]).toMatch(/com\.mullion\.update-9\.9\.9$/);
      // The wait for the label to actually unload, between the two.
      expect(calls[1]!.args[0]).toBe("print");
      expect(calls[1]!.args[1]).toMatch(/com\.mullion\.update-9\.9\.9$/);
      expect(calls[2]!.args[0]).toBe("bootstrap");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Issue #1924 — the bootout is NOT enough on its own.
  //
  // `launchctl bootout` returns BEFORE launchd has finished unloading the
  // label, and `launchctl bootstrap` refuses a label that is still
  // registered. Measured on real hardware, the immediate re-bootstrap
  // failed about half the time — and the losing side left the host with
  // NO job loaded at all.
  it("waits for the label to be unloaded before bootstrapping it back", async () => {
    setPlatform("darwin");
    // The label keeps reporting itself as registered for 3 probes after
    // the bootout — launchd's own teardown, lagging the bootout's return.
    launchctlPrintStillRegisteredTimes = 3;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-unload-wait-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      // The update still starts: the wait ends when the label is really
      // gone, and the bootstrap then succeeds.
      expect(result.ok).toBe(true);

      const calls = spawnCalls.filter((call) => call.command === "launchctl");
      const probeIndexes = calls
        .map((call, index) => ({ call, index }))
        .filter((entry) => entry.call.args[0] === "print")
        .map((entry) => entry.index);
      const bootoutIndex = calls.findIndex((call) => call.args[0] === "bootout");
      const bootstrapIndex = calls.findIndex((call) => call.args[0] === "bootstrap");
      // More than one probe: the first said "still registered".
      expect(probeIndexes.length).toBeGreaterThanOrEqual(2);
      expect(probeIndexes[0]!).toBeGreaterThan(bootoutIndex);
      expect(probeIndexes[probeIndexes.length - 1]!).toBeLessThan(bootstrapIndex);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not start the update when the label never unloads", async () => {
    setPlatform("darwin");
    // The label never finishes unloading. The bootstrap would be refused
    // with launchd's own opaque "Input/output error" — so the update must
    // NOT start, and must say why instead.
    launchctlPrintNeverGoes = true;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-never-unloads-"));
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
      expect(asFailure(result).message).toMatch(/still registered/);
      expect(asFailure(result).message).toMatch(/com\.mullion\.update-9\.9\.9/);
      // And the load-bearing part: the bootstrap was never attempted, so
      // the host is not left in the state the race used to produce.
      expect(
        spawnCalls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap"),
      ).toHaveLength(0);
      // The wait is bounded by the shared deadline, not the test's timeout.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not start the update when the label probe never answers", async () => {
    // The load-bearing distinction: a probe that NEVER RAN is not the same
    // as a probe that ran and said "the label is gone". Reading the first
    // as the second would let the bootstrap through on no evidence at all —
    // and the bootstrap would then be refused by launchd with the very
    // opaque error this wait exists to prevent.
    setPlatform("darwin");
    launchctlHangsOn = ["print"];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-apply-probe-hung-"));
    try {
      stubSelfUpdateScript(home);
      const result = await spawnSelfUpdate(fakeApp({ MULLION_HOME: home }), {
        version: "9.9.9",
        assetUrl: "https://example.invalid/mullion-9.9.9.tgz",
        checksumUrl: "https://example.invalid/mullion-9.9.9.tgz.sha256",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      // The message says the probe never answered — NOT that the label is
      // gone, and not that it is still registered.
      expect(asFailure(result).message).toMatch(/probe never answered/);
      expect(asFailure(result).message).not.toMatch(/still registered when the wait ran out/);
      // And the bootstrap was never attempted: nothing was proved, so
      // nothing was started.
      expect(
        spawnCalls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap"),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

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
      expect(asFailure(result).message).toMatch(/Bootstrap failed/);
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
      expect(asFailure(result).message).toMatch(/timed out after (9\d{3}|10000)ms/);
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
      expect(asFailure(result).message).toMatch(/already exhausted/);
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
    // 4s of the 10s budget: the bootstrap is left with ~6s — comfortably
    // above the floor (1s) even when a loaded runner overshoots the delay by
    // a second or two, and comfortably below the whole budget.
    launchctlDelaysMs = { bootout: 4_000 };
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
      // The budget the call was LEFT with, parsed out of the message and
      // bounded on BOTH sides rather than matched against a digit count: a
      // regex like /1\d{3}ms/ is a 1ms-wide window at its upper edge, and
      // the bootout's own overshoot moves the number. The bounds are the
      // ones that matter: above the floor (the call WAS attempted) and
      // below the whole budget (it was a PARTIAL one).
      const timedOut = /timed out after (\d+)ms/.exec(asFailure(result).message);
      expect(timedOut).not.toBeNull();
      const budget = Number(timedOut?.[1]);
      expect(budget).toBeGreaterThan(1_000);
      expect(budget).toBeLessThan(10_000);
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
      expect(asFailure(result).message).toMatch(/already exhausted/);
      // The short-circuit's own wording is pinned too — it is the PR's only
      // production change, and "already exhausted" alone is satisfied by the
      // old constant form as well: what makes it true is that it says what
      // was LEFT.
      expect(asFailure(result).message).toMatch(/only \d+ms of the 10000ms budget was left/);
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
