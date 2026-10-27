// Types for pipe-acl.mjs, which stays plain ESM (src/cli is copied into
// dist/ verbatim, see package.json's "build"), so the TypeScript backend and
// the plain-ESM pty-host master share the one implementation.
import type { execFile } from "node:child_process";

export const PIPE_ACL_TIMEOUT_MS: number;
export const PIPE_NAME_ENV: string;
export const PIPE_ACL_SCRIPT: string;
export function pipeAclEnv(pipeName: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function restrictPipeToCurrentUser(
  endpoint: string,
  opts?: {
    log?: (message: string) => void;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    execFile?: typeof execFile;
  },
): Promise<boolean>;
