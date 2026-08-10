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

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  send() {}

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
  // refreshGitRefs' own ~60s throttle next fired.
  it("refreshes prsByProject (not just prsRefreshTrigger) on a message carrying a projectId", () => {
    const refreshGitRefs = vi.fn(async () => {});
    useDashboardStore.setState({ refreshGitRefs });
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();

    instances[0].__message(JSON.stringify({ projectId: 1 }));

    expect(refreshGitRefs).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().prsRefreshTrigger).toBe(1);

    stop();
  });

  it("does not refresh on a message with no projectId", () => {
    const refreshGitRefs = vi.fn(async () => {});
    useDashboardStore.setState({ refreshGitRefs });
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();

    instances[0].__message(JSON.stringify({ type: "ping" }));

    expect(refreshGitRefs).not.toHaveBeenCalled();

    stop();
  });

  it("ignores a malformed frame without throwing", () => {
    const stop = useDashboardStore.getState().connectGitHubWS();
    instances[0].__open();

    expect(() => instances[0].__message("not json")).not.toThrow();

    stop();
  });
});
