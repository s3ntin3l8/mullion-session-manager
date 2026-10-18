import type { Measured, ProbeMeta } from "../api/index.js";

/** True once a first measurement has landed, so the figures (not just the status) are present. */
export function hasMeasuredData<T>(value: Measured<T> | null): value is T & ProbeMeta {
  return value !== null && value.measuredAt !== null;
}
