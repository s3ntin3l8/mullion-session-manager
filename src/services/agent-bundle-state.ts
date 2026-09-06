// Issue #1089 — agent-local persisted "bundle disabled" state. An agent
// host has no settings DB of its own (`app.db` is absent there — see
// app.ts's own comment on the `MULLION_ROLE === "agent"` branch), so
// `sessions.injectMullionBundle` — which lives in the PRIMARY's settings
// table — can never be read from an agent process. Before this module
// existed, every DB-less reader of "is bundle sync enabled"
// (plugins/bundle-sync.ts's own `readInjectMullionBundle`) fell back to
// `DEFAULT_SETTINGS.sessions.injectMullionBundle`, which is unconditionally
// `true` — so removing bundle content on an agent host (routes/
// bundle-sync.ts's `/remove` fan-out, below) would never actually stick:
// the agent's own next boot-time sync (bundleSyncPlugin's `onReady`) would
// silently reinstall everything the very next restart, with no way for
// this host to remember it had been asked to stay uninstalled.
//
// This module is that memory: a single boolean, persisted to a small JSON
// file under this host's own `~/.mullion/` directory — same fixed,
// per-user, deliberately-NOT-under-`$MULLION_HOME` location as
// bundle-sync.ts's own `resolveBundleSyncManifestPath` (see that function's
// own doc comment for why: dev never sets MULLION_HOME, so dev and prod
// must resolve to the identical path, and an interactive shell's XDG vars
// routinely differ from the `systemd --user` unit's). A DIFFERENT filename
// from that module's own `bundle-sync.json` — this is a completely
// independent concern (a user's on/off preference, not sync's own
// installed-content manifest) and this module deliberately never reads or
// writes that file, nor is it read/written by bundle-sync.ts itself (that
// file is owned by a separate, concurrently-running PR this cycle — see
// issue #1090).
//
// Mirrors host-files.ts's shape exactly: plain local read/write functions,
// plus a `(app, hostId)` -> dispatch pair (getHostBundleDisabled/
// removeHostBundle) that goes straight to the local functions for
// LOCAL_HOST_ID and over the wire (RemoteHostClient) otherwise. See that
// file's own header comment for why this dispatch shape lives next to the
// plain local functions rather than in a separate file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { uninstallBundleContent } from "./bundle-sync.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { viaRemote, type HostGitResult } from "./host-git.js";

interface AgentBundleStateFile {
  version: 1;
  disabled: boolean;
}

const STATE_VERSION = 1 as const;

/** Fixed, per-user path — see this file's own header comment for why it's
 * neither `$MULLION_HOME`-relative nor XDG-aware. */
export function resolveAgentBundleStatePath(): string {
  return path.join(os.homedir(), ".mullion", "agent-bundle-state.json");
}

/** Reads this host's own persisted "bundle disabled" flag. Defaults to
 * `false` (bundle ENABLED — bundle-sync's own long-standing default) when
 * the file is absent, unreadable, or doesn't parse as this module's own
 * shape: a missing/corrupt state file must never be misread as "disabled",
 * which would silently stop bundle sync from ever reinstalling anything on
 * this host again with no user action to explain why. */
export function readAgentBundleDisabled(): boolean {
  let raw: string;
  try {
    raw = readFileSync(resolveAgentBundleStatePath(), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === STATE_VERSION &&
      typeof (parsed as { disabled?: unknown }).disabled === "boolean"
    ) {
      return (parsed as AgentBundleStateFile).disabled;
    }
    return false;
  } catch {
    return false;
  }
}

/** Persists this host's own "bundle disabled" flag — atomic tmp-then-rename
 * write, mirroring bundle-sync.ts's own `writeManifestAtomic` exactly (same
 * reasoning: a killed process must never leave a half-written, unparseable
 * state file behind for the next boot's read to choke on). */
export function writeAgentBundleDisabled(disabled: boolean): void {
  const target = resolveAgentBundleStatePath();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.tmp`;
  const state: AgentBundleStateFile = { version: STATE_VERSION, disabled };
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmpPath, target);
}

export interface AgentBundleRemovalResult {
  removed: number;
  legacySwept: number;
}

/**
 * `hostId`'s own current "bundle disabled" flag — `readAgentBundleDisabled`
 * directly for `LOCAL_HOST_ID`, `/internal/bundle-sync/status` (via
 * `RemoteHostClient.getAgentBundleState`) otherwise. See host-files.ts's
 * `readHostFiles`/`writeHostFiles` for the identical local/remote dispatch
 * shape this mirrors. Not currently called by any route in this repo (the
 * `LOCAL_HOST_ID` branch in particular has no real caller today: the
 * primary's own bundle-disabled state lives in its settings DB, not this
 * file) — kept symmetric with `removeHostBundle` below for parity and so a
 * future per-host status surface (e.g. Settings > Hosts) has this ready to
 * call.
 */
export async function getHostBundleDisabled(
  app: FastifyInstance,
  hostId: string,
): Promise<HostGitResult<boolean>> {
  if (hostId === LOCAL_HOST_ID) {
    return { ok: true, value: readAgentBundleDisabled() };
  }
  return viaRemote(app, hostId, async (client) => {
    const { disabled } = await client.getAgentBundleState();
    return disabled;
  });
}

/**
 * Disables (or re-enables) bundle sync on `hostId`'s own filesystem and,
 * when disabling, removes previously-installed bundle content — writes the
 * local flag first (so this host's own NEXT boot-time sync,
 * plugins/bundle-sync.ts, takes the removal branch instead of silently
 * reinstalling on its next restart) then runs the real removal,
 * `uninstallBundleContent` (bundle-sync.ts) directly for `LOCAL_HOST_ID`,
 * `/internal/bundle-sync/remove` (via `RemoteHostClient.removeAgentBundle`)
 * otherwise. Re-enabling (`disabled: false`) only clears the flag on the
 * targeted host — it deliberately does NOT trigger a resync here (that's a
 * separate, existing concern: `POST /api/bundle-sync/resync`,
 * primary-host-only). This repo's only current caller
 * (routes/bundle-sync.ts's `/remove` fan-out) always passes
 * `disabled: true`; nothing in this repo currently calls this function (or
 * the matching internal route) with `disabled: false` for a remote host —
 * turning `sessions.injectMullionBundle` back on today only re-syncs the
 * PRIMARY. An agent host's own flag, once set to `disabled: true`, has no
 * built-in way to clear again short of hand-editing/deleting
 * resolveAgentBundleStatePath() on that host, or a future "re-enable"
 * fan-out calling this with `disabled: false`. Tracked as a known gap, not
 * silently dropped — see this repo's issue tracker for #1089's follow-up.
 */
export async function removeHostBundle(
  app: FastifyInstance,
  hostId: string,
  disabled = true,
): Promise<HostGitResult<AgentBundleRemovalResult>> {
  if (hostId === LOCAL_HOST_ID) {
    writeAgentBundleDisabled(disabled);
    if (!disabled) return { ok: true, value: { removed: 0, legacySwept: 0 } };
    const result = await uninstallBundleContent();
    return { ok: true, value: result };
  }
  return viaRemote(app, hostId, (client) => client.removeAgentBundle(disabled));
}
