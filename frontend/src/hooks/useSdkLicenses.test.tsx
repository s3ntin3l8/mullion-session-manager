// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSdkLicenses } from "./useSdkLicenses.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  triggerMessage(data: string) {
    this.onmessage?.({ data });
  }
  triggerError() {
    this.onerror?.();
  }
  triggerClose() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.triggerClose();
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost:3000" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSdkLicenses", () => {
  it("accept() opens WS to /ws/sdk-licenses and sends accept-licenses on open", () => {
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:3000/ws/sdk-licenses");

    act(() => ws.triggerOpen());
    expect(ws.sent).toEqual([JSON.stringify({ type: "accept-licenses" })]);
  });

  it("progress messages accumulate in state", () => {
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "Accepting..." })));
    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "All done." })));

    expect(result.current.progress).toEqual(["Accepting...", "All done."]);
    expect(result.current.status).toBe("running");
  });

  it("done message sets status, closes WS, and calls onComplete", () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept(onComplete));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "done" })));

    expect(result.current.status).toBe("done");
    expect(ws.readyState).toBe(3); // CLOSED
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("error message sets error state", () => {
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "error", message: "License failed" })));

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("License failed");
  });

  it("WebSocket error sets error state", () => {
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerError());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("WebSocket connection failed");
  });

  it("reset() clears all state back to idle", () => {
    const { result } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());
    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "line" })));

    act(() => result.current.reset());

    expect(result.current.status).toBe("idle");
    expect(result.current.progress).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("unmount cleanup closes WS", () => {
    const { result, unmount } = renderHook(() => useSdkLicenses());

    act(() => result.current.accept());
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    unmount();

    expect(ws.readyState).toBe(3); // CLOSED
  });
});
