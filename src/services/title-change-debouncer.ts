// A1 (audit finding): an actively-working agent's TUI rewrites its OSC
// title roughly once a second (elapsed-time counters, spinner frames), and
// prior to this fix every one of those ticks produced its own persisted +
// broadcast title_change event — measured at 93.6% of ALL session_events
// rows in production (160,767 of 171,793 over 9 days / 25 sessions). That
// flood evicted genuinely important events (permission_request,
// tool_failure) from the 100-slot ring buffer within about two minutes,
// bloated the DB, and drove a WS-broadcast + frontend re-render on every
// tick. TITLE_CHANGE_EVENT_DEBOUNCE_MS/_CEILING_MS below coalesce the
// title_change EVENT (ring buffer + DB persistence + WS broadcast) on a
// trailing-edge debounce, mirroring SessionStateFile.schedule()'s shape
// (session-state-file.ts) — see scheduleTitleChangeEvent()'s doc comment
// for the "detection stays live, persistence gets coalesced" split this
// relies on.
export const TITLE_CHANGE_EVENT_DEBOUNCE_MS = 3_000;
// Ceiling mirrors SessionStateFile's own ceiling-timer role
// (session-state-file.ts's MAX_WRITE_DELAY_MS): forces an eventual
// title_change event even under CONTINUOUS title churn, which would
// otherwise keep resetting the trailing debounce forever and starve the
// event feed of any title_change at all for a session that never stops
// retitling.
export const TITLE_CHANGE_EVENT_CEILING_MS = 15_000;

/**
 * Trailing-edge debounce of a session's title_change EVENT, with a ceiling
 * timer armed on the first pending title (so a TUI that never stops retitling
 * still produces an eventual event). Always emits the LATEST pending title.
 * Extracted from Session (issue #1522) — detection stays on Session; only
 * the event coalescing lives here.
 */
export class TitleChangeDebouncer {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private ceilingTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingTitle: string | null = null;

  constructor(private readonly emit: (title: string) => void) {}

  schedule(title: string): void {
    const wasAlreadyPending = this.pendingTitle !== null;
    this.pendingTitle = title;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.flush();
    }, TITLE_CHANGE_EVENT_DEBOUNCE_MS);
    this.timeout.unref();

    if (!wasAlreadyPending) {
      if (this.ceilingTimeout !== null) clearTimeout(this.ceilingTimeout);
      this.ceilingTimeout = setTimeout(() => {
        this.flush();
      }, TITLE_CHANGE_EVENT_CEILING_MS);
      this.ceilingTimeout.unref();
    }
  }

  /** Fire the pending (possibly coalesced) event, if any, and clear both timers. */
  flush(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.ceilingTimeout !== null) {
      clearTimeout(this.ceilingTimeout);
      this.ceilingTimeout = null;
    }
    if (this.pendingTitle === null) return;
    const title = this.pendingTitle;
    this.pendingTitle = null;
    this.emit(title);
  }
}
