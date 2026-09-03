// Extracted from pty-manager.ts (the redraw-nudge state machine only — see
// that file's own header comment on why it's flagged as this repo's
// highest-risk file, and docs/architecture.md's "non-obvious session
// model" note before touching it or the terminal WS protocol).
//
// Why this exists at all — Milestone 1 found empirically that dtach's own
// `-r winch` redraw request (see Session.attachClient()'s dtach spawn args)
// is not enough on its own: Claude's Ink-based TUI only re-renders when it
// detects an ACTUAL dimension change (Node's tty resize-event machinery
// itself skips firing if the reported size is unchanged), so reattaching at
// the *same* size — the common case, since a reconnecting browser tab
// typically fits to the same window — produced a blank screen even with
// winch. A same-size nudge (±1 row) wasn't a big enough delta to reliably
// trigger it either; a proportionally larger dip (half the rows, floor of 4)
// was. So this class forces a real repaint by resizing away from and back to
// the current size, unconditionally, on every attach — not just when the
// size actually changed — so a real resize from the client still lands
// correctly on top of it.
//
// This module owns the generic dip/restore/grace-reset timing and
// cancellation mechanics; it does NOT own pty process control (resizing
// requires the dtach attach-client handle, which only Session has) or the
// two onData consumers of `suppressingOutput` (scrollback capture and the
// attention state machine — see pty-manager.ts's own onData comments for
// why a synthesized repaint must not be mistaken for real program output by
// either). Session hands this class a pair of callbacks — `resize()` and
// `getSize()` — rather than this class reaching into Session's ptyProcess/
// cols/rows fields directly. `getSize()` is read fresh at each stage
// (trigger-time for the dip-row math, live at dip/restore time for cols and
// at restore time for rows) rather than captured once — Session.resize()'s
// own comment documents why a real resize landing mid-cycle must still be
// respected by the eventual restore.
//
// Mirrors ScrollbackBuffer's/SessionStateFile's shape (scrollback-buffer.ts,
// session-state-file.ts): one instance per Session, mutated only from that
// Session's own single-threaded call sites — no concurrent access to guard
// against.

// How long after the final resize to keep suppressing the synthesized
// repaint (see `suppressingOutput`'s docstring below). The repaint a resize
// provokes arrives asynchronously — SIGWINCH, then whatever the TUI takes to
// re-render — not synchronously with the resize() call, so the window has to
// extend past it rather than closing the instant the last resize() returns.
export const NUDGE_REPAINT_GRACE_MS = 500;

/**
 * Callbacks Session provides so this class can drive a repaint without
 * owning process control itself.
 */
export interface RedrawNudgeHost {
  /** Resize the underlying pty (see Session.resize()). Called at the dip and
   * restore stages; safe to no-op (e.g. via optional chaining) if the attach
   * client has since died — this class never assumes the resize took
   * effect. */
  resize(cols: number, rows: number): void;
  /** The session's current terminal size, read live rather than passed once
   * at trigger() time — see this file's header comment for why. */
  getSize(): { cols: number; rows: number };
}

/**
 * The dip/restore/grace-reset cycle that forces Claude's Ink-based TUI (and
 * anything else that only re-renders on an actual dimension change) to
 * repaint on attach. Also tracks, for the duration of one cycle, whether the
 * repaint it provokes should be treated as synthesized rather than real
 * program output — see `suppressingOutput` below.
 */
export class RedrawNudge {
  // True while a trigger()'d repaint is in flight — see this class's own
  // header comment and trigger()'s docstring for the suppression window
  // itself. Deliberately dual-purpose from the CALLER's side (Session's
  // onData has two call sites that both check `suppressingOutput`, for
  // scrollback capture and attention-clearing respectively) even though this
  // class only ever writes it for one reason — "this chunk is OUR
  // synthesized repaint, not real program content." See pty-manager.ts's
  // onData comments for why both consumers need it and why they must stay
  // in sync with each other.
  private suppressed = false;
  // Handle for whichever stage (dip / restore / grace-reset) of the current
  // cycle is still pending — see cancel()'s doc comment for why this must be
  // tracked at all. A single nullable handle rather than a list: the three
  // stages are strictly sequential (each schedules the next from inside its
  // own callback), so at most one is ever outstanding at a time.
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: RedrawNudgeHost) {}

  /** Whether a repaint this instance provoked is still in flight — see the
   * `suppressed` field's own doc comment for why callers (Session's onData)
   * need to check this from two different, independent places. */
  get suppressingOutput(): boolean {
    return this.suppressed;
  }

  /**
   * Force a real repaint by dipping to roughly half the current rows, then
   * restoring — see this file's header comment for why a plain `-r winch`
   * redraw request isn't enough on its own.
   *
   * @param suppressCapture Skip buffering the repaint this nudge provokes
   * into scrollback, and don't let it clear attention either (see
   * `suppressingOutput`'s docstring). Only set by Session.requestRedraw()'s
   * reattach path, where the SAME repaint recurs on every reconnect and
   * would otherwise progressively evict real output from the ring buffer.
   * The initial spawn-time nudge from Session.attachClient() deliberately
   * does NOT set this — that repaint is the session's actual starting
   * screen state and is exactly what a later attach should see.
   */
  trigger(suppressCapture = false): void {
    // Supersede (never stack with) any cycle already in flight — see
    // cancel()'s doc comment for why. Must run BEFORE the suppressCapture
    // assignment below: cancelling clears `suppressed` when it was left set
    // by a cycle it's aborting, so doing this after would immediately wipe
    // out the suppression this very call is about to set.
    this.cancel();
    // Suppress scrollback capture (and attention-clearing) for the whole
    // dip-then-restore cycle plus a grace period past the final resize — see
    // `suppressingOutput`'s docstring for why the window has to extend past
    // resize() returning.
    if (suppressCapture) this.suppressed = true;
    const { rows } = this.host.getSize();
    const dipRows = Math.max(4, Math.floor(rows / 2));
    this.timer = setTimeout(() => this.dip(dipRows, suppressCapture), 300);
  }

  // The dip/restore/grace-reset stages below are split into named methods
  // (rather than nesting them as inline closures inside trigger()) purely
  // for readability — each one's single job reads on its own instead of
  // three levels deep. They still form one strictly-sequential chain, each
  // scheduling the next via `this.timer`, which is exactly what makes a
  // single handle (rather than a list of timers) enough to track and cancel
  // the whole in-flight cycle from cancel().

  private dip(dipRows: number, suppressCapture: boolean): void {
    const { cols } = this.host.getSize();
    this.host.resize(cols, dipRows);
    this.timer = setTimeout(() => this.restore(suppressCapture), 400);
  }

  private restore(suppressCapture: boolean): void {
    const { cols, rows } = this.host.getSize();
    this.host.resize(cols, rows);
    if (suppressCapture) {
      this.timer = setTimeout(() => this.graceReset(), NUDGE_REPAINT_GRACE_MS);
    } else {
      this.timer = null;
    }
  }

  private graceReset(): void {
    this.suppressed = false;
    this.timer = null;
  }

  /**
   * Cancel whichever stage of a trigger()'d cycle is currently pending, so a
   * new nudge always supersedes rather than interleaves with a prior one.
   * Fixes issue #107: without this, two overlapping cycles on the same
   * shared Session (e.g. a second reattach — two browser tabs, or reconnect
   * retries — landing while a first cycle's dip/restore/grace-reset timers
   * are still ticking) used to schedule fully independent timers per cycle,
   * producing FOUR resize calls (two dips, two restores) instead of one
   * clean pair, and could let an EARLIER cycle's grace-reset clear
   * `suppressed` while a LATER cycle's own dip/restore repaint is still in
   * flight — letting that repaint's reduced-height frame leak into
   * scrollback (or clear attention) and get replayed to a future attach.
   * Cancelling also takes over the responsibility of clearing `suppressed`:
   * the timer that would have done so (this cycle's own grace-reset) is
   * exactly what's being cancelled, so leaving suppression untouched here
   * would strand it on indefinitely.
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.suppressed) this.suppressed = false;
  }
}
