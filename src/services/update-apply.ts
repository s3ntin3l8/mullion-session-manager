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
import { resolveServiceUnit } from "./systemd-unit.js";

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
 * bootstraps a dtach master: a transient `systemd-run --user --scope`,
 * outside this process's own cgroup, so it survives the restart its own
 * last step triggers. Shared by both /api/updates/apply (primary) and
 * /internal/updates/apply (agent, issue #647) — see this module's own
 * top-of-file comment for why.
 */
export function spawnSelfUpdate(
  app: FastifyInstance,
  body: ApplyUpdateBody,
): SpawnSelfUpdateResult {
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
  // itself, since it runs inside the wrapperUnitName scope below, not the
  // app's own unit. This is what makes the final `systemctl --user restart`
  // target the unit actually installed on this host, even if it was renamed
  // after install (see src/services/systemd-unit.ts).
  const serviceUnit = resolveServiceUnit({ override: app.config.MULLION_SERVICE_UNIT });
  app.log.info({ serviceUnit, version }, "resolved systemd unit for self-update restart");

  // Detached exactly like pty-manager.ts's bootstrapMaster spawns a dtach
  // master: a transient systemd --user scope, collected automatically on
  // exit, outside this process's own cgroup. Required because the script's
  // own last step restarts *this* process's systemd unit — a plain child
  // spawned from here would die with it.
  const wrapperUnitName = `mullion-update-${version}`;
  const child = spawnChild(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--collect",
      "-u",
      wrapperUnitName,
      "--",
      scriptPath,
      version,
      assetUrl,
      checksumUrl,
      mullionHome,
      process.execPath,
      serviceUnit,
    ],
    { cwd: mullionHome, env: process.env, stdio: "ignore" },
  );
  child.on("error", (err) => {
    app.log.error({ err, wrapperUnitName }, "failed to launch self-update.sh");
  });
  child.unref();

  return { ok: true, status: 202, body: { phase: "downloading", version } };
}
