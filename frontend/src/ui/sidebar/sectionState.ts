import { STORAGE_KEYS, readJSON } from "../../lib/persistedState.js";

type Persisted = Record<string, boolean>;

// readJSON casts without validating, so a stored `null`/array/string must not
// reach the `[key]` lookup.
export function readAllSections(): Persisted {
  const all = readJSON<unknown>(STORAGE_KEYS.sidebarKitSections, {});
  return all && typeof all === "object" && !Array.isArray(all) ? (all as Persisted) : {};
}

export function readPersistedSection(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  const stored = readAllSections()[key];
  return typeof stored === "boolean" ? stored : fallback;
}
