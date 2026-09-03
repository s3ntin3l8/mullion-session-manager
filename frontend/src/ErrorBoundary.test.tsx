// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { __resetRateLimitBreakerForTests, RateLimitedError } from "./api/client.js";

// Regression coverage for issue #959: a render-time throw of a
// RateLimitedError (e.g. from a 429 on a render-blocking fetch) must
// surface a "Too many requests — try again in N seconds" UI with a
// working count-down, NOT a generic "This pane crashed" message. The
// existing ErrorBoundary's "scope: dockview only" comment
// (ErrorBoundary.tsx's own header) is being deliberately widened here:
// a 429 on something outside the dockview scope was producing a blank
// page before — the new behavior is to display a clear, retryable
// message instead.
//
// Hermes review (PR #970): the count-down derives `secondsLeft` from
// an anchored wall-clock timestamp set in componentDidUpdate, NOT
// from mutable instance state mutated in render(). The tests below
// exercise the same observable behavior (UI text + "Try again"
// button) and additionally assert that the boundary does NOT auto-
// reset on count-down completion — that path is reserved for the
// root boundary's window.location.reload() callback, and auto-firing
// it from the count-down would mean a 60s-rate-limited user gets a
// page reload with no warning.
describe("ErrorBoundary / RateLimitedError branch (issue #959)", () => {
  beforeEach(() => {
    __resetRateLimitBreakerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a 'too many requests' UI when a child throws RateLimitedError, distinct from the generic crash UI", () => {
    const Thrower = (): never => {
      throw new RateLimitedError(429, 5_000);
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.queryByText("This pane crashed")).not.toBeInTheDocument();
    expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
  });

  it("the count-down reflects retryAfterMs initially", () => {
    vi.useFakeTimers();
    const Thrower = (): never => {
      throw new RateLimitedError(429, 5_000);
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    // The count-down starts at the retryAfterMs value (rounded up to
    // whole seconds for the user-facing label).
    expect(screen.getByText(/try again in 5/i)).toBeInTheDocument();
  });

  it("the count-down ticks down as time advances", () => {
    vi.useFakeTimers();
    const Thrower = (): never => {
      throw new RateLimitedError(429, 5_000);
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/try again in 5/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText(/try again in 3/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/try again in 2/i)).toBeInTheDocument();
  });

  it("does NOT auto-call onReset when the count-down completes — only the user's button click does", () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    const Thrower = (): never => {
      throw new RateLimitedError(429, 5_000);
    };

    render(
      <ErrorBoundary onReset={onReset}>
        <Thrower />
      </ErrorBoundary>,
    );

    // Advance past the 5s window.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    // The UI is still showing the count-down (now at minimum), and the
    // parent's onReset has not been called.
    expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("'Try again' button calls onReset immediately, without waiting for the count-down", () => {
    const onReset = vi.fn();
    const Thrower = (): never => {
      throw new RateLimitedError(429, 60_000);
    };

    render(
      <ErrorBoundary onReset={onReset}>
        <Thrower />
      </ErrorBoundary>,
    );

    const button = screen.getByRole("button", { name: /try again/i });
    act(() => {
      button.click();
    });

    expect(onReset).toHaveBeenCalledOnce();
  });

  it("a non-rate-limited error still renders the original 'This pane crashed' UI", () => {
    const Thrower = (): never => {
      throw new Error("something else broke");
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("This pane crashed")).toBeInTheDocument();
    expect(screen.queryByText(/too many requests/i)).not.toBeInTheDocument();
  });

  // Issue #1009 — the only diagnostic that used to exist for a crash was
  // console.error, which is useless once the console is gone. This is the
  // actual fix for issue #1: the caught error's message must be visible in
  // the rendered UI, not just logged.
  it("renders the caught error's message in a collapsible detail (issue #1009)", () => {
    const Thrower = (): never => {
      throw new Error("useWorkspacePersistence: layout blob missing sessionIds");
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("useWorkspacePersistence: layout blob missing sessionIds"),
    ).toBeInTheDocument();
  });

  it("crashedTitle/crashedSubtitle/reloadLabel override the pane-scoped defaults (issue #1009)", () => {
    const Thrower = (): never => {
      throw new Error("app-level crash");
    };

    render(
      <ErrorBoundary
        onReset={() => {}}
        crashedTitle="Mullion crashed"
        crashedSubtitle="reload to recover"
        reloadLabel="Reload"
      >
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Mullion crashed")).toBeInTheDocument();
    expect(screen.getByText("reload to recover")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The pane-scoped defaults must NOT also be present — this is a
    // replacement, not an addition.
    expect(screen.queryByText("This pane crashed")).not.toBeInTheDocument();
    expect(screen.queryByText("other panes are unaffected")).not.toBeInTheDocument();
  });

  it("without overrides, every pane-scoped call site keeps its exact prior copy (no unintended default change)", () => {
    const Thrower = (): never => {
      throw new Error("pane crash");
    };

    render(
      <ErrorBoundary onReset={() => {}}>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("This pane crashed")).toBeInTheDocument();
    expect(screen.getByText("other panes are unaffected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload pane" })).toBeInTheDocument();
  });

  it("an error transitioning from RateLimitedError to null clears the timer (no leak)", () => {
    vi.useFakeTimers();
    let shouldThrow = true;
    const onReset = vi.fn(() => {
      // Simulate the parent remounting the subtree: flip the flag so
      // the next render returns successfully.
      shouldThrow = false;
    });
    const Thrower = (): never => {
      if (shouldThrow) throw new RateLimitedError(429, 60_000);
      // After "Try again" succeeds, the boundary renders this — it
      // must not throw.
      throw new Error("unreachable");
    };
    const SafeChild = () => (shouldThrow ? <Thrower /> : <div>recovered</div>);

    render(
      <ErrorBoundary onReset={onReset}>
        <SafeChild />
      </ErrorBoundary>,
    );

    // Timer is running.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Click "Try again" — onReset flips the flag, the next render
    // returns the success branch, and the boundary's error state is
    // cleared (componentDidUpdate fires stopCountdown).
    const button = screen.getByRole("button", { name: /try again/i });
    act(() => {
      button.click();
    });

    expect(vi.getTimerCount()).toBe(0);
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
