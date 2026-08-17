// Centralized `localStorage` key registry + typed read/write helpers for
// this app's client-only UI preferences — sidebar width, collapse flags,
// last-picked view, etc. Distinct from AppSettings (server-persisted via
// api.ts/store.ts's hydrateSettings): everything read/written through this
// module is a per-browser preference with no backend field at all.
//
// Consolidates what were previously ~36 direct `localStorage.*` call sites
// and 8 bespoke reader functions spread across 6 files, each with its own
// (sometimes absent) error handling. `STORAGE_KEYS` below is the ONLY place
// a "crs.*" key string is written literally in application code — every
// call site imports the constant instead. Every helper's `key` parameter is
// typed as `StorageKey` (not a bare `string`), so a typo'd/unregistered key
// is a compile error at the call site, not a silent read/write-to-nowhere
// nobody notices.
//
// Deliberately NOT one serialization scheme: store.ts and (pre-existing)
// Sidebar.tsx already used different encodings for their own persisted
// values (plain equality strings vs JSON), so this ships small
// general-purpose primitives (`readJSON`/`readNumber`/`readBool`/
// `readString` + their `write*` counterparts) rather than forcing every
// call site through one shape. Each mirrors the validation/fallback
// behavior its pre-extraction call sites already had — see the individual
// helpers below for the specific edge cases preserved.

// Keys as they exist in browsers TODAY. Do not change any value here —
// that would silently reset every user's persisted UI state on next load.
export const STORAGE_KEYS = {
  lastLaunchProjectId: "crs.lastLaunchProjectId",
  activeWorkspaceId: "crs.activeWorkspaceId",
  sidebarCollapsed: "crs.sidebarCollapsed",
  sidebarWidth: "crs.sidebarWidth",
  themeHint: "crs.themeHint",
  dismissedUpdateVersion: "crs.dismissedUpdateVersion",
  dismissedCodexHookTrustVersion: "crs.dismissedCodexHookTrustVersion",
  viewMode: "crs.viewMode",
  hierarchicalView: "crs.hierarchicalView",
  dockCollapsed: "crs.dockCollapsed",
  dockHeight: "crs.dockHeight",
  dockManualProjects: "crs.dockManualProjects",
  projectCollapsed: "crs.projectCollapsed",
  expandedSessionRows: "crs.expandedSessionRows",
  expandedSubagentRows: "crs.expandedSubagentRows",
  sourceControlCollapsed: "crs.sourceControlCollapsed",
  taskDrawerWidth: "crs.taskDrawerWidth",
  taskProjectFilter: "crs.taskProjectFilter",
  taskBlockedOnlyFilter: "crs.taskBlockedOnlyFilter",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

// `localStorage` can throw on get/set/remove (private browsing + Safari
// ITP, storage quota exceeded, disabled by policy, ...) — every helper
// below treats that the same as "value absent" / "write silently dropped"
// rather than letting it propagate and crash a render or a module-load-time
// `useState` initializer. Most pre-extraction call sites didn't guard
// against this at all (only the JSON.parse step was try/caught); wrapping
// storage access itself here is a strict improvement, not a behavior
// change any test depends on.
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Best-effort — a failed write just means this preference doesn't
    // survive reload; nothing else in the app depends on it succeeding.
  }
}

export function removeItem(key: StorageKey): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same best-effort posture as writeRaw above.
  }
}

// Plain string round-trip. `fallback` is generic so callers needing
// `string | null` (e.g. a dismissed-version marker with no default value)
// and callers needing a definite string default (e.g. an enum-like
// preference) both get the right return type without a cast.
export function readString<T extends string | null>(key: StorageKey, fallback: T): string | T {
  const raw = readRaw(key);
  return raw === null ? fallback : raw;
}

export function writeString(key: StorageKey, value: string): void {
  writeRaw(key, value);
}

// Treats a missing OR empty-string value as absent (mirrors the
// pre-extraction `raw ? Number(raw) : NaN` readers), and any parse that
// isn't finite as invalid — both collapse to `fallback`.
export function readNumber(key: StorageKey, fallback: number): number {
  const raw = readRaw(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function writeNumber(key: StorageKey, value: number): void {
  writeRaw(key, String(value));
}

// The two boolean encodings already in use before this extraction differ in
// which value is the "explicit" one: most keys are opt-IN ("1" means true,
// anything else — including absence — means false), but
// sourceControlCollapsed is opt-OUT ("0" means false, anything else —
// including absence — means true, since that section collapses by
// default). `fallback` selects which comparison applies, since it's always
// exactly the value "absence" should resolve to: `fallback: false` reads
// as `raw === "1"`, `fallback: true` reads as `raw !== "0"`.
export function readBool(key: StorageKey, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  return fallback ? raw !== "0" : raw === "1";
}

export function writeBool(key: StorageKey, value: boolean): void {
  writeRaw(key, value ? "1" : "0");
}

// JSON round-trip. Missing key OR malformed JSON both collapse to
// `fallback` — callers that need to validate the parsed *shape* (e.g. "is
// this an array of numbers") still do that themselves afterward, same as
// before this extraction; this only absorbs the "is there valid JSON here
// at all" step every one of those readers hand-rolled independently.
export function readJSON<T>(key: StorageKey, fallback: T): T {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: StorageKey, value: unknown): void {
  writeRaw(key, JSON.stringify(value));
}
