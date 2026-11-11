import type { PlacementCapability, PlacementPlatform } from "../../src/shared/constants.js";

export const PLATFORM_LABELS: Record<PlacementPlatform, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

export const CAPABILITY_LABELS: Record<PlacementCapability, string> = {
  xcode: "Needs Xcode (iOS Simulator)",
  "android-emulator": "Needs an Android emulator",
};

/** Whether two project-id selections hold the same ids (order and null/empty aside). */
export function sameIds(a: number[], b: number[] | null | undefined): boolean {
  const other = b ?? [];
  return a.length === other.length && a.every((id) => other.includes(id));
}

/** The non-empty, trimmed entries of an editable per-host path map. */
export function normalizeHostPaths(paths: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [hostKey, value] of Object.entries(paths)) {
    const trimmed = value.trim();
    if (trimmed !== "") out[hostKey] = trimmed;
  }
  return out;
}

export function sameHostPaths(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

// Issue #2901 — the Display name becomes the last segment of the path the
// modal fills in: the trimmed name with every whitespace run collapsed into a
// single dash, and the path separators dropped so a name can never escape the
// base folder it is appended to ("my project" → "my-project", "a/b" → "ab").
// An empty result (a blank name, or one made only of separators) means "no
// segment" — the path falls back to the base folder alone.
export function slugifyProjectName(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").replace(/[/\\]/g, "");
}

export const trailingSegment = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "my-project";
