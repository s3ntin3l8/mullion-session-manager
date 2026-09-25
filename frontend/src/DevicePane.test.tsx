// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicePane } from "./DevicePane.js";
import type { Device } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// The two terminal states the socket can never recover from — STOPPED
// (row exists, status "killed" → routes/device.ts 404s every connect) and
// GONE (row hard-deleted → same 404, nothing left to restart). Without a
// dedicated overlay for each, the pane burns its six reconnect attempts and
// then parks on a generic "Disconnected / Retry now" that no amount of
// retrying fixes. The happy path (an active row) isn't re-tested here — the
// stream itself was never verified end-to-end from a sandbox (no KVM), and
// decoding is the scrcpy library's job, not this component's.

// WebCodecs/decoder plumbing: real @yume-chan would need a live codec, and
// jsdom has no WebCodecs at all. Just enough surface for the effect to run
// (isSupported === true) and to tear itself down cleanly on unmount.
const decoderWriter = {
  write: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
};

const decoderCtor = vi.hoisted(() => vi.fn());

vi.mock("@yume-chan/scrcpy-decoder-webcodecs", () => {
  class WebCodecsVideoDecoder {
    static isSupported = true;
    constructor() {
      decoderCtor();
    }
    writable = { getWriter: () => decoderWriter };
    sizeChanged() {}
    dispose() {}
  }
  class BitmapVideoFrameRenderer {
    constructor(_canvas: unknown) {}
  }
  return { WebCodecsVideoDecoder, BitmapVideoFrameRenderer };
});

// jsdom ships a WebSocket, but it would try to dial a real server. A bare
// recording stub is enough: the pane only ever opens, listens, sends and
// closes. `close()` deliberately does NOT emit a "close" event, so no
// reconnect timer ever gets scheduled behind a test's back.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown = {}) {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }
}

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 7,
    hostId: "local",
    projectId: null,
    name: "My Pixel",
    kind: "emulator",
    avdName: "pixel_7",
    serial: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    live: null,
    ...overrides,
  };
}

describe("DevicePane (issue #1326)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    decoderWriter.write.mockReset();
    decoderWriter.write.mockImplementation(() => Promise.resolve());
    decoderCtor.mockClear();
    decoderWriter.close.mockClear();
    resetStore({ devices: [], devicesLoaded: true });
    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/devices": () => jsonResponse(200, []),
      "POST /api/devices/:id/start": () => jsonResponse(200, makeDevice({ status: "active" })),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows a 'Device stopped' overlay with a Start button when the row is stopped", () => {
    resetStore({ devices: [makeDevice({ status: "killed" })], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);

    expect(screen.getByText("Device stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start device/ })).toBeInTheDocument();
    // Not the generic dead-end: no "Disconnected"/"Retry now" for a state
    // retrying can never fix.
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it("Start posts to /start and reconnects once the row is back", async () => {
    resetStore({ devices: [makeDevice({ status: "killed" })], devicesLoaded: true });
    const user = userEvent.setup();
    render(<DevicePane params={{ deviceId: 7 }} />);

    const initialSockets = FakeWebSocket.instances.length;
    await user.click(screen.getByRole("button", { name: /Start device/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/devices/7/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
    // The row's own refresh brings it back to active, so handleStart's
    // .then() retries the socket instead of waiting out the backoff.
    await waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(initialSockets);
    });
    expect(FakeWebSocket.instances.at(-1)!.url).toContain("/ws/device/7");
  });

  it("disables the Start button and relabels it while the start is in flight", async () => {
    resetStore({ devices: [makeDevice({ status: "killed" })], devicesLoaded: true });
    // The pane itself never fetches — the click's POST /start is the first
    // request. Hold it open so the in-flight state is observable.
    let resolveStart!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolveStart = r)));

    const user = userEvent.setup();
    render(<DevicePane params={{ deviceId: 7 }} />);
    const button = screen.getByRole("button", { name: /Start device/ });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Starting…/ })).toBeDisabled();
    });
    resolveStart(jsonResponse(200, makeDevice({ status: "active" })));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Starting…/ })).not.toBeInTheDocument();
    });
  });

  it("shows a 'deleted' overlay when the row is hard-deleted", () => {
    resetStore({ devices: [], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);

    expect(screen.getByText(/This device was deleted/)).toBeInTheDocument();
    // Nothing to restart from — the row is gone entirely.
    expect(screen.queryByRole("button", { name: /Start device/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  // `devices` starts [] and only the `devicesLoaded` flag says whether that
  // means "deleted" or "not fetched yet" — without the flag every freshly
  // loaded pane would flash the deleted overlay.
  it("does not claim the device is deleted before the list has loaded", () => {
    resetStore({ devices: [], devicesLoaded: false });
    render(<DevicePane params={{ deviceId: 7 }} />);

    expect(screen.queryByText(/This device was deleted/)).not.toBeInTheDocument();
    expect(screen.getByText(/Connecting…/)).toBeInTheDocument();
  });

  it("keeps the connecting overlay for an active row", () => {
    resetStore({ devices: [makeDevice()], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);

    expect(screen.getByText(/Connecting…/)).toBeInTheDocument();
    expect(screen.queryByText("Device stopped")).not.toBeInTheDocument();
    expect(screen.queryByText(/This device was deleted/)).not.toBeInTheDocument();
  });

  // Wire frames (see decodeVideoFrame): [type][flags][payload].
  const keyframe = () => new Uint8Array([1, 1, 9]).buffer;
  const delta = () => new Uint8Array([1, 0, 9]).buffer;

  it("shows 'Waiting for video…' once open, until a keyframe has been decoded", async () => {
    resetStore({ devices: [makeDevice()], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    expect(screen.getByText("Waiting for video…")).toBeTruthy();

    act(() => socket.emit("message", { data: keyframe() }));
    await waitFor(() => expect(screen.queryByText("Waiting for video…")).toBeNull());
  });

  it("rebuilds the decoder and reconnects when a write rejects, ignoring the stale socket", async () => {
    resetStore({ devices: [makeDevice()], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);
    const first = FakeWebSocket.instances[0];
    act(() => first.open());
    expect(decoderCtor).toHaveBeenCalledTimes(1);

    decoderWriter.write.mockImplementationOnce(() => Promise.reject(new Error("bad delta")));
    act(() => first.emit("message", { data: delta() }));
    await waitFor(() => expect(first.readyState).toBe(FakeWebSocket.CLOSED));
    act(() => first.emit("close"));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 2000 });
    expect(decoderCtor).toHaveBeenCalledTimes(2);

    // The replaced socket can no longer reach the new decoder.
    decoderWriter.write.mockClear();
    act(() => first.emit("message", { data: delta() }));
    expect(decoderWriter.write).not.toHaveBeenCalled();
    act(() => first.emit("close"));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("gives up with a visible error after repeated decoder failures with no frame", async () => {
    // Fake (but real-time-advancing) timers so we can jump past the longest
    // backoff and prove no fourth connect is queued, rather than sleeping.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runGiveUpScenario();
    } finally {
      vi.useRealTimers();
    }
  });

  async function runGiveUpScenario() {
    resetStore({ devices: [makeDevice()], devicesLoaded: true });
    render(<DevicePane params={{ deviceId: 7 }} />);
    decoderWriter.write.mockImplementation(() => Promise.reject(new Error("bad delta")));

    for (let i = 0; i < 3; i++) {
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(i + 1), { timeout: 2000 });
      const socket = FakeWebSocket.instances[i];
      act(() => socket.open());
      act(() => socket.emit("message", { data: delta() }));
      await waitFor(() => expect(socket.readyState).toBe(FakeWebSocket.CLOSED));
      act(() => socket.emit("close"));
    }

    expect(await screen.findByText(/Video decoder failed: bad delta/)).toBeTruthy();
    expect(screen.getByText("Disconnected")).toBeTruthy();
    // No fourth connection was scheduled, even past the max backoff (8s).
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
  }
});
