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
  siblingsFor,
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
      // agy's PreToolUse hook always fires (the hook is always registered —
      // gating happens at the forwarder level), and agy's hook runner
      // interprets the stdout output as a decision. On the non-gate path
      // (MULLION_REVIEW_GATE_ENABLED not "true"), the review_gate is
      // stripped but we must still print a valid allow decision — an empty
      // `{}` is ambiguous and agy may treat it as a denial (issue #264).
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
  const rawMessages = Array.isArray(result) ? result : result === null ? [] : [result];
  if (rawMessages.length === 0) {
    return null;
  }

  // Phase 2 (issue #264): when MULLION_REVIEW_GATE_ENABLED is not "true",
  // strip review_gate messages but keep observational ones (git_branch,
  // cwd_changed) so worktree detection and cwd tracking still work without
  // blocking — mirrors the same default-off posture as Claude Code's
  // hook-registration-level gate, but at the forwarder level rather than the
  // hook-registration level since agy's PreToolUse serves dual
  // observational+gate duty.
  const messages =
    (process.env.MULLION_REVIEW_GATE_ENABLED ?? "").toLowerCase() === "true"
      ? rawMessages
      : rawMessages.filter((m) => m.kind !== "review_gate");
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
    const siblings = siblingsFor(messages, gateMessage);
    // Deliberately wrapped: a synchronous throw from inside runGate's
    // executor (e.g. net.createConnection on a malformed socketPath) would
    // otherwise propagate out of this function as a rejected promise,
    // skipping straight to main()'s `finally` with result still null — which
    // would print the generic `{}` for what was actually a gate, i.e. fail
    // OPEN. runGate() itself already never rejects; this catch is defense in
    // depth so "this was a gate" can never lose its fail-closed guarantee
    // for any reason.
    try {
      return { type: "gate", decision: await runGate(socketPath, token, siblings, gateMessage) };
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
 * hooks.ts (see that file's resolvePendingGate). Bounded by GATE_TIMEOUT_MS,
 * and fails closed ("denied") on a timeout, a connection error, an early
 * close, or a reply that doesn't parse as valid JSON — never rejects, always
 * resolves to a decision object, so callers never need their own fallback. */
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
      // Hermes review, PR #466 — a reply lacking `decision` entirely (e.g.
      // hooks.ts's `{error}` reply to a line that failed its own
      // validation) already fails closed via the ternary below, but that
      // degradation was previously silent — indistinguishable, from the
      // forwarder's own logs, from a real "denied" decision. siblingsFor's
      // stderr log covers the case where WE chose to drop a known
      // reply-eliciting kind; this covers the case where a reply arrives
      // that we didn't expect at all (e.g. from an unvalidated sibling,
      // see REPLY_ELICITING_KINDS's own comment on why that Set alone isn't
      // sufficient), so a future regression here is diagnosable too. When
      // the reply is hooks.ts's own `{error}` shape rather than an
      // arbitrary malformed line, carry that error into `reason` so the
      // resulting auto-deny is self-documenting to whoever reads the
      // decision (not just whoever happens to see forwarder stderr).
      if (typeof reply?.decision !== "string") {
        console.error(
          `forwarder: gate reply had no "decision" field (${JSON.stringify(reply)}) — treating as denied`,
        );
      }
      const decision = reply?.decision === "approved" ? "approved" : "denied";
      const reason =
        typeof reply?.reason === "string"
          ? reply.reason
          : typeof reply?.error === "string"
            ? reply.error
            : undefined;
      finish({ decision, reason });
    });
    socket.on("error", () => finish({ decision: "denied", reason: "connection error" }));
    socket.on("close", () => finish({ decision: "denied", reason: "connection closed" }));
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
