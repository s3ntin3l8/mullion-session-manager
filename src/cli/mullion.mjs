#!/usr/bin/env node
// Phase 4 (#134, PR6) — `mullion`, the CLI onto the control socket
// (docs/socket-api.md). Deliberately plain JavaScript and spawned directly,
// not imported: same dev/prod-parity reasoning as src/hooks/forwarder.mjs
// and src/mcp/server.mjs (`make build` copies src/cli/ into dist/cli/
// byte-for-byte — package.json — so this file must run identically under
// `tsx` in dev and compiled in prod, with no tsc step of its own to go
// stale). Deliberately thin: every command's real logic lives in
// core.mjs/client.mjs, which are imported (not spawned) specifically so
// they DO count toward the coverage floor — v8 cannot instrument a spawned
// child process, so this file is integration-tested only (spawning it for
// real, see test/cli/mullion.test.ts), never unit-tested directly.
//
// The one thing that only makes sense here, not in core.mjs: the real
// process/TTY wiring (`io`) `session exec`/`events tail` need — raw stdin
// mode, SIGWINCH, process.exit — core.mjs's own functions take this as an
// injected `io` object precisely so they can be exercised with fakes in
// unit tests instead.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { MullionSocketClient } from "./client.mjs";
import { runCommand, parseGlobalFlags, resolveCommand } from "./core.mjs";

function buildIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    getSize: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onResize: (cb) => {
      process.on("SIGWINCH", cb);
      return () => process.removeListener("SIGWINCH", cb);
    },
    onInterrupt: (cb) => {
      process.once("SIGINT", cb);
      process.once("SIGTERM", cb);
    },
    // No-op off a real TTY (e.g. piped stdin in a script) — matches
    // core.mjs's own `io.setRawMode?.()` optional-call convention.
    setRawMode: process.stdin.isTTY
      ? (enabled) => {
          process.stdin.setRawMode(enabled);
          if (enabled) process.stdin.resume();
          else process.stdin.pause();
        }
      : undefined,
  };
}

/** `mullion mcp` execs dist/mcp/server.mjs (src/mcp/server.mjs in dev) as a
 * separate process inheriting this one's stdio — it speaks its own stdio
 * JSON-RPC protocol (src/mcp/server.mjs), not the control socket, so there
 * is no MullionSocketClient involved at all here. */
async function runMcp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(here, "..", "mcp", "server.mjs");
  const child = spawn(process.execPath, [serverPath], { stdio: "inherit" });
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
    child.on("error", () => resolve(1));
  });
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const { rest, socket } = parseGlobalFlags(argv);
  const resolved = resolveCommand(rest);
  if (!resolved.error && resolved.noun === "mcp") {
    await runMcp();
    return;
  }

  const client = new MullionSocketClient({ socketPath: socket });
  const code = await runCommand(argv, { client, io: buildIo() });
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
