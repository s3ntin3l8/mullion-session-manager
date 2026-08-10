// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store.js";

// /ws/github integration — mirrors store.tasksStream.test.ts's own
// convention (mock the platform WebSocket, not a client wrapper), but
// connectGitHubWS assigns onopen/onmessage/onclose/onerror as properties
// rather than using addEventListener, so this mock matches that shape
// instead of tasksStream's listener-array one.
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  // A spy (not a bare no-op) — P12's subscribe/unsubscribe tests below need
  // to assert on the exact frames sent.
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  __open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  __message(data: unknown) {
    this.onmessage?.({ data });
  }
}

let instances: MockWebSocket[] = [];

describe("store /ws/github integration", () => {
  beforeEach(() => {
    instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects exactly one WebSocket to /ws/github on connectGitHubWS()", () => {
    const stop = useDashboardStore.getState().connectGitHubWS();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toMatch(/\/ws\/github$/);
    stop();
  });

  // The bug this pass fixes: prsRefreshTrigger alone only ever reaches
  // GitHubPanel's own effect dependency — every other consumer
  // (Sidebar's SessionRow, UnifiedBoard's TaskCard, TaskDetail) reads
  // prsByProject directly and previously only saw a real GitHub push after
  // refreshGitRefs' own ~60s throttle next fired. Debounced (Hermes review,
  // PR #577/#580 — refreshGitRefs itself has no time throttle, only
  // in-flight dedup, so a burst of events would otherwise fire one refetch
  // per event) — same shape as store.tasksStream.test.ts's own debounce test.
  it("refreshes prsByProject (not just prsRefreshTrigger) on a message carrying a projectId", async () => {
    vi.useFakeTimers();
    const refreshGitRefs = vi.fn(async () => {});
    useDashboardStore.setState({ refreshGitRefs });
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();
    const triggerBefore = useDashboardStore.getState().prsRefreshTrigger;

    instances[0].__message(JSON.stringify({ projectId: 1 }));

    expect(refreshGitRefs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshGitRefs).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().prsRefreshTrigger).toBe(triggerBefore + 1);

    stop();
  });

  it("debounces a burst of messages (e.g. a check suite's started/completed events) into a single refresh", async () => {
    vi.useFakeTimers();
    const refreshGitRefs = vi.fn(async () => {});
    useDashboardStore.setState({ refreshGitRefs });
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();
    const triggerBefore = useDashboardStore.getState().prsRefreshTrigger;

    instances[0].__message(JSON.stringify({ projectId: 1 }));
    instances[0].__message(JSON.stringify({ projectId: 1 }));
    instances[0].__message(JSON.stringify({ projectId: 1 }));

    await vi.advanceTimersByTimeAsync(300);
    expect(refreshGitRefs).toHaveBeenCalledTimes(1);
    // prsRefreshTrigger itself is NOT debounced — every message still bumps
    // it, since GitHubPanel's own effect is cheap and unrelated to the
    // refetch cost this debounce protects against.
    expect(useDashboardStore.getState().prsRefreshTrigger).toBe(triggerBefore + 3);

    stop();
  });

  it("does not refresh on a message with no projectId", async () => {
    vi.useFakeTimers();
    const refreshGitRefs = vi.fn(async () => {});
    useDashboardStore.setState({ refreshGitRefs });
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();

    instances[0].__message(JSON.stringify({ type: "ping" }));
    await vi.advanceTimersByTimeAsync(300);

    expect(refreshGitRefs).not.toHaveBeenCalled();

    stop();
  });

  it("ignores a malformed frame without throwing", () => {
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();

    expect(() => instances[0].__message("not json")).not.toThrow();

    stop();
  });

  // P12 — unsubscribeFromGitHubProject used to only delete the local
  // gitHubWSSubscriptions entry; the server was never told, so it kept
  // pushing events for a project whose UI section had already unmounted.
  // Mirrors subscribeToGitHubProject's own frame shape/send mechanism (see
  // that action right above this one in store.ts).
  describe("P12 — subscribe/unsubscribe frames", () => {
    it("sends a subscribe frame immediately when the socket is already open", () => {
      const stop = useDashboardStore.getState().connectGitHubWS();
      instances[0].__open();
      instances[0].send.mockClear();

      useDashboardStore.getState().subscribeToGitHubProject(7);

      expect(instances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: "subscribe", projectId: 7 }),
      );

      stop();
    });

    it("sends an unsubscribe frame mirroring the subscribe frame's shape", () => {
      const stop = useDashboardStore.getState().connectGitHubWS();
      instances[0].__open();
      useDashboardStore.getState().subscribeToGitHubProject(7);
      instances[0].send.mockClear();

      useDashboardStore.getState().unsubscribeFromGitHubProject(7);

      expect(instances[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: "unsubscribe", projectId: 7 }),
      );

      stop();
    });

    it("does not throw when unsubscribing while the socket isn't open yet", () => {
      const stop = useDashboardStore.getState().connectGitHubWS();
      // Deliberately no __open() — readyState stays CONNECTING.

      expect(() => useDashboardStore.getState().unsubscribeFromGitHubProject(7)).not.toThrow();
      expect(instances[0].send).not.toHaveBeenCalled();

      stop();
    });

    it("a fresh connection's re-subscribe no longer includes a project that was unsubscribed", () => {
      // connectGitHubWS's own onopen replays every project still in the
      // local gitHubWSSubscriptions set (see store.ts) — this is what
      // proves unsubscribeFromGitHubProject's local `.delete(projectId)`
      // (unchanged by this fix) and its new frame-send are both still
      // correct together: project 7 must be gone from BOTH.
      const stop = useDashboardStore.getState().connectGitHubWS();
      instances[0].__open();
      useDashboardStore.getState().subscribeToGitHubProject(7);
      useDashboardStore.getState().unsubscribeFromGitHubProject(7);
      stop();

      // A fresh connection (e.g. after a reconnect) re-subscribes every
      // project still in the local set on its own open.
      const stop2 = useDashboardStore.getState().connectGitHubWS();
      instances[1].__open();

      const subscribedProjectIds = instances[1].send.mock.calls
        .map((call) => JSON.parse(call[0] as string) as { type: string; projectId: number })
        .filter((frame) => frame.type === "subscribe")
        .map((frame) => frame.projectId);
      expect(subscribedProjectIds).not.toContain(7);

      stop2();
    });
  });
});
