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

// Issue #1523 — chunks smaller than this are coalesced into the tail slab;
// the tail slab holds up to SLAB_BYTES. (16-64 KiB: big enough to amortize
// per-chunk overhead, small enough that slab-granular eviction overshoots the
// cap's intent by at most one slab.)
const COALESCE_MAX_BYTES = 16 * 1024;
const SLAB_BYTES = 64 * 1024;
// Compact the committed-slab array once the evicted head is at least this long
// and covers at least half of it.
const COMPACT_MIN_HEAD = 32;

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
  // Issue #1523 — the ring is stored as "slabs" rather than one entry per PTY
  // read. A PTY read is often a few dozen bytes; one Buffer object per read
  // (plus Array.shift() eviction, O(n) on a large array) is pure overhead.
  // Chunks below COALESCE_MAX_BYTES are copied into a writable tail slab of
  // up to SLAB_BYTES; larger chunks are stored as-is (their own slab). The
  // replayed byte stream is identical either way — only eviction granularity
  // changes (whole slabs, never splitting a slab).
  //
  // `slabs[head..]` are the committed slabs, oldest first; `head` advances on
  // eviction (slots are cleared for GC) and the array is compacted
  // periodically instead of shift()ing. `tailBuf[0..tailLen)` is the newest
  // data, still being appended to.
  private slabs: Array<Buffer | undefined> = [];
  private head = 0;
  private tailBuf: Buffer | null = null;
  private tailLen = 0;
  private totalBytes = 0;
  // Issue #1296 — a monotonic total, never decremented by eviction (unlike
  // totalBytes above). A caller that needs to exclude everything written
  // before some earlier moment (e.g. Session's alt-screen-exit watermark)
  // needs a count that survives the ring's own FIFO eviction: an index into
  // the current buffer would silently decay as eviction shifts every
  // position underneath it.
  private bytesEverPushed = 0;

  /**
   * Append `chunk`, then evict from the front (oldest slab first) until the
   * buffer is back at or under `SCROLLBACK_MAX_BYTES` — but never evict the
   * last remaining slab, even if it alone exceeds the cap on its own (a
   * single oversized chunk still needs SOME representation; leaving it in
   * is strictly better than silently emptying the buffer).
   */
  push(chunk: Buffer): void {
    const len = chunk.length;
    if (len >= COALESCE_MAX_BYTES) {
      this.commitTail();
      this.slabs.push(chunk);
    } else if (len > 0) {
      if (this.tailBuf === null || this.tailLen + len > SLAB_BYTES) {
        this.commitTail();
        this.tailBuf = Buffer.allocUnsafe(SLAB_BYTES);
      }
      chunk.copy(this.tailBuf, this.tailLen);
      this.tailLen += len;
    }
    this.totalBytes += len;
    this.bytesEverPushed += len;
    this.evict();
  }

  /** Seal the writable tail slab (if it holds anything) into the committed list. */
  private commitTail(): void {
    if (this.tailBuf !== null && this.tailLen > 0) {
      this.slabs.push(this.tailBuf.subarray(0, this.tailLen));
    }
    this.tailBuf = null;
    this.tailLen = 0;
  }

  private evict(): void {
    while (this.totalBytes > SCROLLBACK_MAX_BYTES && this.head < this.slabs.length) {
      // The tail slab (if any) is the newest, so a committed slab is
      // evictable whenever one exists alongside the tail; with no tail, the
      // last committed slab is the sole survivor and must stay.
      if (this.tailLen === 0 && this.head === this.slabs.length - 1) break;
      const dropped = this.slabs[this.head];
      this.slabs[this.head] = undefined;
      this.head++;
      if (dropped) this.totalBytes -= dropped.length;
    }
    // Amortized compaction instead of Array.shift()'s O(n) per eviction.
    if (this.head >= COMPACT_MIN_HEAD && this.head * 2 >= this.slabs.length) {
      this.slabs = this.slabs.slice(this.head);
      this.head = 0;
    }
  }

  /** Oldest-first views of everything buffered (committed slabs, then the live tail). */
  private views(): Buffer[] {
    const out: Buffer[] = [];
    for (let i = this.head; i < this.slabs.length; i++) out.push(this.slabs[i]!);
    if (this.tailBuf !== null && this.tailLen > 0) out.push(this.tailBuf.subarray(0, this.tailLen));
    return out;
  }

  /**
   * Everything currently buffered, oldest first, prefixed with `preamble`
   * bytes. The concat happens here (rather than exposing the raw slab list
   * to the caller) so this class stays the sole owner of the ring's internal
   * representation. Session.getScrollback() is the only caller, passing its
   * synthesized alt-screen/mouse-mode preamble (see that method's own doc
   * comment on Session for why that synthesis can't live here — it depends
   * on Session-level state this class doesn't and shouldn't track).
   */
  toBuffer(preamble: Buffer): Buffer {
    return Buffer.concat([preamble, ...this.views()]);
  }

  /**
   * Perf audit finding B8(1) — the last `maxBytes` of buffered output, no
   * preamble (unlike toBuffer() above, this isn't replayed to a reattaching
   * terminal — it only ever feeds a text scan, e.g. dev-server-detect.ts's
   * banner regex, where alt-screen/mouse-tracking escape sequences are
   * irrelevant noise). Walks the slab list from the newest end, stopping as
   * soon as `maxBytes` is covered, so this is O(slabs needed to reach
   * maxBytes) rather than toBuffer()'s O(entire ring) `Buffer.concat` plus
   * the caller's own full `toString("utf8")` copy. A startup banner is
   * virtually always near the most recent output, so tail-only scanning
   * doesn't meaningfully reduce detection accuracy.
   */
  tail(maxBytes: number): Buffer {
    const views = this.views();
    const collected: Buffer[] = [];
    let total = 0;
    for (let i = views.length - 1; i >= 0 && total < maxBytes; i--) {
      collected.push(views[i]);
      total += views[i].length;
    }
    collected.reverse();
    const result = Buffer.concat(collected, total);
    // The oldest included slab may itself start well before the maxBytes
    // boundary — trim to exactly the last maxBytes so a caller's cost bound
    // holds regardless of how large individual slabs are.
    return total > maxBytes ? result.subarray(total - maxBytes) : result;
  }

  /**
   * Issue #1228 — how much is buffered in total, so a caller of tail() can
   * tell "cut short" apart from "happened to return exactly maxBytes
   * because that's all there ever was." tail(maxBytes).length alone can't
   * distinguish those two cases (both produce a buffer of length
   * maxBytes), so a caller that needs to know whether a leading partial
   * line might exist has to compare against this instead.
   */
  totalBufferedBytes(): number {
    return this.totalBytes;
  }

  /**
   * Issue #1296 — the total bytes ever pushed, monotonically increasing
   * regardless of eviction (unlike totalBufferedBytes() above, which
   * shrinks when push()'s eviction loop drops old chunks). A caller can
   * diff two readings of this to get "how many bytes have been written
   * since moment X" even if the ring has evicted past that moment in the
   * meantime — see Session.silenceContextFromScrollback()'s alt-screen-exit
   * watermark, the reason this exists.
   */
  totalBytesEverPushed(): number {
    return this.bytesEverPushed;
  }
}
