#!/usr/bin/env node
// Shared shell-command-hook forwarder (issue #174) — invoked by every
// shell-command-hook agent's generated config (Claude Code today; Codex/agy
// reuse this same file in follow-up PRs, see the plan's Cross-cutting
// "Forwarder" section) as:
//
//   node <this file> <agent> <kind>
//
// with the hook's own JSON payload on stdin. Reads stdin, maps it (via
// forwarder-core.mjs's pure per-agent dialect) to a hook-protocol message,
// connects to $MULLION_HOOK_SOCKET, sends the handshake + message line, and
// exits. Deliberately plain JavaScript, not TypeScript: this file is spawned
// directly by an external agent's own hook runner, not imported by Mullion's
// server process, so it must run identically under `make dev` (tsx never
// touches it — there is no dist/ yet) and in production (`make build` copies
// src/hooks/ into dist/hooks/ byte-for-byte, no tsc step to go stale — see
// package.json's build script). A .ts version of this file would need a
// compiled twin kept in sync by hand for dev, which is exactly the
// dev/prod path mismatch this design avoids.
//
// PR4 registers ONLY non-blocking hooks (Notification/Stop/PostToolUse), so
// this shim is pure fire-and-forget: connect, write, exit — no reply is
// ever awaited. The blocking review-gate path (PreToolUse, waiting on a real
// human decision) is deliberately deferred to PR9 (issue #178), which is
// where this file gains a bounded blocking-read-then-stdout-decision branch
// alongside the endpoint that actually answers it — see PR4's description
// for why shipping a blocking hook now, with nothing to resolve it, would
// hang every real tool call instead.

import net from "node:net";
import { buildForwarderMessage, parseHookStdin } from "./forwarder-core.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    // A hook runner that never writes/closes stdin must never hang this
    // process forever — fail safe to "no payload" rather than wedge.
    process.stdin.on("error", () => resolve(data));
  });
}

async function main() {
  const agent = process.argv[2];
  const kind = process.argv[3];
  const socketPath = process.env.MULLION_HOOK_SOCKET;
  const token = process.env.MULLION_HOOK_TOKEN;

  // No socket configured (hooks disabled, or an agent invoked outside a
  // Mullion session entirely) — silently do nothing. Never block or error
  // the agent's own hook execution on Mullion's behalf.
  if (!socketPath || !token || !agent || !kind) {
    return;
  }

  const raw = await readStdin();
  const payload = parseHookStdin(raw);
  const message = buildForwarderMessage(agent, kind, payload);
  if (message === null) {
    return;
  }

  await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    // Never let a wedged/slow connect hang the hook past its own generous
    // but bounded timeout (see claude-code.ts's hookEntry `timeout: 10`) —
    // this is well under that, so the hook's own timeout is the true
    // backstop and this just avoids leaking a lingering process.
    const safety = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 5000);

    const finish = () => {
      clearTimeout(safety);
      resolve();
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
      socket.write(`${JSON.stringify(message)}\n`);
      socket.end();
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });
}

main().catch(() => {
  // Best-effort by design — a forwarder failure must never surface as a
  // hook failure to the agent, and must never throw past this handler.
});
