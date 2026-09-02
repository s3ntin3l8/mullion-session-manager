import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { WarningTriangleIcon } from "./ui/icons.js";
import { RateLimitedError } from "./api/client.js";

interface Props {
  children: ReactNode;
  // Called when "Reload pane" is clicked — the parent (App.tsx's per-panel
  // wrapper) bumps a key on the crashed child so it remounts fresh. A class
  // component's own error state has no way to "retry" the exact subtree
  // that threw, so clearing local state alone isn't enough; the parent must
  // hand this boundary a genuinely new child.
  onReset: () => void;
}

interface State {
  error: Error | null;
  // Per-error wall-clock timestamp for the active RateLimitedError, set
  // in componentDidCatch when a RateLimitedError is captured. Render()
  // derives `secondsLeft` purely from this + Date.now() + retryAfterMs
  // — no mutable `remainingMs`, no forceUpdate, no side effects during
  // render (Hermes review, PR #970).
  rateLimitedAt: number | null;
}

// A crash inside one terminal pane (a WS/xterm bug, an unsupported addon
// option, whatever) shouldn't blank the entire dashboard, sidebar included —
// this is scoped around the dockview area alone so the rest of the app
// (project list, other already-open panes) stays usable. Restyled to the
// design's "Crashed pane — isolated" state (States doc section 04).
//
// Issue #959 — the original "scope: dockview only" reasoning was about an
// internal panic (WS/xterm bug, etc.), where the right behavior is to
// isolate the affected pane. A 429 is a different class of failure: the
// backend is fine, the caller's just been told to back off. The right
// behavior there is a distinct UI (a "too many requests" message with a
// visible retry-after count-down) rather than the generic "this pane
// crashed" warning triangle. The component's behavior is therefore
// branched: a `RateLimitedError` renders the rate-limited UI, anything
// else falls through to the original "this pane crashed" state.
//
// Render purity (Hermes review, PR #970): `render()` is a pure function of
// props/state + Date.now(). The count-down timer is started in
// `componentDidCatch` (lifecycle), never inside render. There is no
// mutable `remainingMs` and no `forceUpdate()` — the timer exists only
// to nudge React into re-running render() once per second so the derived
// `secondsLeft` value drifts toward zero.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, rateLimitedAt: null };
  // setInterval handle for the count-down re-render nudge. Cleared on
  // unmount or when the boundary's error state transitions away from a
  // RateLimitedError (reset / unmount).
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  static getDerivedStateFromError(error: Error): Pick<State, "error"> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[error-boundary]", error, info.componentStack);
    // Side effect belongs in a lifecycle method, NOT in render (Hermes
    // review, PR #970). Anchor the count-down's wall-clock start here
    // so render() can derive `secondsLeft` purely from this timestamp
    // + Date.now() + retryAfterMs. The interval below only nudges React
    // to re-run render() once per second; the displayed value is
    // recomputed from real time, not decremented.
    if (error instanceof RateLimitedError) {
      this.setState({ rateLimitedAt: Date.now() });
      if (this.countdownTimer === null) {
        this.countdownTimer = setInterval(() => {
          this.setState({});
        }, 1_000);
      }
    }
  }

  componentDidUpdate(_prevProps: Props, prevState: State): void {
    // Clear the timer when the boundary's error transitions away from
    // a RateLimitedError (e.g. the user clicked "Try again" and the
    // parent is about to remount the subtree). Without this, the
    // interval would keep firing against a now-irrelevant state.
    if (
      prevState.error instanceof RateLimitedError &&
      !(this.state.error instanceof RateLimitedError)
    ) {
      this.stopCountdown();
    }
  }

  componentWillUnmount(): void {
    this.stopCountdown();
  }

  handleReload = (): void => {
    this.stopCountdown();
    this.props.onReset();
    this.setState({ error: null, rateLimitedAt: null });
  };

  private stopCountdown(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  // Pure: derives `secondsLeft` from the anchor timestamp + retryAfterMs,
  // no mutable instance state. Render may be called any number of times
  // (parent re-renders, StrictMode, etc.) and always produces the same
  // output for the same (state, Date.now()) input.
  private renderRateLimited(error: RateLimitedError) {
    const elapsed = this.state.rateLimitedAt === null ? 0 : Date.now() - this.state.rateLimitedAt;
    const remainingMs = Math.max(0, error.retryAfterMs - elapsed);
    const secondsLeft = Math.max(1, Math.ceil(remainingMs / 1_000));
    return (
      <div className="crashed-pane rate-limited" data-testid="rate-limited">
        <WarningTriangleIcon size={19} style={{ color: "var(--r)" }} />
        <div className="crashed-pane-title">Too many requests</div>
        <div className="crashed-pane-subtitle">try again in {secondsLeft}s</div>
        <button className="crashed-pane-reload" onClick={this.handleReload}>
          Try again
        </button>
      </div>
    );
  }

  render() {
    if (this.state.error instanceof RateLimitedError) {
      return this.renderRateLimited(this.state.error);
    }
    if (this.state.error) {
      return (
        <div className="crashed-pane">
          <WarningTriangleIcon size={19} style={{ color: "var(--r)" }} />
          <div className="crashed-pane-title">This pane crashed</div>
          <div className="crashed-pane-subtitle">other panes are unaffected</div>
          <button className="crashed-pane-reload" onClick={this.handleReload}>
            Reload pane
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
