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

// `defaultValue` is that field's value in the STATIC DEFAULT_SETTINGS tree
// (threaded through deepMerge's recursion below, distinct from `base` which
// is the current, possibly-already-patched value at that key) — the only
// reliable signal for "is this field declared nullable," since `base` drifts
// away from null the moment the field is first set.
//
// Regression: `opencode.implementerModel`/`reviewerModel`/`defaultSmallModel`
// (issue #957/#958) are this schema's first fields whose default is `null`.
// Before this nullability check existed, such a field could never transition
// null -> a value (`sameType(null, "x")` was always false) NOR back from a
// value -> null (`sameType("x", null)` was also always false) — Settings ->
// Models could show a selection in the dropdown but it silently never
// persisted (caught by Settings.models.test.tsx). Every other existing
// field's default is non-null, so this branch is unreached for them and
// their behavior is unchanged. Mirrors src/services/settings.ts's identical
// backend copy — keep both in sync.
//
// Restricted to `string` (not "any scalar") deliberately: `defaultValue`
// only proves the field is NULLABLE, not what its non-null type is — there's
// no runtime signal for that beyond the default itself. Every field that
// takes this branch today (all three opencode.* fields) is `string | null`,
// so this is exact, not a guess. A code-review pass on the first version of
// this fix caught that accepting number/boolean too would let a
// wrong-typed patch (e.g. `{opencode:{implementerModel: 42}}`) silently
// corrupt local state. If a genuinely nullable number/boolean field is ever
// added to this schema, this check needs revisiting.
function sameType(base: unknown, value: unknown, defaultValue: unknown): boolean {
  if (isPlainObject(base) || isPlainObject(value)) return false;
  if (Array.isArray(base)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  if (defaultValue === null) {
    return value === null || typeof value === "string";
  }
  if (base === null || value === null) return false;
  return typeof base === typeof value;
}

// `defaults` defaults to `base` itself when omitted, matching the backend
// copy's convention — a caller merging a patch onto a value that has
// drifted from DEFAULT_SETTINGS (store.ts's updateSettings, merging onto the
// live `settings` state) must pass DEFAULT_SETTINGS explicitly instead.
export function deepMerge<T>(base: T, patch: unknown, defaults: T = base): T {
  if (!isPlainObject(patch)) return base;
  const baseObj = base as Record<string, unknown>;
  const defaultsObj = defaults as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObj };
  for (const key of Object.keys(baseObj)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const baseValue = baseObj[key];
    const value = patch[key];
    const defaultValue = defaultsObj[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value, isPlainObject(defaultValue) ? defaultValue : baseValue)
        : sameType(baseValue, value, defaultValue)
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
