// Pure settings deep-merge helpers, split out of store.ts so they're
// importable (and unit-testable) without pulling in the Zustand store's
// module-level side effects (localStorage reads for theme/workspace hints
// happen as soon as store.ts is imported).

// Plain-object-aware deep merge mirroring src/services/settings.ts's
// hardened backend copy — arrays replace outright rather than merging
// element-wise (a `projectRoots: []` patch must empty the list, not no-op
// against the current value), and, like the backend, iterates `base`'s own
// keys rather than the patch's so a property name written to `result` is
// never sourced from the patch: `__proto__` (a real own-enumerable key once
// something JSON.parse's it, e.g. a GET /api/settings response) is never
// touched, and a type-mismatched patch leaf (a string where `base` has a
// number) is dropped instead of corrupting the field. Used wherever `base`
// is a full, canonical `AppSettings` — i.e. `get().settings` in store.ts.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameType(base: unknown, value: unknown): boolean {
  if (isPlainObject(base) || isPlainObject(value)) return false;
  if (Array.isArray(base)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  if (base === null || value === null) return false;
  return typeof base === typeof value;
}

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

const FORBIDDEN_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Merges two PARTIAL patches together — used only to accumulate rapid
// updateSettings() calls into one pending PATCH body before the debounced
// flush (see pendingPatch in store.ts). Unlike deepMerge above, there's no
// authoritative full-shape "base" to iterate here (both sides are
// arbitrary partial patches, and a later patch must be able to introduce a
// top-level key the earlier one didn't have), so this walks the incoming
// patch's own keys instead, guarding only against prototype-polluting key
// names.
export function mergePartialPatch<T>(base: T, patch: T): T {
  const baseObj = base as Record<string, unknown>;
  const patchObj = patch as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObj };
  for (const [key, value] of Object.entries(patchObj)) {
    if (FORBIDDEN_PATCH_KEYS.has(key)) continue;
    const baseValue = baseObj[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? mergePartialPatch(baseValue, value)
        : value;
  }
  return result as T;
}
