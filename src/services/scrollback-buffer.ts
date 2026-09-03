// Extracted from pty-manager.ts (the ring buffer + its indivisible byte-level
// logic only — see that file's own header comment on why it's flagged as
// this repo's highest-risk file, and docs/architecture.md's "non-obvious
// session model" note before touching it or the terminal WS protocol).
//
// Deliberately NOT included here, even though a prior audit's rough cluster
// listed them alongside this ring buffer: `inAltScreen`, `mouseTracking`,
// `detectCarry`, `cwdDetectCarry`. All four stay on Session because they are
// read or written by parts of Session.onData that have nothing to do with
// scrollback:
//   - `inAltScreen` doubles as the #98 attention state machine's
//     "did we just exit alt-screen" signal (the old value is compared
//     against the freshly-detected one to compute `altScreenExited` before
//     being overwritten) — a genuine second consumer beyond scrollback
//     replay, so it can't move without splitting that comparison across two
//     objects.
//   - `mouseTracking` is updated in the very same onData block, off the same
//     `detectChunk`/`detectCarry` pipeline as `inAltScreen` — keeping it
//     paired with `inAltScreen` (rather than splitting one write onto this
//     class and the other onto Session) keeps that shared detection pipeline
//     in one place.
//   - `detectCarry` is the carry state feeding the detectors behind BOTH of
//     the above; it isn't scrollback state at all (an escape sequence
//     mid-byte-stream, not buffered output) and is explicitly documented in
//     pty-manager.ts as "never used for scrollback or fan-out".
//   - `cwdDetectCarry` feeds `_liveCwd` (OSC 7 cwd tracking) — an unrelated
//     feature that happens to reuse the same "carry a split escape sequence
//     across a PTY read boundary" shape, not scrollback in any sense.
//
// What DOES move here is what pty-manager.ts's own doc comments call "a
// continuous, gap-free record of everything the session produced" (see that
// file's header) — the append-only, byte-capped ring buffer and the two read
// paths over it (full replay, tail-only scan). Session.getScrollback() still
// owns synthesizing the alt-screen/mouse-mode preamble (since that depends on
// the Session-level state above) and hands this class's raw, preamble-free
// bytes to the caller by calling toBuffer(preamble).

// Enough for a healthy amount of scrollback history, not just "the last
// screen" — raised from the original 256KiB (issue #83) because that cap and
// xterm's own line-based scrollback (DEFAULT_SETTINGS.terminal.scrollback in
// settings.ts) were both starving real history, especially once
// redraw-nudge.ts's RedrawNudge repaints are folded in too. Keep this
// roughly proportionate to that line cap if either changes — at typical line
// widths they trade off against each other, so raising one alone barely
// helps.
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;

/**
 * A single session's byte-level scrollback ring buffer: an ordered list of
 * chunks (oldest first) FIFO-evicted once their combined size exceeds
 * `SCROLLBACK_MAX_BYTES`, plus the two read shapes callers need over it — a
 * full replay (preamble-prefixed) and a cheap tail-only scan.
 *
 * Deliberately a straight 1:1 move of pty-manager.ts's original scrollback
 * field pair (`scrollback`/`scrollbackBytes`) and its byte-level logic, not
 * a more "general-purpose" ring buffer — no configurable cap (Session has
 * exactly one use of this class, always at the module constant) and no
 * optional preamble (Session.getScrollback(), the only caller of toBuffer(),
 * always has one to pass). Speculative generality here would be untested
 * dead branches, not a real abstraction.
 *
 * Ownership/threading model mirrors the rest of pty-manager.ts: one instance
 * per Session, mutated only from that Session's own onData handler
 * (single-threaded Node, no concurrent access to guard against).
 */
export class ScrollbackBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  /**
   * Append `chunk`, then evict from the front (oldest first) until the
   * buffer is back at or under `SCROLLBACK_MAX_BYTES` — but never evict the
   * last remaining chunk, even if that one chunk alone exceeds the cap on
   * its own (a single oversized chunk still needs SOME representation;
   * leaving it in is strictly better than silently emptying the buffer).
   * This is the same invariant pty-manager.ts's original pushScrollback()
   * carried: `chunks.length > 1` guards the eviction loop, not `> 0`.
   */
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    while (this.totalBytes > SCROLLBACK_MAX_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.totalBytes -= dropped.length;
    }
  }

  /**
   * Everything currently buffered, oldest first, prefixed with `preamble`
   * bytes. The concat happens here (rather than exposing the raw chunk list
   * to the caller) so this class stays the sole owner of the ring's internal
   * representation. Session.getScrollback() is the only caller, passing its
   * synthesized alt-screen/mouse-mode preamble (see that method's own doc
   * comment on Session for why that synthesis can't live here — it depends
   * on Session-level state this class doesn't and shouldn't track).
   */
  toBuffer(preamble: Buffer): Buffer {
    return Buffer.concat([preamble, ...this.chunks]);
  }

  /**
   * Perf audit finding B8(1) — the last `maxBytes` of buffered output, no
   * preamble (unlike toBuffer() above, this isn't replayed to a reattaching
   * terminal — it only ever feeds a text scan, e.g. dev-server-detect.ts's
   * banner regex, where alt-screen/mouse-tracking escape sequences are
   * irrelevant noise). Walks the chunk list from the newest end, stopping as
   * soon as `maxBytes` is covered, so this is O(chunks needed to reach
   * maxBytes) rather than toBuffer()'s O(entire ring) `Buffer.concat` plus
   * the caller's own full `toString("utf8")` copy — pty.ts's
   * dev-server-detect timer used to pay both costs every 10s for every
   * eligible session regardless of how much (if any) of a ~1 MiB scrollback
   * ring had ever changed. A startup banner is virtually always near the
   * most recent output, so tail-only scanning doesn't meaningfully reduce
   * detection accuracy.
   */
  tail(maxBytes: number): Buffer {
    const collected: Buffer[] = [];
    let total = 0;
    for (let i = this.chunks.length - 1; i >= 0 && total < maxBytes; i--) {
      const chunk = this.chunks[i];
      collected.push(chunk);
      total += chunk.length;
    }
    collected.reverse();
    const result = Buffer.concat(collected, total);
    // The oldest included chunk may itself start well before the maxBytes
    // boundary — trim to exactly the last maxBytes so a caller's cost bound
    // holds regardless of how large individual chunks are.
    return total > maxBytes ? result.subarray(total - maxBytes) : result;
  }
}
