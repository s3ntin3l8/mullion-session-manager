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
// The blocking permission-approval path (PermissionRequest, issue #264 —
// originally a PreToolUse/Bash gate, issue #178, replaced because it fired
// on EVERY Bash call including already-allowlisted ones) is the one
// exception: when the mapped message is a `review_gate` in state "waiting",
// this instead keeps the connection open and blocks for a single reply line
// (runGate() below) — written back by hooks.ts once POST
// /api/sessions/:id/review-gate delivers a real human decision, or by
// hooks.ts's own server-side timeout if nobody ever does — then prints the
// target agent's own decision JSON to stdout (formatGateDecision, see
// forwarder-core.mjs) instead of the unconditional `{}` main() otherwise
// prints. A real human decision ("approved"/"denied") formats to that
// agent's real allow/deny shape; nobody ever answering ("no_response" —
// this forwarder's own timeout/socket-error/close, or hooks.ts's own
// GATE_TIMEOUT_MS expiring) formats to a bare `{}`, confirmed live to make
// Claude Code (and Codex) fall through to their own native permission
// dialog — the same thing that would have happened with no Mullion
// involved at all, not a worse outcome for a feature that's supposed to be
// strictly additive.

import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  buildForwarderMessage,
  formatGateDecision,
  formatSessionStartOutput,
  parseHookStdin,
  siblingsFor,
} from "./forwarder-core.mjs";

// Bounded below claude-code.ts's own PermissionRequest hook `timeout`
// (PERMISSION_REQUEST_TIMEOUT_SECONDS, 300s) so THIS process controls the
// fall-through decision and prints valid JSON before the agent's own
// hook-level timeout fires and does something less predictable — mirrors
// hooks.ts's own GATE_TIMEOUT_MS (290s) for the same reason, on the other
// end of the same connection.
const GATE_TIMEOUT_MS = 280_000;

// Issue #271 — a SessionStart round trip has no human in the loop (hooks.ts
// answers it synchronously from an in-memory lookup — see its
// "session_start" handling), so this only needs to be generous enough for
// an ordinary local socket round trip, nowhere near GATE_TIMEOUT_MS's
// human-decision budget. Bounded below claude-code.ts's own SessionStart
// hook `timeout` (10s) for the same "this process controls the fail-safe
// default" reasoning as GATE_TIMEOUT_MS.
const SESSION_START_TIMEOUT_MS = 5_000;

// Issue #462 — siblingsFor and its REPLY_ELICITING_KINDS invariant live in
// forwarder-core.mjs (imported above), not here, so the drop+log branch is
// unit-testable with a synthetic payload — see that Set's own doc comment
// for the full rationale.
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
    } else if (process.argv[2] === "agy" && process.argv[3] === "PreToolUse") {
      // agy's PreToolUse is purely observational now (issue #264 removed the
      // review_gate it used to sometimes emit), but agy's own hook runner
      // still interprets ANY PreToolUse stdout output as a decision — an
      // empty `{}` is ambiguous and agy may treat it as a denial, so this
      // must always print an explicit allow.
      console.log(JSON.stringify({ decision: "allow" }));
    } else {
      // Some agents (agy — issue #253) run hooks SYNCHRONOUSLY, blocking
      // their own agent loop on this process's exit, and expect a JSON
      // decision object on stdout even for a purely observational hook (an
      // empty `{}` means "no decision" — never blocks/continues anything).
      // Printed on every non-gate/non-seeded exit path for agents other
      // than the agy PreToolUse handled above: harmless for Claude
      // Code/Codex, whose own hook contracts don't require (or forbid) any
      // stdout output.
      console.log("{}");
    }
  }
}

/** Returns `null` for the ordinary fire-and-forget path (main() prints
 * `{}` for most agents, or `{decision: "allow"}` for agy PreToolUse), or a
 * `{decision, reason}` object once a gate has resolved (main() prints that
 * agent's own decision JSON instead) — see main()'s comment for why exactly
 * one of those ever reaches stdout. */
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

  // Issue #462 — a message array can carry a piggybacked sibling (most
  // commonly cwd_changed — see forwarder-core.mjs's mapClaudeCodeEvent)
  // alongside a blocking message (review_gate/session_start). Both branches
  // below used to `find()` just the blocking message and hand ONLY that one
  // to runGate/runSessionStart, silently dropping every sibling — the
  // generic send loop further down was never reached once a blocking
  // message existed. Send siblings first (via siblingsFor, see its own and
  // REPLY_ELICITING_KINDS's comments above), then the blocking message, all
  // on the SAME connection (hooks.ts already loops over every
  // newline-delimited line on a connection, not just the first — no
  // protocol change needed). Siblings must precede the blocking message:
  // both runGate/runSessionStart destroy the socket on the FIRST reply
  // line, and the mapper already emits a piggybacked cwd_changed first for
  // exactly this reason (see mapClaudeCodeEvent's own ordering comment).
  const gateMessage = messages.find((m) => m.kind === "review_gate" && m.state === "waiting");
  if (gateMessage) {
    // Issue: correlate concurrent permission gates — generated HERE, not in
    // forwarder-core.mjs's dialect mappers, to keep those pure/synchronous
    // and unit-testable with a synthetic payload (their own existing
    // design intent — see forwarder-core.mjs's file header). One id per
    // BLOCKED PROCESS, not per reply: runGate below still settles on the
    // first reply line on its own connection (one gate per connection,
    // unchanged) — the id's only job is letting hooks.ts's `pendingGates`
    // map hold more than one waiting gate per session, and letting POST
    // /api/sessions/:id/review-gate say WHICH one a decision is for.
    gateMessage.gateId = randomUUID();
    const siblings = siblingsFor(messages, gateMessage);
    // Deliberately wrapped: a synchronous throw from inside runGate's
    // executor (e.g. net.createConnection on a malformed socketPath) would
    // otherwise propagate out of this function as a rejected promise,
    // skipping straight to main()'s `finally` with result still null — which
    // would print the generic `{}` main() ALSO prints for `no_response`
    // below, so in practice this catch and the ordinary null-result path
    // converge on the same output. It exists anyway so `result.type ===
    // "gate"` stays true even on this internal-error path, keeping this
    // branch's own contract ("once we know it's a gate, decide something")
    // independent of that coincidence. runGate() itself already never
    // rejects; if this forwarder's own machinery breaks before it can even
    // ask, that's "nobody ever decided" — the same "no_response" outcome as
    // a timeout or a dropped connection, resolving to a bare `{}` fall
    // through to the agent's own native prompt (issue #264), never an
    // explicit denial the actual permission decision had nothing to do
    // with.
    try {
      return { type: "gate", decision: await runGate(socketPath, token, siblings, gateMessage) };
    } catch {
      return { type: "gate", decision: { decision: "no_response", reason: "forwarder error" } };
    }
  }

  // Issue #271 — SessionStart also needs its own reply read back (unlike
  // the fire-and-forget path below), just with no human-decision stakes:
  // an empty additionalContext (no seed stashed, a timeout, a connection
  // error) is a completely ordinary, silent no-op, not a fail-closed
  // safety concern the way an unresolved gate would be.
  const sessionStartMessage = messages.find((m) => m.kind === "session_start");
  if (sessionStartMessage) {
    const siblings = siblingsFor(messages, sessionStartMessage);
    try {
      return {
        type: "sessionStart",
        additionalContext: await runSessionStart(socketPath, token, siblings, sessionStartMessage),
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
      writeHandshakeAndMessages(socket, token, messages);
      socket.end();
    });
    socket.once("close", finish);
    socket.once("error", finish);
  });
  return null;
}

/** Writes the handshake, then every message in `messages` in order — shared
 * by runGate/runSessionStart's `connect` handlers (called with `[...siblings,
 * blockingMessage]`, e.g. a piggybacked cwd_changed ahead of the
 * review_gate/session_start — issue #462) and forward()'s fire-and-forget
 * path (called with the full message list, no blocking message involved),
 * so the write shape lives in exactly one place. Deliberately does NOT
 * close/end the socket — callers that expect a reply keep it open; the
 * fire-and-forget caller ends it itself right after. */
function writeHandshakeAndMessages(socket, token, messages) {
  socket.write(`${JSON.stringify({ token })}\n`);
  for (const message of messages) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

/** Sends the handshake + any `siblings` (in order, e.g. a piggybacked
 * cwd_changed — issue #462) + the one `review_gate` waiting message, then
 * blocks for a single reply line: `{decision, reason?}`, written back by
 * hooks.ts (see that file's resolvePendingGate). Bounded by GATE_TIMEOUT_MS.
 * Never rejects, always resolves to a decision object, so callers never need
 * their own fallback. A real human decision only ever arrives as
 * "approved"/"denied"; every other outcome here — a timeout, a connection
 * error, an early close, or a reply that doesn't parse as valid JSON —
 * resolves to "no_response" (issue #264 rescope), NOT "denied": nobody ever
 * deciding must fall through to the agent's own native prompt
 * (formatGateDecision's bare `{}`), not silently deny a tool call the agent
 * would otherwise have simply asked its own user about. */
function runGate(socketPath, token, siblings, gateMessage) {
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
      () => finish({ decision: "no_response", reason: "timed out waiting for a decision" }),
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
        finish({ decision: "no_response", reason: "malformed decision" });
        return;
      }
      // Hermes review, PR #466 — a reply lacking `decision` entirely (e.g.
      // hooks.ts's `{error}` reply to a line that failed its own
      // validation) already falls through via the ternary below, but that
      // degradation was previously silent — indistinguishable, from the
      // forwarder's own logs, from a genuine "nobody answered". siblingsFor's
      // stderr log covers the case where WE chose to drop a known
      // reply-eliciting kind; this covers the case where a reply arrives
      // that we didn't expect at all (e.g. from an unvalidated sibling,
      // see REPLY_ELICITING_KINDS's own comment on why that Set alone isn't
      // sufficient), so a future regression here is diagnosable too. When
      // the reply is hooks.ts's own `{error}` shape rather than an
      // arbitrary malformed line, carry that error into `reason` so the
      // resulting fall-through is self-documenting to whoever reads it (not
      // just whoever happens to see forwarder stderr).
      if (typeof reply?.decision !== "string") {
        console.error(
          `forwarder: gate reply had no "decision" field (${JSON.stringify(reply)}) — falling through`,
        );
      }
      const decision =
        reply?.decision === "approved"
          ? "approved"
          : reply?.decision === "denied"
            ? "denied"
            : "no_response";
      const reason =
        typeof reply?.reason === "string"
          ? reply.reason
          : typeof reply?.error === "string"
            ? reply.error
            : undefined;
      finish({ decision, reason });
    });
    socket.on("error", () => finish({ decision: "no_response", reason: "connection error" }));
    socket.on("close", () => finish({ decision: "no_response", reason: "connection closed" }));
    socket.once("connect", () => {
      writeHandshakeAndMessages(socket, token, [...siblings, gateMessage]);
    });
  });
}

/** Sends the handshake + any `siblings` (in order, e.g. a piggybacked
 * cwd_changed — issue #462) + the one `session_start` message, then blocks
 * for a single reply line: `{additionalContext}`, written back immediately
 * by hooks.ts (see that file's "session_start" handling — no human decision
 * involved, unlike runGate above). Bounded by SESSION_START_TIMEOUT_MS and
 * resolves to `""` (never rejects) on a timeout, a connection error, an
 * early close, or a reply that doesn't parse as valid JSON — an empty
 * string is a completely ordinary "nothing was stashed" outcome here, not a
 * failure mode callers need to distinguish. */
function runSessionStart(socketPath, token, siblings, message) {
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
      // Hermes review, PR #466 — same diagnosability gap as runGate's
      // matching log above: a reply lacking `additionalContext` (e.g.
      // hooks.ts's `{error}` reply to a validation-failing sibling)
      // already resolves to "" via the ternary below — an ordinary,
      // silent no-op for a genuine "nothing was stashed" case, but
      // previously indistinguishable in the forwarder's own logs from an
      // unexpected reply shape.
      if (typeof reply?.additionalContext !== "string") {
        console.error(
          `forwarder: session_start reply had no "additionalContext" field (${JSON.stringify(reply)}) — treating as empty`,
        );
      }
      finish(typeof reply?.additionalContext === "string" ? reply.additionalContext : "");
    });
    socket.on("error", () => finish(""));
    socket.on("close", () => finish(""));
    socket.once("connect", () => {
      writeHandshakeAndMessages(socket, token, [...siblings, message]);
    });
  });
}

main().catch(() => {
  // Best-effort by design — a forwarder failure must never surface as a
  // hook failure to the agent, and must never throw past this handler.
});
