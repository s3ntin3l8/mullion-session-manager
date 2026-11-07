import fs from "node:fs";
import path from "node:path";
import type { BrowserTarget } from "./browser-manager.js";

// Issue #2639 — the browser target the primary resolved for a session running
// on THIS agent host. An agent has no database to resolve one with, so the
// primary sends it with the spawn.
//
// Issue #2672 — the target is also written under the agent's data dir
// (SESSIONS_DIR, like the machine identity): a session outlives an agent
// restart or redeploy (dtach keeps it alive) and is not respawned by the
// primary, so an in-memory-only map would leave it with "no browser target"
// until it was restarted. Unlike the GitHub credential (a secret, memory only)
// a target is plain placement data. The dir is optional: callers without one
// (tests, a process with no SESSIONS_DIR) keep the old memory-only behaviour.
const STATE_FILE_NAME = "browser-targets.json";
/** An entry whose session this agent no longer knows is dropped after this
 * long. Not at once: right after a restart the sessions are not re-registered
 * with the PTY manager yet, and their targets must survive that window. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

interface Entry {
  target: BrowserTarget;
  savedAt: number;
}

const targets = new Map<string, Entry>();
const hydrated = new Set<string>();

function statePath(sessionsDir: string): string {
  return path.join(path.resolve(sessionsDir), STATE_FILE_NAME);
}

function isTarget(value: unknown): value is BrowserTarget {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    Number.isInteger(t.projectId) &&
    typeof t.hostId === "string" &&
    t.hostId.length > 0 &&
    typeof t.checkoutRoot === "string" &&
    t.checkoutRoot.length > 0 &&
    typeof t.legacy === "boolean" &&
    (t.endpoint === undefined || typeof t.endpoint === "string")
  );
}

/** Loads the persisted targets once per directory. A missing or corrupt file
 * is treated as empty: the session simply has no target, as before. */
function hydrate(sessionsDir: string): void {
  const file = statePath(sessionsDir);
  if (hydrated.has(file)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // Marked only once read: a file that did not exist yet is looked for again.
    hydrated.add(file);
    for (const [id, raw] of Object.entries(parsed)) {
      const entry = raw as { target?: unknown; savedAt?: unknown };
      // Memory wins: a target remembered since boot is newer than the file.
      if (targets.has(id) || !isTarget(entry?.target)) continue;
      const savedAt = typeof entry.savedAt === "number" ? entry.savedAt : Date.now();
      targets.set(id, { target: entry.target, savedAt });
    }
  } catch {
    // absent or unreadable: nothing to restore
  }
}

function persist(sessionsDir: string): void {
  const file = statePath(sessionsDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(targets)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort: the session still has its in-memory target; it only loses
    // it across a restart.
    fs.rmSync(tmp, { force: true });
  }
}

/** Records (or, for a spawn that carries none, clears) the target of session
 * `id`, and drops entries of sessions that no longer exist so the map cannot
 * grow for the lifetime of the agent. */
export function rememberSessionBrowserTarget(
  pty: { get(id: string): unknown },
  id: string,
  target: BrowserTarget | undefined,
  sessionsDir?: string,
): void {
  if (sessionsDir) hydrate(sessionsDir);
  const now = Date.now();
  for (const [known, entry] of targets) {
    if (known === id || pty.get(known) !== undefined) continue;
    if (!sessionsDir || now - entry.savedAt > STALE_AFTER_MS || targets.size > MAX_ENTRIES) {
      targets.delete(known);
    }
  }
  if (target) targets.set(id, { target, savedAt: now });
  else targets.delete(id);
  if (sessionsDir) persist(sessionsDir);
}

/** The target the primary sent for session `id` (this boot or an earlier one),
 * or null when it sent none. */
export function sessionBrowserTarget(id: string, sessionsDir?: string): BrowserTarget | null {
  if (sessionsDir) hydrate(sessionsDir);
  return targets.get(id)?.target ?? null;
}

/** Forgets session `id` once it is terminated for good. */
export function forgetSessionBrowserTarget(id: string, sessionsDir?: string): void {
  if (sessionsDir) hydrate(sessionsDir);
  if (targets.delete(id) && sessionsDir) persist(sessionsDir);
}
