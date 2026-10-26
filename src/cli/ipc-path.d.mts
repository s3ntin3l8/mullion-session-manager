// Types for ipc-path.mjs, which stays plain ESM (src/cli is copied into
// dist/ verbatim, see package.json's "build"). Declared here so the
// TypeScript backend and the plain-ESM CLI share the one mapping.
export const PIPE_PREFIX: string;
export function isPipePath(p: string): boolean;
export function ipcPath(fsPath: string, platform?: NodeJS.Platform): string;
