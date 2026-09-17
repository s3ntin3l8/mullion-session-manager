// The devices/AVD analogue of session-process.ts — same "id in a
// systemd --user scope, named per Mullion instance, owned by path" shape
// (see that file's own header and AGENTS.md's "non-obvious session model"
// note), but a DELIBERATELY SEPARATE module rather than a generalization of
// session-process.ts: that file is this repo's highest-risk one (see
// pty-manager.ts's own header), with an exhaustive existing test suite built
// around session-specific behavior (dtach sockets, launch plans, hook
// tokens). Reusing its actual logic here would mean either parameterizing
// it around a concept it was never designed to vary (real risk of
// destabilizing session code for an unrelated feature) or duplicating it
// blindly (drift risk). Instead this module reuses the genuinely
// resource-agnostic pieces directly — parseScopeUnitsListing,
// isSystemctlUserAvailable, armKillEscalation, deriveInstanceId, the
// systemctl timeout budget — and re-implements only the parts that
// legitimately differ.
//
// The one real difference from session-process.ts: a session's ownership
// check resolves a scope's Description back to a real, dtach-created
// AF_UNIX socket path. An emulator has no dtach, no PTY, and nothing else
// that would naturally embed an absolute path in its own command line the
// way `dtach -n <path> ...` does. So this module makes systemd-run set the
// scope's Description EXPLICITLY via `--description`, to a synthetic marker
// path of this module's own choosing (`deviceMarkerPath` below) — encoding
// the exact same "<sessionsDir>/<id>" ownership shape listOwnedScopes()
// already established, without needing to reverse-engineer any other
// process's argv rendering.
//
// Unlike a dtach socket, nothing external creates this file — dtach itself
// creates and (on clean exit) removes its own AF_UNIX socket; there is no
// equivalent for an emulator. So DeviceManager (the caller) is responsible
// for touchDeviceMarker() before spawning and removeDeviceMarker() on
// terminate — deliberately made a real, empty file rather than a pure
// naming convention, specifically so scripts/check-scope-leaks.ts's
// existing "socket file no longer exists on disk" / "socket lives under the
// OS tmp dir" leak heuristics apply to `crs-device-*` scopes with the exact
// same two rules, unmodified. A leaked emulator holds a KVM handle and
// several GB — materially worse than a leaked shell — so it gets the same
// safety net, not a weaker one.

import { spawn as spawnChild } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  armKillEscalation,
  deriveInstanceId,
  isSystemctlUserAvailable,
  parseScopeUnitsListing,
  SYSTEMCTL_TIMEOUT_MS,
  type SessionLiveness,
} from "./session-process.js";

export { deriveInstanceId, isSystemctlUserAvailable };
export type DeviceLiveness = SessionLiveness;

/** Same per-instance namespacing as scopeUnitName() (session-process.ts) —
 * see that function's own doc comment. A different prefix (`crs-device-`
 * rather than `crs-session-`) is the only thing that keeps the two kinds of
 * scope from ever colliding on the same numeric id. */
export function deviceScopeUnitName(instanceId: string, id: string): string {
  return `crs-device-${instanceId}-${id}`;
}

/** The synthetic ownership marker embedded in a device scope's Description
 * via `--description` (see this module's own header). Deliberately mirrors
 * `<sessionsDir>/<id>.sock`'s shape (`<sessionsDir>/<id>.device`) so
 * listOwnedDeviceScopes' `path.dirname(...) === resolvedSessionsDir` check
 * is identical in spirit to session-process.ts's own. */
export function deviceMarkerPath(sessionsDir: string, id: string): string {
  return path.join(path.resolve(sessionsDir), `${id}.device`);
}

/** Creates the empty marker file — see this module's own header on why it
 * must be a real file, not just a string embedded in a scope Description.
 * Call before spawning the scope, so the marker exists by the time any
 * concurrent listing could race it.
 *
 * Opens with the exclusive-create flag (`wx`, i.e. `O_CREAT | O_EXCL`)
 * rather than a plain `w` (CodeQL `js/insecure-temporary-file`, PR #1324's
 * follow-up review): `w` truncates and follows an existing path unconditionally,
 * including a symlink an attacker pre-planted at this predictable
 * `<sessionsDir>/<id>.device` path — a classic TOCTOU that would make this
 * write land wherever that symlink points. A stale marker can legitimately
 * still be on disk here too (a crash before removeDeviceMarker() ran on a
 * scope getOrCreate() has already confirmed dead), so it's unlinked first —
 * unlink never follows a symlink either, so a planted one is removed, not
 * written through. */
export function touchDeviceMarker(sessionsDir: string, id: string): void {
  const markerPath = deviceMarkerPath(sessionsDir, id);
  try {
    unlinkSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  closeSync(openSync(markerPath, "wx"));
}

/** Best-effort cleanup — safe to call even if the marker was never created
 * or was already removed. */
export function removeDeviceMarker(sessionsDir: string, id: string): void {
  try {
    unlinkSync(deviceMarkerPath(sessionsDir, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Verified empirically against a real `systemd --user`: unlike
// session-process.ts's DTACH_SOCKET_PATTERN (which recovers a path from
// systemd's own argv-derived rendering, where a space-containing argument
// gets quoted), an explicit `--description` string is stored VERBATIM, with
// no quoting added — `systemd-run ... --description "mullion-device -m /a
// b/1.device"` round-trips through `systemctl show -p Description` as
// `mullion-device -m /a b/1.device`, unquoted. So the marker path is simply
// "everything after the prefix, to end of line" — no quote-alternatives to
// handle. Unanchored at the start (robust to incidental leading content),
// `.+` (not `\S+`) so a path containing a space is captured whole rather
// than truncated at the first space.
const DEVICE_MARKER_PATTERN = /mullion-device -m (.+)$/;

/** Recovers the marker path from a `crs-device-*` scope's Description
 * (`mullion-device -m <path>`, this module's own fixed format — see the
 * header comment on why this doesn't need to parse anyone else's argv
 * rendering the way extractDtachSocketPath does). `null` for a scope this
 * app didn't create, or whose Description doesn't match. */
export function extractDeviceMarkerPath(description: string): string | null {
  const match = DEVICE_MARKER_PATTERN.exec(description);
  return match ? match[1] : null;
}

function candidateIdForDeviceUnit(unit: string, instanceId: string): string | null {
  const match = /^crs-device-(.+)\.scope$/.exec(unit);
  if (!match) return null;
  const rest = match[1];
  const prefix = `${instanceId}-`;
  return rest.startsWith(prefix) ? rest.slice(prefix.length) : rest;
}

/** Same ownership contract as session-process.ts's ScopeOwnershipListing —
 * see that interface's own doc comment for the full "owned / unverifiable /
 * failed" trust rule every caller here must honor identically. */
export interface DeviceScopeOwnershipListing {
  owned: Map<string, string>;
  unverifiable: Set<string>;
  failed: boolean;
}

export function listOwnedDeviceScopes(
  sessionsDir: string,
  instanceId: string,
  opts: { states?: string; all?: boolean } = {},
): Promise<DeviceScopeOwnershipListing> {
  return new Promise((resolve) => {
    const args = ["--user", "list-units", "--type=scope"];
    if (opts.all) args.push("--all");
    if (opts.states) args.push(`--state=${opts.states}`);
    args.push("--no-legend", "--plain", "crs-device-*.scope");

    let stdout = "";
    let settled = false;
    const child = spawnChild("systemctl", args, { stdio: ["ignore", "pipe", "ignore"] });

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    const finish = (result: DeviceScopeOwnershipListing) => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onStdoutData);
      resolve(result);
    };
    const fail = () => finish({ owned: new Map(), unverifiable: new Set(), failed: true });

    const armed = armKillEscalation(child, SYSTEMCTL_TIMEOUT_MS, fail);

    child.on("error", () => {
      armed.clearOnSettle();
      fail();
    });
    child.on("close", (code) => {
      armed.clearOnSettle();
      if (code !== 0) {
        fail();
        return;
      }
      const resolvedSessionsDir = path.resolve(sessionsDir);
      const owned = new Map<string, string>();
      const unverifiable = new Set<string>();
      for (const { unit, description } of parseScopeUnitsListing(stdout)) {
        const markerPath = extractDeviceMarkerPath(description);
        if (markerPath === null) {
          const candidateId = candidateIdForDeviceUnit(unit, instanceId);
          if (candidateId !== null) unverifiable.add(candidateId);
          continue;
        }
        if (path.dirname(markerPath) === resolvedSessionsDir) {
          owned.set(path.basename(markerPath, ".device"), unit);
        }
      }
      finish({ owned, unverifiable, failed: false });
    });
  });
}

async function resolveOwningDeviceUnit(
  sessionsDir: string,
  instanceId: string,
  id: string,
  opts: { fallbackOnListingFailure: boolean },
): Promise<string | undefined> {
  const listing = await listOwnedDeviceScopes(sessionsDir, instanceId, { all: true });
  if (listing.failed) {
    return opts.fallbackOnListingFailure
      ? `${deviceScopeUnitName(instanceId, id)}.scope`
      : undefined;
  }
  return listing.owned.get(id);
}

/** Stop a device's systemd scope (killing the emulator process). Safe to
 * call even if the scope doesn't exist or is already gone — same
 * best-effort posture as session-process.ts's stopScope, including its
 * `fallbackOnListingFailure: true` reasoning (a namespaced unit name cannot
 * name a different instance's scope absent an instanceId hash collision, so
 * falling back to it on a listing failure is safe). */
export async function stopDeviceScope(
  sessionsDir: string,
  instanceId: string,
  id: string,
): Promise<void> {
  const unit = await resolveOwningDeviceUnit(sessionsDir, instanceId, id, {
    fallbackOnListingFailure: true,
  });
  if (unit === undefined) return;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnChild("systemctl", ["--user", "stop", unit], { stdio: "ignore" });

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const armed = armKillEscalation(child, SYSTEMCTL_TIMEOUT_MS, finish);

    child.on("error", () => {
      armed.clearOnSettle();
      finish();
    });
    child.on("exit", () => {
      armed.clearOnSettle();
      finish();
    });
  });
}

/** Same batched-liveness shape/trust-rule as session-process.ts's
 * isMasterAliveStateBatch — see that function's own doc comment. Every
 * requested id is always present in the result; "unknown" must never be
 * collapsed to "dead" by a caller taking a destructive action. */
export async function isDeviceAliveStateBatch(
  sessionsDir: string,
  instanceId: string,
  ids: string[],
): Promise<Record<string, DeviceLiveness>> {
  if (ids.length === 0) return Object.create(null);
  const listing = await listOwnedDeviceScopes(sessionsDir, instanceId, {
    states: "active,deactivating",
  });
  const result: Record<string, DeviceLiveness> = Object.create(null);
  for (const id of ids) {
    if (listing.failed) {
      result[id] = "unknown";
    } else if (listing.owned.has(id)) {
      result[id] = "alive";
    } else if (listing.unverifiable.has(id)) {
      result[id] = "unknown";
    } else {
      result[id] = "dead";
    }
  }
  return result;
}

export async function isDeviceAliveState(
  sessionsDir: string,
  instanceId: string,
  id: string,
): Promise<DeviceLiveness> {
  const result = await isDeviceAliveStateBatch(sessionsDir, instanceId, [id]);
  return result[id];
}

export interface DeviceLaunchPlan {
  unitName: string;
  argv: string[];
}

/** Builds the `systemd-run` argv for a device's emulator scope — the device
 * analogue of launch-plan.ts's buildLaunchPlan(), much simpler since there's
 * no shell/hook-adapter/env-injection complexity to compose: just
 * `emulator -avd <avdName> <extraArgs...>` under a scope whose Description
 * carries this module's own ownership marker (see the header comment). */
export function buildDeviceLaunchPlan(opts: {
  id: string;
  sessionsDir: string;
  emulatorPath: string;
  avdName: string;
  extraArgs?: string[];
}): DeviceLaunchPlan {
  const instanceId = deriveInstanceId(opts.sessionsDir);
  const unitName = deviceScopeUnitName(instanceId, opts.id);
  const marker = deviceMarkerPath(opts.sessionsDir, opts.id);
  return {
    unitName,
    argv: [
      "--user",
      "--scope",
      "--collect",
      "-u",
      unitName,
      "--description",
      `mullion-device -m ${marker}`,
      "--",
      opts.emulatorPath,
      "-avd",
      opts.avdName,
      ...(opts.extraArgs ?? []),
    ],
  };
}
