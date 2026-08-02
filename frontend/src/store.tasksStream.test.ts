// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store.js";

// #488's /ws/tasks integration — mirrors store.events.test.ts's convention:
// mock the platform WebSocket (not tasksClient.ts itself) so this exercises
// the real connect/debounce/reconnect logic end to end, plus a mocked
// fetch so the debounced refreshTasks() call this channel triggers can be
// observed without a real backend.

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
  private listeners: Record<string, Array<(event: { data?: unknown }) => void>> = {};

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  send() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  __open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open", {});
  }

  __message(data: unknown) {
    this.dispatch("message", { data });
  }

  private dispatch(type: string, event: { data?: unknown }) {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

let instances: MockWebSocket[] = [];

function jsonResponse(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { "content-type": "application/json" },
  });
}

describe("store /ws/tasks integration (#488)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tasksCalls: number;

  beforeEach(() => {
    instances = [];
    tasksCalls = 0;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/tasks") {
        tasksCalls++;
        return jsonResponse(200, []);
      }
      if (url === "/api/server-info") {
        return jsonResponse(200, { taskMasterEnabled: false, taskMasterEnv: null });
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ tasks: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects exactly one WebSocket to /ws/tasks on startTasksStream()", () => {
    const stop = useDashboardStore.getState().startTasksStream();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toMatch(/\/ws\/tasks$/);
    stop();
  });

  it("debounces a live transition frame into a single refreshTasks() call", async () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startTasksStream();
    instances[0].__open();

    instances[0].__message(
      JSON.stringify({
        taskId: 1,
        projectId: 1,
        kind: "transition",
        from: "ready",
        to: "claimed",
        ts: 1,
      }),
    );
    instances[0].__message(
      JSON.stringify({
        taskId: 2,
        projectId: 1,
        kind: "transition",
        from: "claimed",
        to: "reviewing",
        ts: 2,
      }),
    );

    expect(tasksCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(tasksCalls).toBe(1);

    stop();
  });

  it("ignores a malformed frame without throwing", () => {
    const stop = useDashboardStore.getState().startTasksStream();
    instances[0].__open();

    expect(() => instances[0].__message("not json")).not.toThrow();
    expect(() => instances[0].__message(JSON.stringify({ foo: "bar" }))).not.toThrow();

    stop();
  });

  it("reconnects on close with capped exponential backoff", () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startTasksStream();
    expect(instances).toHaveLength(1);

    instances[0].close();
    vi.advanceTimersByTime(500);
    expect(instances).toHaveLength(2);

    stop();
  });

  it("stops reconnecting once the returned cleanup runs", () => {
    vi.useFakeTimers();
    const stop = useDashboardStore.getState().startTasksStream();
    expect(instances).toHaveLength(1);

    stop();
    instances[0].close();
    vi.advanceTimersByTime(10_000);
    expect(instances).toHaveLength(1);
  });
});
