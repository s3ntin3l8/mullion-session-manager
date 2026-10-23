// Types for sun-path.mjs, which stays plain ESM (src/cli is copied into
// dist/ verbatim, see package.json's "build"). Declared here so the
// TypeScript side — src/plugins/pty.ts — and the plain-ESM side —
// scripts/demo/env.mjs — can share the one rule instead of each keeping a
// copy of the platform table.
export const SUN_PATH_BYTES_BY_PLATFORM: ReadonlyMap<NodeJS.Platform, number>;
export const DEFAULT_SUN_PATH_BYTES: number;
export function maxSunPathBytes(platform?: NodeJS.Platform): number;
export const SESSIONS_DIR_SOCKET_NAMES: readonly string[];
export function longestSocketPath(dir: string): number;
export function fitsSunPath(dir: string, platform?: NodeJS.Platform): boolean;
