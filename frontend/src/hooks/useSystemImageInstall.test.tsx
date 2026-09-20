// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSystemImageInstall } from "./useSystemImageInstall.js";

// Mock WebSocket that captures constructor args and allows programmatic
// triggering of open/message/error/close events.
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

describe("useSystemImageInstall", () => {
  it("install() opens WS and sends message on open", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:3000/ws/system-image-install");

    act(() => ws.triggerOpen());
    expect(ws.sent).toEqual([
      JSON.stringify({
        type: "install",
        packagePath: "system-images;android-35;google_apis;x86_64",
      }),
    ]);
  });

  it("uninstall() sends uninstall message", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.uninstall("system-images;android-35;google_apis;x86_64"));

    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());
    expect(ws.sent).toEqual([
      JSON.stringify({
        type: "uninstall",
        packagePath: "system-images;android-35;google_apis;x86_64",
      }),
    ]);
  });

  it("progress messages accumulate in state", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "Installing..." })));
    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "Done." })));

    expect(result.current.progress).toEqual(["Installing...", "Done."]);
    expect(result.current.status).toBe("running");
  });

  it("done message sets status and closes WS", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "done" })));

    expect(result.current.status).toBe("done");
    expect(ws.readyState).toBe(3); // CLOSED
  });

  it("error message sets error state", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    act(() => ws.triggerMessage(JSON.stringify({ type: "error", message: "Install failed" })));

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Install failed");
  });

  it("WebSocket error sets error state", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerError());

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("WebSocket connection failed");
  });

  it("reset() clears all state back to idle", () => {
    const { result } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());
    act(() => ws.triggerMessage(JSON.stringify({ type: "progress", message: "line" })));

    act(() => result.current.reset());

    expect(result.current.status).toBe("idle");
    expect(result.current.progress).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("unmount cleanup closes WS", () => {
    const { result, unmount } = renderHook(() => useSystemImageInstall());

    act(() => result.current.install("system-images;android-35;google_apis;x86_64"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.triggerOpen());

    unmount();

    expect(ws.readyState).toBe(3); // CLOSED
  });
});
