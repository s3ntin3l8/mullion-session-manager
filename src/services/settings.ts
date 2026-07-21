import { eq } from "drizzle-orm";
import { settings as settingsTable } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// Shared shape + defaults for the server-persisted Settings blob (the
// Settings modal's "Everything wired now" rework). One JSON blob, same
// "backend stores/replays an opaque value" philosophy as
// `workspaces.layout` / `sessions.command` — this service is the only place
// that actually understands its structure; src/routes/settings.ts,
// src/routes/projects.ts, src/routes/sessions.ts, and src/plugins/pty.ts all
// read it through `getStoredSettings` below rather than each re-implementing
// "read the singleton row and merge over defaults."
//
// Deliberately a single flat-ish object rather than one DB column per pref:
// new settings get added here (and to DEFAULT_SETTINGS) without a schema
// migration, and `mergeSettings` deep-merges a stored (possibly older,
// missing-keys) blob over these defaults so a fresh key introduced by a
// later release always resolves instead of coming back `undefined`.

export type Theme = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";
export type SidebarDensity = "comfortable" | "compact";
export type SoundName = "ping" | "chime" | "blip";

export interface AppSettings {
  theme: Theme;
  terminal: {
    fontFamily: string;
    fontSize: number;
    // Inner inset (px) between the dockview panel edge and the rendered
    // terminal content, applied on all four sides — see frontend/src/api.ts's
    // matching field for the full rationale (issue #91).
    padding: number;
    colorScheme: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    pasteOnRightClick: boolean;
    reconnect: {
      enabled: boolean;
      maxAttempts: number;
    };
    keyCapture: {
      ctrlR: boolean;
      ctrlL: boolean;
      ctrlK: boolean;
    };
  };
  sidebarDensity: SidebarDensity;
  // Editable project-scan roots (Settings -> Projects & discovery). Empty
  // array = "use the PROJECTS_ROOTS env var" (see routes/projects.ts) —
  // this lets a fresh deploy keep working from its env config until someone
  // actually edits roots from the UI, at which point the DB value wins.
  projectRoots: string[];
  launchers: {
    defaultShell: string;
    defaultAgent: string;
    hiddenAgents: string[];
  };
  notifications: {
    attentionAlerts: boolean;
    channels: {
      browser: boolean;
      sound: boolean;
    };
    soundName: SoundName;
    idleThresholdSeconds: number;
    exitedAlerts: boolean;
  };
  sessions: {
    // Tokens: {agent} {project} {n} — expanded client-side at launch time
    // (see frontend/src/CommandPalette.tsx).
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    reconcileIntervalSeconds: number;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: {
    fontFamily: "Geist Mono",
    fontSize: 14,
    padding: 4,
    colorScheme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    // Raised from 1000 (issue #83) — at typical line widths 1000 lines was
    // already roughly as tight a limit as the old 256KiB server-side ring
    // buffer, so the two were both starving real scrollback history. Keep
    // this roughly proportionate to SCROLLBACK_MAX_BYTES in pty-manager.ts
    // if either changes.
    scrollback: 5000,
    copyOnSelect: true,
    pasteOnRightClick: false,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
    },
    keyCapture: {
      ctrlR: true,
      ctrlL: true,
      ctrlK: false,
    },
  },
  sidebarDensity: "comfortable",
  projectRoots: [],
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
    hiddenAgents: [],
  },
  notifications: {
    attentionAlerts: false,
    channels: {
      browser: true,
      sound: false,
    },
    soundName: "ping",
    idleThresholdSeconds: 30,
    exitedAlerts: false,
  },
  sessions: {
    namePattern: "{agent} · {project}",
    confirmBeforeKill: true,
    hideEndedSessions: false,
    reconcileIntervalSeconds: 30,
  },
};

// Plain-object-aware deep merge: `patch` values win, arrays and any
// non-plain-object value (including null) replace outright rather than
// merging element-wise — a `projectRoots: []` patch should empty the list,
// not no-op against defaults.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A patch leaf only ever replaces a base leaf of the same JS type — a
// `{"terminal":{"fontSize":"huge"}}` or `{"terminal":5}` patch must not
// persist and silently corrupt a field/subtree forever (getStoredSettings
// re-merges the stored blob over DEFAULT_SETTINGS with this same function on
// every read, so a wrong-shape value, once written, never self-heals).
// Reached only when at least one side isn't a plain object (deepMerge
// recurses instead when both are), so an object-vs-anything-else mismatch is
// always rejected here.
function sameType(base: unknown, value: unknown): boolean {
  if (isPlainObject(base) || isPlainObject(value)) return false;
  if (Array.isArray(base)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  if (base === null || value === null) return false;
  return typeof base === typeof value;
}

// Iterates `base`'s own keys rather than the patch's: the property name
// written to `result` must never be sourced from request.body (an
// attacker-controlled PATCH /api/settings payload), since JSON.parse
// happily builds "__proto__" as an ordinary own-enumerable key and a
// naive `for (const key of Object.keys(patch))` would let that key reach
// a bracket-notation write — a prototype-pollution vector. Keys present in
// the patch but absent from `base` (i.e. not part of the known settings
// shape) are silently dropped rather than merged in.
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const baseObj = base as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObj };
  for (const key of Object.keys(baseObj)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const baseValue = baseObj[key];
    const value = patch[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value)
        : sameType(baseValue, value)
          ? value
          : baseValue;
  }
  return result as T;
}

function safeNumber(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

// Clamps/repairs numeric fields to a sane range, falling back to the
// default on anything non-finite or out of bounds. The type guard in
// deepMerge above only proves a patched leaf is *a* number, not a *sane*
// one — a 0 or negative `reconcileIntervalSeconds` feeds straight into
// `setInterval` (see plugins/pty.ts's armReconcileTimer). Ranges mirror the
// min/max the Settings UI's own sliders/number fields already enforce
// client-side (Settings.tsx), so the server never rejects a value the UI
// allows.
export function sanitizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    terminal: {
      ...settings.terminal,
      fontSize: safeNumber(settings.terminal.fontSize, {
        min: 10,
        max: 20,
        fallback: DEFAULT_SETTINGS.terminal.fontSize,
      }),
      padding: safeNumber(settings.terminal.padding, {
        min: 0,
        max: 16,
        fallback: DEFAULT_SETTINGS.terminal.padding,
      }),
      scrollback: safeNumber(settings.terminal.scrollback, {
        min: 100,
        max: 100000,
        fallback: DEFAULT_SETTINGS.terminal.scrollback,
      }),
      reconnect: {
        ...settings.terminal.reconnect,
        maxAttempts: safeNumber(settings.terminal.reconnect.maxAttempts, {
          min: 1,
          max: 20,
          fallback: DEFAULT_SETTINGS.terminal.reconnect.maxAttempts,
        }),
      },
    },
    notifications: {
      ...settings.notifications,
      idleThresholdSeconds: safeNumber(settings.notifications.idleThresholdSeconds, {
        min: 5,
        max: 120,
        fallback: DEFAULT_SETTINGS.notifications.idleThresholdSeconds,
      }),
    },
    sessions: {
      ...settings.sessions,
      reconcileIntervalSeconds: safeNumber(settings.sessions.reconcileIntervalSeconds, {
        min: 5,
        max: 3600,
        fallback: DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
      }),
    },
  };
}

/** Deep-merges a possibly-partial/older stored blob over the current defaults. */
export function mergeSettings(stored: unknown): AppSettings {
  return sanitizeSettings(deepMerge(DEFAULT_SETTINGS, stored));
}

// Singleton row id — see db/schema.ts's `settings` table doc comment.
export const SETTINGS_ROW_ID = 1;

// Shared "read the settings row and merge over defaults" used by every
// consumer (the settings route itself, project-roots resolution, the
// reconcile-interval boot read, and per-request idle-threshold lookups).
export function getStoredSettings(db: ReturnType<typeof getDb>): AppSettings {
  const [row] = db.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ROW_ID)).all();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(JSON.parse(row.data));
  } catch {
    return DEFAULT_SETTINGS;
  }
}
