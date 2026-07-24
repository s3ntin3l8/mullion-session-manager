#!/usr/bin/env node
// Shared shell-command-hook forwarder (issue #174) — invoked by every
// shell-command-hook agent's generated config (Claude Code, Codex, and agy
// — see the plan's Cross-cutting "Forwarder" section) as:
//
//   node <this file> <agent> <kind>
//
// with the hook's own JSON payload on stdin. Reads stdin, maps it (via
// forwarder-core.mjs's pure per-agent dialect) to hook-protocol message(s),
// connects to $MULLION_HOOK_SOCKET, sends the handshake + one or more
// message lines, and exits. Deliberately plain JavaScript, not TypeScript:
// this file is spawned
// directly by an external agent's own hook runner, not imported by Mullion's
// server process, so it must run identically under `make dev` (tsx never
// touches it — there is no dist/ yet) and in production (`make build` copies
// src/hooks/ into dist/hooks/ byte-for-byte, no tsc step to go stale — see
// package.json's build script). A .ts version of this file would need a
// compiled twin kept in sync by hand for dev, which is exactly the
// dev/prod path mismatch this design avoids.
//
// Most hooks (Notification/Stop/PostToolUse) are pure fire-and-forget:
// connect, write, exit — no reply is ever awaited (see forward() below).
// The blocking review-gate path (PreToolUse, issue #178) is the one
// exception: when the mapped message is a `review_gate` in state "waiting",
// this instead keeps the connection open and blocks for a single reply line
// (runGate() below) — written back by hooks.ts once POST
// /api/sessions/:id/review-gate delivers a real decision, or by hooks.ts's
// own server-side timeout if nobody ever does — then prints the target
// agent's own decision JSON to stdout (formatGateDecision, see
// forwarder-core.mjs) instead of the unconditional `{}` main() otherwise
// prints. Every path through the gate branch — a real reply, a timeout, a
// dropped connection, or an unexpected internal error — resolves to SOME
// decision object, defaulting to "denied": a gate that silently fails open
// (printing `{}`, which Claude Code's PreToolUse contract doesn't recognize
// as any decision at all) would be a safety control that lies, which is a
// categorically worse failure mode than the fire-and-forget hooks above
// simply losing an event.

import net from "node:net";
import {
  buildForwarderMessage,
  formatGateDecision,
  formatSessionStartOutput,
  parseHookStdin,
} from "./forwarder-core.mjs";

// Bounded below claude-code.ts's own PreToolUse hook `timeout`
// (GATE_HOOK_TIMEOUT_SECONDS, 300s) so THIS process controls the fail-closed
// decision and prints valid JSON before the agent's own hook-level timeout
// fires and does something less predictable — mirrors hooks.ts's own
// GATE_TIMEOUT_MS (290s) for the same reason, on the other end of the same
// connection.
const GATE_TIMEOUT_MS = 280_000;

// Issue #271 — a SessionStart round trip has no human in the loop (hooks.ts
// answers it synchronously from an in-memory lookup — see its
// "session_start" handling), so this only needs to be generous enough for
// an ordinary local socket round trip, nowhere near GATE_TIMEOUT_MS's
// human-decision budget. Bounded below claude-code.ts's own SessionStart
// hook `timeout` (10s) for the same "this process controls the fail-safe
// default" reasoning as GATE_TIMEOUT_MS.
const SESSION_START_TIMEOUT_MS = 5_000;

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
  // forward() returns null for the ordinary fire-and-forget path, a
  // `{type: "gate", decision}` object once a gate has been resolved, or a
  // `{type: "sessionStart", additionalContext}` object once a SessionStart
  // round trip has answered (see forward()'s own comment) — main() is the
  // one place that decides what to print based on which of those happened,
  // so at most one of these ever reaches stdout.
  let result = null;
  try {
    result = await forward();
  } finally {
    if (result?.type === "gate") {
      console.log(
        JSON.stringify(
          formatGateDecision(process.argv[2], result.decision.decision, result.decision.reason),
        ),
      );
    } else if (result?.type === "sessionStart" && result.additionalContext.length > 0) {
      console.log(
        JSON.stringify(formatSessionStartOutput(process.argv[2], result.additionalContext)),
      );
    } else {
      // Some agents (agy — issue #253) run hooks SYNCHRONOUSLY, blocking
      // their own agent loop on this process's exit, and expect a JSON
      // decision object on stdout even for a purely observational hook (an
      // empty `{}` means "no decision" — never blocks/continues anything).
      // Printed unconditionally, on every non-gate/non-seeded exit path:
      // harmless for Claude Code/Codex, whose own hook contracts don't
      // require (or forbid) any stdout output.
      console.log("{}");
    }
  }
}

/** Returns `null` for the ordinary fire-and-forget path (main() prints
 * `{}`), or a `{decision, reason}` object once a gate has resolved (main()
 * prints that agent's own decision JSON instead) — see main()'s comment for
 * why exactly one of those ever reaches stdout. */
async function forward() {
  const agent = process.argv[2];
  const kind = process.argv[3];
  const socketPath = process.env.MULLION_HOOK_SOCKET;
  const token = process.env.MULLION_HOOK_TOKEN;

  // No socket configured (hooks disabled, or an agent invoked outside a
  // Mullion session entirely) — silently do nothing. Never block or error
  // the agent's own hook execution on Mullion's behalf.
  if (!socketPath || !token || !agent || !kind) {
    return null;
  }

  const raw = await readStdin();
  const payload = parseHookStdin(raw);
  const result = buildForwarderMessage(agent, kind, payload);
  // A dialect returns one message, several (a single apply_patch call can
  // touch multiple files — see forwarder-core.mjs's mapCodexPostToolUse),
  // or nothing at all.
  const messages = Array.isArray(result) ? result : result === null ? [] : [result];
  if (messages.length === 0) {
    return null;
  }

  const gateMessage = messages.find((m) => m.kind === "review_gate" && m.state === "waiting");
  if (gateMessage) {
    // Deliberately wrapped: a synchronous throw from inside runGate's
    // executor (e.g. net.createConnection on a malformed socketPath) would
    // otherwise propagate out of this function as a rejected promise,
    // skipping straight to main()'s `finally` with result still null — which
    // would print the generic `{}` for what was actually a gate, i.e. fail
    // OPEN. runGate() itself already never rejects; this catch is defense in
    // depth so "this was a gate" can never lose its fail-closed guarantee
    // for any reason.
    try {
      return { type: "gate", decision: await runGate(socketPath, token, gateMessage) };
    } catch {
      return { type: "gate", decision: { decision: "denied", reason: "forwarder error" } };
    }
  }

  // Issue #271 — SessionStart also needs its own reply read back (unlike
  // the fire-and-forget path below), just with no human-decision stakes:
  // an empty additionalContext (no seed stashed, a timeout, a connection
  // error) is a completely ordinary, silent no-op, not a fail-closed
  // safety concern the way an unresolved gate would be.
  const sessionStartMessage = messages.find((m) => m.kind === "session_start");
  if (sessionStartMessage) {
    try {
      return {
        type: "sessionStart",
        additionalContext: await runSessionStart(socketPath, token, sessionStartMessage),
      };
    } catch {
      return { type: "sessionStart", additionalContext: "" };
    }
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
      for (const message of messages) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
      socket.end();
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });
  return null;
}

/** Sends the handshake + one `review_gate` waiting message, then blocks for
 * a single reply line: `{decision, reason?}`, written back by hooks.ts (see
 * that file's resolvePendingGate). Bounded by GATE_TIMEOUT_MS, and fails
 * closed ("denied") on a timeout, a connection error, an early close, or a
 * reply that doesn't parse as valid JSON — never rejects, always resolves to
 * a decision object, so callers never need their own fallback. */
function runGate(socketPath, token, gateMessage) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(decision);
    };
    const timer = setTimeout(
      () => finish({ decision: "denied", reason: "timed out waiting for a decision" }),
      GATE_TIMEOUT_MS,
    );

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish({ decision: "denied", reason: "malformed decision" });
        return;
      }
      const decision = reply?.decision === "approved" ? "approved" : "denied";
      const reason = typeof reply?.reason === "string" ? reply.reason : undefined;
      finish({ decision, reason });
    });
    socket.on("error", () => finish({ decision: "denied", reason: "connection error" }));
    socket.on("close", () => finish({ decision: "denied", reason: "connection closed" }));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
      socket.write(`${JSON.stringify(gateMessage)}\n`);
    });
  });
}

/** Sends the handshake + one `session_start` message, then blocks for a
 * single reply line: `{additionalContext}`, written back immediately by
 * hooks.ts (see that file's "session_start" handling — no human decision
 * involved, unlike runGate above). Bounded by SESSION_START_TIMEOUT_MS and
 * resolves to `""` (never rejects) on a timeout, a connection error, an
 * early close, or a reply that doesn't parse as valid JSON — an empty
 * string is a completely ordinary "nothing was stashed" outcome here, not a
 * failure mode callers need to distinguish. */
function runSessionStart(socketPath, token, message) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (additionalContext) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(additionalContext);
    };
    const timer = setTimeout(() => finish(""), SESSION_START_TIMEOUT_MS);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish("");
        return;
      }
      finish(typeof reply?.additionalContext === "string" ? reply.additionalContext : "");
    });
    socket.on("error", () => finish(""));
    socket.on("close", () => finish(""));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
      socket.write(`${JSON.stringify(message)}\n`);
    });
  });
}

main().catch(() => {
  // Best-effort by design — a forwarder failure must never surface as a
  // hook failure to the agent, and must never throw past this handler.
});
