// Issue #647 / roadmap 7.8 — the apply/status logic self-update.sh's HTTP
// trigger needs, shared verbatim between the primary's own /api/updates/*
// (src/routes/updates.ts) and the agent's /internal/updates/* (routes/
// internal.ts), so both roles run byte-identical spawn/status logic instead
// of two copies that could drift apart (same "one shared function" reasoning
// as buildAgentConfig, src/routes/internal.ts).
import type { FastifyInstance } from "fastify";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveServiceUnit } from "./service-unit.js";

// In-flight phases self-update.sh writes to $MULLION_HOME/.update-status.json
// while an update is running — see scripts/self-update.sh's write_status().
export const IN_FLIGHT_PHASES = new Set(["downloading", "installing", "verifying", "restarting"]);

// An in-flight status older than this is treated as abandoned, not a
// genuinely running update — this is a best-effort pre-check only (see
// spawnSelfUpdate's own comment), deliberately NOT tied to self-update.sh's
// own STALE_LOCK_SECONDS: that constant must exceed the script's real
// worst-case runtime or two updaters could run concurrently, which is a
// correctness invariant. This one only decides how long a crashed update
// keeps showing a 409 "in progress" in the UI before this route will spawn a
// fresh attempt — a UX tradeoff, not a safety one — so raising the former
// (to keep its margin healthy as steps are added) doesn't need to raise this
// one too.
export const STALE_STATUS_SECONDS = 1800;

export function isStale(status: UpdateStatus): boolean {
  if (status.updatedAt === undefined) return true;
  return Date.now() / 1000 - status.updatedAt > STALE_STATUS_SECONDS;
}

export interface UpdateStatus {
  phase: string;
  version?: string;
  updatedAt?: number;
  error?: string;
}

function statusFilePath(mullionHome: string): string {
  return path.join(mullionHome, ".update-status.json");
}

/** Best-effort read — a missing or unparseable status file just means "no
 * update has ever run here," not an error worth surfacing. */
export function readStatus(mullionHome: string): UpdateStatus {
  try {
    const raw = fs.readFileSync(statusFilePath(mullionHome), "utf8");
    return JSON.parse(raw) as UpdateStatus;
  } catch {
    return { phase: "idle" };
  }
}

export interface ApplyUpdateBody {
  version: string;
  assetUrl: string;
  checksumUrl: string;
}

// version/assetUrl/checksumUrl are exactly what the caller already resolved
// from the latest/target release — apply doesn't re-hit GitHub itself, both
// to avoid a second network round-trip and to avoid racing "the target
// changed between check and apply."
export const applyUpdateSchema = {
  body: {
    type: "object",
    required: ["version", "assetUrl", "checksumUrl"],
    additionalProperties: false,
    properties: {
      version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
      // Restricted to github.com, not just "https://" — these URLs are
      // handed straight to curl inside self-update.sh (running as this
      // host user, with `npm ci` and a systemd unit restart downstream of
      // it), so pinning them to GitHub's own release-asset host is cheap
      // defense-in-depth against a tampered/malicious body. checksumUrl is
      // required, not optional — self-update.sh verifies the tarball
      // against it before extracting (Hermes review, PR #54: "no integrity
      // verification of the downloaded tarball").
      assetUrl: { type: "string", pattern: "^https://github\\.com/" },
      checksumUrl: { type: "string", pattern: "^https://github\\.com/" },
    },
  },
};

export type SpawnSelfUpdateResult =
  | { ok: true; status: 202; body: { phase: "downloading"; version: string } }
  | { ok: false; status: 400 | 409 | 500; message: string };

/**
 * Spawns scripts/self-update.sh detached, exactly the way pty-manager.ts
 * bootstraps a dtach master: outside this process's own service, so it
 * survives the restart its own last step triggers. On Linux that is a
 * transient `systemd-run --user --scope`; on macOS it is a one-shot launchd
 * job (issue #1718) — see launchOneShotUpdateJob below.
 *
 * Shared by both /api/updates/apply (primary) and
 * /internal/updates/apply (agent, issue #647) — see this module's own
 * top-of-file comment for why.
 */
export async function spawnSelfUpdate(
  app: FastifyInstance,
  body: ApplyUpdateBody,
): Promise<SpawnSelfUpdateResult> {
  const mullionHome = app.config.MULLION_HOME;
  if (mullionHome.trim() === "") {
    return {
      ok: false,
      status: 400,
      message:
        "MULLION_HOME is not configured — this instance is not a versioned-release " +
        "install (see deploy/README.md), so there's no releases/ dir to install into " +
        "or `current` symlink to flip.",
    };
  }

  // Best-effort pre-check: self-update.sh also takes its own filesystem
  // lock (mkdir $MULLION_HOME/.update.lock) as the real guard against two
  // concurrent applies racing each other — this check just avoids spawning
  // a doomed second process and gives the caller a clean 409 instead of a
  // spawn that immediately fails. A stale in-flight status (isStale — see
  // above) does NOT block here: self-update.sh's own lock staleness
  // recovery handles the actual concurrency guard, and this route refusing
  // to even spawn it would be the thing that permanently bricks recovery
  // after a crash.
  const current = readStatus(mullionHome);
  if (IN_FLIGHT_PHASES.has(current.phase) && !isStale(current)) {
    return {
      ok: false,
      status: 409,
      message: `update already in progress (phase: ${current.phase})`,
    };
  }

  const { version, assetUrl, checksumUrl } = body;
  // The version ends up in a FILENAME (the launchd update job's plist) and in
  // a launchd LABEL, so it is validated here rather than trusted from the
  // route's schema alone: the routes already constrain it, and this keeps the
  // guarantee where the path is actually built (defence in depth for a
  // caller that reaches this function another way).
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      ok: false,
      status: 400,
      message: `invalid version "${version}" — expected MAJOR.MINOR.PATCH`,
    };
  }
  // Ships inside every release tarball — always invoke *this running
  // release's own* copy (current/scripts/self-update.sh), not some other
  // version's, so the update logic in flight matches the app that decided
  // to run it.
  const scriptPath = path.join(mullionHome, "current", "scripts", "self-update.sh");
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      status: 500,
      message: `self-update script not found at ${scriptPath} — this release may predate the auto-update feature`,
    };
  }

  // Resolved from *this* long-lived process's own cgroup (or an explicit
  // MULLION_SERVICE_UNIT override) — self-update.sh can't do this detection
  // itself, since it runs inside the wrapper scope/job below, not the app's
  // own service. This is what makes the final restart target the service
  // actually installed on this host, even if it was renamed after install
  // (see src/services/service-unit.ts). On macOS this is the launchd LABEL
  // rather than a systemd unit name (issue #1718).
  const serviceUnit = resolveServiceUnit({
    override: app.config.MULLION_SERVICE_UNIT,
    role: app.config.MULLION_ROLE,
  });
  app.log.info({ serviceUnit, version }, "resolved service for self-update restart");

  // Detached exactly like pty-manager.ts's bootstrapMaster spawns a dtach
  // master: outside this process's own service, so it survives the restart
  // its own last step triggers. Required because the script's last step
  // restarts *this* process's service — a plain child spawned from here
  // would die with it.
  //
  // On Linux that is a transient `systemd-run --user --scope`, collected
  // automatically on exit. On macOS the equivalent is a one-shot launchd
  // job: the app's own job is killed by the restart the update triggers,
  // so the updater has to be a job of its own (issue #1718).
  const scriptArgs = [
    scriptPath,
    version,
    assetUrl,
    checksumUrl,
    mullionHome,
    process.execPath,
    serviceUnit,
  ];

  if (process.platform === "darwin") {
    const launched = await launchOneShotUpdateJob(app, mullionHome, version, scriptArgs);
    if (!launched.ok) {
      return { ok: false, status: 500, message: launched.message };
    }
    return { ok: true, status: 202, body: { phase: "downloading", version } };
  }

  const wrapperUnitName = `mullion-update-${version}`;
  const child = spawnChild(
    "systemd-run",
    ["--user", "--scope", "--collect", "-u", wrapperUnitName, "--", ...scriptArgs],
    { cwd: mullionHome, env: process.env, stdio: "ignore" },
  );
  child.on("error", (err) => {
    app.log.error({ err, wrapperUnitName }, "failed to launch self-update.sh");
  });
  child.unref();

  return { ok: true, status: 202, body: { phase: "downloading", version } };
}

/**
 * The macOS counterpart of the transient `systemd-run --user --scope`: a
 * one-shot launchd job (issue #1718, roadmap 8.4).
 *
 * The job is its OWN launchd job, not a child of this process's: the app's
 * job is killed by the restart the update triggers, so an updater running
 * inside it would die mid-flight — exactly what the transient scope prevents
 * on Linux.
 *
 * The plist is written under the install root's logs/ dir (not
 * ~/Library/LaunchAgents) because it is not a persistent job: the script
 * removes it and boots itself out when it finishes.
 */
async function launchOneShotUpdateJob(
  app: FastifyInstance,
  mullionHome: string,
  version: string,
  scriptArgs: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const label = `com.mullion.update-${version}`;
  const logDir = path.join(mullionHome, "logs");
  const plistPath = path.join(logDir, `${label}.plist`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, renderUpdateJobPlist(label, scriptArgs, logDir), "utf8");
  } catch (err) {
    const message = `could not write the update job plist at ${plistPath}: ${err instanceof Error ? err.message : String(err)}`;
    app.log.error({ err, plistPath }, "failed to prepare the launchd update job");
    return { ok: false, message };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) {
    return {
      ok: false,
      message: "cannot determine this user's uid — launchd's per-user domain needs it",
    };
  }

  const domain = `gui/${uid}`;
  // `launchctl bootstrap` refuses an ALREADY-LOADED label ("Bootstrap
  // failed: 5: Input/output error"). A failed update leaves this job
  // registered (the script exits before its own bootout), so the next apply
  // for the SAME version — the most likely retry — would write the same
  // plist and be refused, silently doing nothing. Boot the label out first,
  // exactly as install.sh does for the app's own label.
  await runLaunchctl(["bootout", `${domain}/${label}`], { cwd: mullionHome });

  // launchctl's exit status is the answer: a refusal must not be reported
  // to the caller as a started update. stdio is inherited here (not
  // ignored) so launchd's own error text reaches the log.
  const result = await runLaunchctl(["bootstrap", domain, plistPath], { cwd: mullionHome });
  if (!result.ok) {
    const message = `launchctl could not start the update job (${label}): ${result.message}`;
    app.log.error({ label, plistPath, message }, "failed to launch the launchd update job");
    return { ok: false, message };
  }
  app.log.info({ label, plistPath }, "launched the launchd update job");
  return { ok: true };
}

/**
 * How long a launchctl subcommand may take before we give up on it.
 *
 * launchctl is a local, immediate operation — the bootstrap of a job
 * returns as soon as the job is registered. A hung launchctl would hang
 * the HTTP request that started the update, leaving the UI's "Update now"
 * button spinning with no answer, so the wait is bounded.
 */
const LAUNCHCTL_TIMEOUT_MS = 10_000;

/**
 * Runs a launchctl subcommand and reports its exit status.
 *
 * The child's output is PIPED, not inherited: launchd's own error text
 * (e.g. "Bootstrap failed: 5: Input/output error") is captured here so
 * the caller can put it in an API response, and it is logged so it also
 * reaches the app's log.
 */
function runLaunchctl(
  args: string[],
  options: { cwd: string; log?: { message: string } & Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const child = spawnChild("launchctl", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; message: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        message: `launchctl ${args[0]} timed out after ${LAUNCHCTL_TIMEOUT_MS}ms`,
      });
    }, LAUNCHCTL_TIMEOUT_MS);
    // The timer must not hold the event loop open on its own.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ ok: false, message: err.message });
    });
    child.on("exit", (code) => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, message: `exit ${code}: ${output.trim() || "no output"}` },
      );
    });
  });
}

/**
 * The one-shot job's plist. AbandonProcessGroup is set for the same reason
 * the app's own job sets it (see deploy/launchd/*.plist): the updater must
 * survive the restart it triggers.
 */
function renderUpdateJobPlist(label: string, scriptArgs: string[], logDir: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = scriptArgs.map((arg) => `    <string>${escape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(path.join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(path.join(logDir, `${label}.err.log`))}</string>
</dict>
</plist>
`;
}
