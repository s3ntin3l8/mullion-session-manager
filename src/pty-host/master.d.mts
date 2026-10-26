// Types for master.mjs, which stays plain ESM (copied into dist/ verbatim
// and run as a standalone program by pty-host.mjs).
export const SERVE_READY_TIMEOUT_MS: number;
export function isServing(endpoint: string): Promise<boolean>;
export function createSession(
  endpoint: string,
  program: string,
  args: string[],
  opts: { entry: string; log?: (line: string) => void; readyTimeoutMs?: number },
): Promise<number>;
export function serve(
  endpoint: string,
  program: string,
  args: string[],
  opts: { onExit: (code: number) => void; log?: (line: string) => void },
): { stop: () => void };
export const MAX_CLIENT_BACKLOG_BYTES: number;
