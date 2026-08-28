import {
  SignOnlyFilter,
  SshAgentFrameTooLargeError,
  type FilterResult,
} from "./ssh-agent-filter.js";
import { pipeChannelDirection, type MuxChannel } from "./ssh-agent-mux.js";

// Issue #820 — composes ssh-agent-mux.ts's channel-piping primitives with
// ssh-agent-filter.ts's sign-only classifier into the ONE relay this
// repo's own (primary-side, defense-in-depth) leg of the bridge needs:
// requests flowing FROM an SSH client TOWARD the real agent are filtered,
// replies flowing back are relayed unmodified — see ssh-agent-filter.ts's
// own header comment on why only the request direction needs policy at
// all. The laptop-side filter instance (a separate, non-TypeScript
// implementation per the design plan) is the authoritative enforcement
// point; this one exists so a compromised primary can't abuse a
// bridge-enrolled agent host as a signing oracle even if the laptop's own
// filter were ever bypassed.
//
// `requestSource` carries an SSH client's raw request bytes (the agent
// host's own inbound leg — see the local-socket materialization module
// this PR also adds). `replyDest` is the channel toward the bridge/helper,
// ultimately the laptop's real ssh-agent. Both must already be open.
export function pipeFilteredChannelToChannel(
  requestSource: MuxChannel,
  replyDest: MuxChannel,
): void {
  pipeFilteredRequestDirection(requestSource, replyDest);
  pipeChannelDirection(replyDest, requestSource);
}

/** The filtered half of `pipeFilteredChannelToChannel` — kept separate and
 * exported for direct unit testing of the filtering/accounting behavior
 * without needing two full mux connections wired together. */
export function pipeFilteredRequestDirection(source: MuxChannel, dest: MuxChannel): void {
  const filter = new SignOnlyFilter();
  const pending: Buffer[] = [];

  function flush(): void {
    while (pending.length > 0) {
      const next = pending[0];
      if (dest.closed || next.length > dest.sendWindow) return;
      pending.shift();
      dest.send(next);
      source.acknowledgeConsumed(next.length);
    }
  }

  // A rejection reply travels back on `source` itself, toward whoever
  // sent the blocked request — it never touches `dest`'s window, so
  // (unlike a forwarded frame above) it doesn't need to wait for flush()
  // and doesn't hold up acknowledging the original request either.
  function sendReject(replyFrame: Buffer, originalLength: number): void {
    // Guarded, not unconditional: a flood of nothing-but-blocked-requests
    // could in principle exhaust `source`'s own send window (its reply
    // direction) before any forward traffic ever drains it. Dropping the
    // reply in that extreme case still keeps the acknowledgeConsumed
    // accounting below correct — it just means that one requester sees a
    // stalled request instead of an immediate SSH_AGENT_FAILURE.
    if (!source.closed && replyFrame.length <= source.sendWindow) {
      source.send(replyFrame);
    }
    source.acknowledgeConsumed(originalLength);
  }

  source.onData((chunk) => {
    if (dest.closed || source.closed) return;

    let result: FilterResult;
    try {
      result = filter.feed(chunk);
    } catch (err) {
      if (!(err instanceof SshAgentFrameTooLargeError)) throw err;
      // Fail closed: an untrustworthy length prefix means SignOnlyFilter
      // can no longer safely parse the rest of this stream (see its own
      // doc) — close both legs rather than attempt to forward or salvage
      // anything from partialResult.
      if (!source.closed) source.close();
      if (!dest.closed) dest.close();
      return;
    }

    for (let i = 0; i < result.reject.length; i++) {
      sendReject(result.reject[i], result.rejectedLengths[i]);
    }
    pending.push(...result.forward);
    flush();
  });

  dest.onDrain(flush);
  source.onEof(() => {
    if (!dest.closed) dest.eof();
  });
  source.onClose(() => {
    if (!dest.closed) dest.close();
  });
}
