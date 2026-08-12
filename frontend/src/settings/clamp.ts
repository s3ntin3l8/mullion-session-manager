// Independent review, PR #480 — NumberField enforces min/max only as HTML
// attributes, not an actual clamp (`Number(e.target.value)` passes through
// unclamped). An out-of-range value here silently repairs to the -1
// "inherit" sentinel server-side (settings.ts's safeSentinelNumber) rather
// than a fixed default the way every other Settings number field's
// out-of-range value does — unpredictable from the UI, and this is the
// safety envelope (typing "25" into "Max concurrent claims" would silently
// leave the real cap at whatever this install's env default is, while the
// input shows 25).
//
// Two-sided clamp — safe for any 0-min field (budgetMinutes,
// progressCommentMinutes, and SessionsSection's own eventRetentionDays /
// eventRetentionPerSession below): clearing the field already produces
// `Number("") === 0`, which equals `min`, so there's nothing to snap and no
// interference with "clear it, then type a new number." Generic despite the
// name's TaskMaster origin — reused by SessionsSection's onCommit handlers
// too (Hermes review, PR #563 round 4, see that section's own comment).
export function clampNumberFieldOnCommit(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return value;
  return Math.min(max, Math.max(min, value));
}

// Upper-bound-only clamp — for maxConcurrent's live-typing draft (`min` is
// 1). Clamping the lower bound on every keystroke would snap a
// just-cleared field (`Number("") === 0`) straight up to 1, so the NEXT
// keystroke appends onto "1" instead of starting fresh — verified:
// clearing then typing "5" produced "15", not "5". Only used for the
// draft while typing; the field's onCommit clamps both bounds (see
// clampNumberFieldOnCommit above) since a one-shot blur/Enter commit has no
// further keystroke to corrupt.
export function clampTaskMasterFieldMax(value: number, max: number): number {
  return Number.isNaN(value) ? value : Math.min(max, value);
}
