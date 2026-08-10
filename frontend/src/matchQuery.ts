// Split out of CommandPalette.tsx (U2, issue #581) so this PR's sidebar
// filter (U3) can reuse the exact same matching semantics rather than
// growing a second, subtly-different substring matcher — same "split into
// its own module for reuse" reasoning kanban.ts's own header comment
// documents for reorder.ts. A plain case-insensitive substring test, not a
// scored fuzzy match: this codebase has no fuzzy-matching helper (grepped
// for "fuzzy"/"score" across frontend/src before CommandPalette.tsx's own
// version was written — there wasn't one), so inventing a real fuzzy matcher
// here would be scope creep for a filter box. Returns true on the first
// field that contains `query`; a null/undefined field (a session with no
// liveBranch yet, a project that failed to resolve) is skipped rather than
// coerced to "".
export function matchesQuery(fields: (string | null | undefined)[], query: string): boolean {
  const q = query.toLowerCase();
  return fields.some((field) => field != null && field.toLowerCase().includes(q));
}
