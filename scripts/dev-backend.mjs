#!/usr/bin/env node
// `npm run dev:backend`: `tsx watch src/server.ts`, minus the Mullion variables
// a hosting session injects into its own children.
//
// Why: a Mullion session (a terminal, or a dock control such as "Dev server")
// gets MULLION_SOCKET_PATH, MULLION_HOOK_SOCKET/TOKEN, MULLION_SESSION_ID and
// the forwarder paths so the `mullion` CLI and the agent hooks can reach the
// Mullion that hosts it. src/services/session-env.ts injects them on purpose,
// after it has scrubbed everything else. A dev backend started from inside such
// a session would read MULLION_SOCKET_PATH as its OWN socket setting and try to
// bind the hosting Mullion's live control socket (SocketAlreadyListeningError),
// and would hand the hosting session's token and id to its own sessions. The
// rest of the server environment is already scrubbed (issue #70), so these are
// the only ones left to remove.
//
// A plain-JS list because scripts can't import the TypeScript source; every key
// here must also be in src/services/session-env.ts's SERVER_ENV_KEYS, and
// test/scripts/dev-backend.test.ts fails if the list and
// test/helpers/session-runtime-env.ts's (plus MULLION_SOCKET_PATH) differ in
// either direction (precedent: scripts/git-env.mjs).
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SESSION_INJECTED_ENV_KEYS = [
  "MULLION_SOCKET_PATH",
  "MULLION_HOOK_SOCKET",
  "MULLION_HOOK_TOKEN",
  "MULLION_SESSION_ID",
  "MULLION_CONTROL_UNAVAILABLE",
  "MULLION_FORWARDER_PATH",
  "MULLION_FORWARDER_NODE",
  "MULLION_WORKTREES_IN_DOT_WT",
  "MULLION_OPENCODE_INSTRUCTIONS",
  "OPENCODE_CONFIG_CONTENT",
];

/** `base` without the variables a hosting Mullion session injected. */
export function devBackendEnv(base = process.env) {
  const env = { ...base };
  for (const key of SESSION_INJECTED_ENV_KEYS) delete env[key];
  return env;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The shell's exit code for a process that died on `signal` (130 for SIGINT). */
const signalExitCode = (signal) => 128 + (os.constants.signals[signal] ?? 1);

/**
 * Runs `tsx watch src/server.ts` with the session-injected variables removed and
 * ties this process's lifetime to it. `spawnFn`/`proc`/`env`/`root` exist so a
 * test can drive it with fakes.
 */
export function startDevBackend({
  spawnFn = spawn,
  proc = process,
  env = process.env,
  root = ROOT,
} = {}) {
  // tsx's own entry point, run with this node: no `.cmd` shim, so the same
  // command works on Windows.
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawnFn(proc.execPath, [tsx, "watch", "src/server.ts"], {
    cwd: root,
    env: devBackendEnv(env),
    stdio: "inherit",
  });
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    proc.on(sig, () => {
      // A second signal means the child did not stop: do not wait for it.
      if (stopping) {
        child.kill("SIGKILL");
        proc.exit(signalExitCode(sig));
        return;
      }
      stopping = true;
      child.kill(sig);
    });
  }
  child.on("exit", (code, signal) => proc.exit(code ?? (signal ? signalExitCode(signal) : 0)));
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startDevBackend();
