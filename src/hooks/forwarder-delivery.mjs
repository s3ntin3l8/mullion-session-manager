// Issue #3174 — the delivery half of the hook forwarder: a `Stop` hook that
// the hook socket REFUSES (Mullion or an agent host restarting, the session's
// hook token not registered again yet) used to be dropped on the floor by the
// fire-and-forget path, and a lost `Stop` is visible — it is what tells
// Mullion that a headless Task Master worker has finished, so the worker
// then looks unfinished until its budget expires.
//
// This module owns that delivery: the handshake that names a delivery id,
// the acknowledgement the socket sends back, and the bounded retry that
// follows a refusal. It lives beside forwarder.mjs (which is the plain-JS
// shim an agent's own hook runner spawns — see that file's header for why
// it must stay plain JavaScript) rather than inside it, for the same reason
// forwarder-core.mjs lives beside it: the test tree imports this module
// IN-PROCESS, so the delivery logic is unit-testable against a real socket
// without spawning a child process.
//
// The protocol, in one paragraph: a delivery connection names a delivery id
// in its handshake, and the socket answers `{"ack":"accepted"}` once the
// handshake resolved, `{"ack":"delivered"}` once per dispatched message, and
// `{"ack":"refused"}` when the handshake was refused (nothing dispatched).
// The socket remembers the (delivery id, message index) pairs it dispatched
// for a session (src/services/hook-deliveries.ts), so a retried delivery is
// acknowledged again but never dispatched twice — a retried `Stop` reaches
// the session AT MOST ONCE.

import net from "node:net";
import { randomUUID } from "node:crypto";

// The retry delays, in milliseconds, before each further attempt.
//
// The bound: these wait 67s in total, and each attempt may itself take up
// to STOP_ATTEMPT_TIMEOUT_MS (5s), so the whole sequence stays under ~75s —
// inside the two minutes issue #3174 allows, and short enough that the agent
// CLI's own exit is not held up for long. The agent adapters' Stop hook
// timeout is raised to match (see src/services/hook-adapters/
// claude-code.ts's STOP_HOOK_TIMEOUT_SECONDS), because an agent that kills
// the hook at its own timeout would cut the retry sequence short — and a
// cut-short retry is a lost Stop, exactly as before.
export const STOP_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

// How long ONE attempt waits for the socket's acknowledgement. Generous for
// a local Unix socket round trip, bounded so a socket that accepts the
// connection and then says nothing cannot wedge the hook.
export const STOP_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Delivers a `Stop` with an explicit acknowledgement, retrying a refused or
 * unacknowledged delivery with a bounded backoff.
 *
 * Resolves true when the session acknowledged the delivery and false when
 * the forwarder gave up on it. Never rejects and never throws: a hook
 * failure must never surface to the agent.
 */
export async function deliverStop(socketPath, token, messages) {
  // ONE delivery id for the whole retry sequence: every attempt is the same
  // delivery, so the socket can recognise a retry of a message it already
  // dispatched and skip it (see src/services/hook-deliveries.ts).
  const deliveryId = randomUUID();
  const delays = stopRetryDelays();
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
    }
    const outcome = await attemptStopDelivery(socketPath, token, messages, deliveryId);
    if (outcome === "delivered") return true;
    // "giveup" means another attempt cannot help (see attemptStopDelivery's
    // own comment) — the delivery is dropped, exactly as the fire-and-forget
    // path drops one today.
    if (outcome === "giveup") return false;
  }
  return false;
}

/**
 * The retry delays this delivery uses. Overridable through
 * MULLION_FORWARDER_STOP_RETRY_DELAYS_MS (a comma-separated list of
 * milliseconds) so the retry path can be exercised by a test without
 * waiting out the production bound — production never sets it, and a
 * malformed value falls back to the built-in delays.
 */
export function stopRetryDelays() {
  const raw = process.env.MULLION_FORWARDER_STOP_RETRY_DELAYS_MS;
  if (!raw) return STOP_RETRY_DELAYS_MS;
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length > 0 ? parsed : STOP_RETRY_DELAYS_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One delivery attempt: writes the handshake (carrying the delivery id) and
 * every message, then waits for the socket's acknowledgement.
 *
 * Resolves "delivered" when every message was acknowledged, "retry" when the
 * attempt is worth repeating, and "giveup" when it is not:
 *
 *   - the connection never came up (the socket is gone — the very restart
 *     window this exists for): nothing was written, so a retry cannot
 *     duplicate anything → "retry";
 *   - the socket refused the handshake (`refused`): nothing was dispatched
 *     → "retry";
 *   - the socket acknowledged the delivery but the connection closed before
 *     every message was acknowledged: the socket understands delivery ids
 *     and deduplicates them, so the retry is safe → "retry";
 *   - the socket answered with its own error reply (a malformed message):
 *     the same message fails the same way on every attempt → "giveup";
 *   - the socket never answered at all: it may be an older Mullion that
 *     already dispatched the message, and a retry would then deliver the
 *     same event twice → "giveup".
 */
function attemptStopDelivery(socketPath, token, messages, deliveryId) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let connected = false;
    let buffer = "";
    let delivered = 0;
    // The socket spoke the delivery protocol at least once (an `accepted`,
    // a `delivered` or a `refused` reply). That is what makes a retry safe:
    // the server understands delivery ids and deduplicates them.
    let acknowledged = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };

    const outcome = () => {
      if (delivered >= messages.length) return "delivered";
      if (acknowledged) return "retry";
      return "giveup";
    };

    const timer = setTimeout(() => finish(outcome()), STOP_ATTEMPT_TIMEOUT_MS);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (reply?.ack === "accepted") {
          acknowledged = true;
          continue;
        }
        if (reply?.ack === "delivered") {
          acknowledged = true;
          delivered += 1;
          if (delivered >= messages.length) finish("delivered");
          continue;
        }
        if (reply?.ack === "refused") {
          // The handshake was refused, so nothing was dispatched — a retry
          // cannot duplicate anything.
          acknowledged = true;
          finish("retry");
          return;
        }
        if (reply?.error) {
          // The socket's own error reply (a malformed message, say) — the
          // same message fails the same way on every attempt.
          finish("giveup");
          return;
        }
      }
    });
    socket.on("error", () => finish(connected ? outcome() : "retry"));
    socket.on("close", () => finish(outcome()));
    socket.once("connect", () => {
      connected = true;
      // The delivery handshake names the delivery, so the socket answers
      // explicitly instead of dropping the message silently.
      socket.write(`${JSON.stringify({ token, deliveryId })}\n`);
      for (const message of messages) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
      socket.end();
    });
  });
}
