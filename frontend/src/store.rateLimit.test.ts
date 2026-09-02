// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardStore } from "./store/index.js";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import { __resetSessionRefreshBlockForTests } from "./store/slices/sessions.js";
import { jsonResponse } from "./test/jsonResponse.js";

// Regression coverage for issue #959: a 429 on the live sessions poll must
// not flip `backendReachable` (it's not a transport failure), and the next
// 4s tick of startLiveRefresh must skip its cascade (refreshSessions +
// refreshGitStatuses + refreshGitDiffStats, all sharing the same 100/min
// bucket) until Retry-After elapses. Without this, a reload that lands on
// a still-blocked bucket turns into a 4s-cadence 429 storm that itself
// keeps the bucket blocked indefinitely.
describe("store / 429 backoff on the live sessions poll (issue #959)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetRateLimitBreakerForTests();
    __resetSessionRefreshBlockForTests();
    useDashboardStore.setState({
      sessions: [],
      sessionsLoaded: false,
      backendReachable: true,
      sessionExpired: false,
      projects: [],
      gitStatuses: {},
      gitDiffStats: {},
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function rateLimitedResponse(retryAfterSeconds: number): Response {
    return new Response(JSON.stringify({ message: "Too Many Requests" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      },
    });
  }

  it("a 429 on refreshSessions does NOT flip backendReachable", async () => {
    fetchMock.mockResolvedValue(rateLimitedResponse(60));

    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow(/Rate limited/);

    // A 429 is not a transport failure — the "Mullion server unreachable"
    // banner's subtext and Reconnect button both assume a real outage,
    // neither of which is true here. The breaker in api/client.ts owns the
    // "wait N ms and try again" semantics; the live poll is just
    // short-circuiting until that timer elapses.
    expect(useDashboardStore.getState().backendReachable).toBe(true);
    expect(useDashboardStore.getState().sessionExpired).toBe(false);
  });

  it("a 429 on refreshSessions does NOT increment consecutiveSessionFetchFailures", async () => {
    fetchMock.mockResolvedValue(rateLimitedResponse(60));

    // Two consecutive 429s should still leave backendReachable: true —
    // a 429 must not contribute to the threshold that flips the
    // genuine-outage banner.
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow(/Rate limited/);
    await expect(useDashboardStore.getState().refreshSessions()).rejects.toThrow(/Rate limited/);

    expect(useDashboardStore.getState().backendReachable).toBe(true);
  });

  it("startLiveRefresh skips the cascade while a Retry-After window is active", async () => {
    vi.useFakeTimers();
    let sessionsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) {
        sessionsCalls++;
        return rateLimitedResponse(60);
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });

    // Start the live refresh. The first tick fires listSessions (which
    // 429s and sets the block).
    const stop = useDashboardStore.getState().startLiveRefresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionsCalls).toBe(1);

    // Advance to the next 4s tick. While the 429's Retry-After is still
    // in the future, the cascade must be skipped entirely — the previous
    // 429 is the reason the bucket is blocked, and hammering it would
    // only extend the block.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessionsCalls).toBe(1);

    // After Retry-After elapses, the next tick goes through and 429s
    // again (extending the block).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionsCalls).toBe(2);

    stop();
  });

  it("startLiveRefresh resumes normal cadence after a successful refresh", async () => {
    vi.useFakeTimers();
    let sessionsCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) {
        sessionsCalls++;
        if (sessionsCalls === 1) return rateLimitedResponse(5);
        return jsonResponse(200, []);
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });

    const stop = useDashboardStore.getState().startLiveRefresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionsCalls).toBe(1);

    // The 2nd tick is scheduled at t=4000. While the 5s block is active
    // (Date.now() < blockedUntil), the tick is skipped — the cascade
    // doesn't fire.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessionsCalls).toBe(1);

    // The 3rd tick is at t=8000 — past the 5s block. The cascade fires
    // and the second call resolves with an empty list. The next tick
    // (t=12000) also fires normally.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessionsCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessionsCalls).toBe(3);

    stop();
  });
});
