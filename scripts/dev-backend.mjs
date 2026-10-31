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
// test/scripts/dev-backend.test.ts fails if one is not (precedent:
// scripts/git-env.mjs).
import { spawn } from "node:child_process";
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
  "MULLION_OPENCODE_INSTRUCTIONS",
];

/** `base` without the variables a hosting Mullion session injected. */
export function devBackendEnv(base = process.env) {
  const env = { ...base };
  for (const key of SESSION_INJECTED_ENV_KEYS) delete env[key];
  return env;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // tsx's own entry point, run with this node: no `.cmd` shim, so the same
  // command works on Windows.
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, "watch", "src/server.ts"], {
    cwd: root,
    env: devBackendEnv(),
    stdio: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
