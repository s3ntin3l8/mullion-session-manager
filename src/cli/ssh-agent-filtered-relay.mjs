// Issue #820 (round 4 PR2) — composes ssh-agent-bridge-mux.mjs's channel
// piping primitives with ssh-agent-filter.mjs's sign-only classifier into
// the ONE relay `mullion helper run` needs: requests flowing FROM the
// primary (mux channel) TOWARD the real local agent (net.Socket) are
// filtered; replies flowing back are relayed unmodified. Direct structural
// mirror of src/services/ssh-agent-relay.ts, which composes
// src/services/ssh-agent-filter.ts the same way for the primary-side leg —
// see that module's own header comment. THIS module is the authoritative
// enforcement point (ssh-agent-filter.mjs's own header comment); the
// primary-side one is defense in depth.
//
// `socket` is the laptop's real local agent connection
// (`net.connect({path: sshAuthSock})` in ssh-agent-helper.mjs's runRun).
// `channel` is the mux channel toward the bridge/primary. Both must
// already be open/accepted.
import { SignOnlyFilter, SshAgentFrameTooLargeError } from "./ssh-agent-filter.mjs";
import { pipeSocketRepliesToChannel } from "./ssh-agent-bridge-mux.mjs";

export function pipeFilteredNetSocketToChannel(socket, channel) {
  pipeSocketRepliesToChannel(socket, channel); // unfiltered reply direction, unchanged
  pipeFilteredChannelRequestsToSocket(socket, channel);
}

/** The filtered half of `pipeFilteredNetSocketToChannel` — kept separate
 * and exported for direct unit testing of the filtering/accounting
 * behavior without needing a full mux connection wired up, same reasoning
 * as ssh-agent-relay.ts's own pipeFilteredRequestDirection export. */
export function pipeFilteredChannelRequestsToSocket(socket, channel) {
  const filter = new SignOnlyFilter();

  // A rejection reply travels back on `channel` itself, toward whoever
  // sent the blocked request — it never touches `socket` at all. Guarded,
  // not unconditional (mirrors ssh-agent-relay.ts's own sendReject): a
  // flood of nothing-but-blocked-requests could in principle exhaust
  // channel's own send window (its reply direction) before anything drains
  // it. Dropping the reply in that extreme case is still safe — the
  // requester just sees a stalled request instead of an immediate
  // SSH_AGENT_FAILURE — and channel.send() itself would throw on an
  // over-window chunk if called unguarded (InboundChannel's own contract).
  function sendReject(replyFrame) {
    if (!channel.closed && replyFrame.length <= channel.sendWindow) {
      channel.send(replyFrame);
    }
  }

  channel.onData((chunk) => {
    if (socket.destroyed) return;
    const byteLength = chunk.length;

    let result;
    try {
      result = filter.feed(chunk);
    } catch (err) {
      if (!(err instanceof SshAgentFrameTooLargeError)) throw err;
      // Fail closed: an untrustworthy length prefix means SignOnlyFilter
      // can no longer safely parse the rest of this stream (see its own
      // doc) — close both legs rather than attempt to forward or salvage
      // anything from partialResult.
      if (!channel.closed) channel.close();
      if (!socket.destroyed) socket.destroy();
      return;
    }

    for (const rejectFrame of result.reject) sendReject(rejectFrame);

    // Acknowledge the ORIGINAL received length regardless of how many (if
    // any) of its frames were forwarded vs. blocked — matches
    // pipeChannelRequestsToSocket's own accounting (ssh-agent-bridge-
    // mux.mjs): the channel's flow-control credit is about bytes RECEIVED
    // on this leg, not bytes actually written to the real agent.
    if (result.forward.length === 0) {
      channel.acknowledgeConsumed(byteLength);
      return;
    }
    const toForward =
      result.forward.length === 1 ? result.forward[0] : Buffer.concat(result.forward);
    socket.write(toForward, () => channel.acknowledgeConsumed(byteLength));
  });
  channel.onEof(() => {
    if (!socket.destroyed) socket.end();
  });
  channel.onClose(() => {
    if (!socket.destroyed) socket.destroy();
  });
}
