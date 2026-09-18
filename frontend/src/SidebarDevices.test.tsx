// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEVICES_POLL_MS, SidebarDevices } from "./SidebarDevices.js";
import type { Device } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// Issue #1326 — drives the real `devices` store slice against a fake
// GET /api/devices backend, same shape Settings.devices.test.tsx uses for
// the Settings side of this feature. The two regressions the plan calls out
// by name both get their own test here: a killed row must never render (or
// count) in the sidebar, and the poll must keep running at zero devices so
// an agent-created device (no panel ever opened) still shows up.
describe("SidebarDevices (issue #1326)", () => {
  let devicesDb: Device[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    devicesDb = [];

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/devices": () => jsonResponse(200, devicesDb),
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ devices: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders nothing when there are no active devices", async () => {
    const { container } = render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // The killed-row regression: GET /api/devices never drops a killed row
  // (routes/devices.ts's DELETE only flips `status`), so an implementation
  // that renders `devices` unfiltered would show this device forever.
  it("excludes a killed device from both the render and the count", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "Old Pixel",
        avdName: "pixel_7",
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    const { container } = render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("device-row-1")).not.toBeInTheDocument();
  });

  it("renders an active device row and opens it on click", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        avdName: "pixel_7",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          avdName: "pixel_7",
          label: "My Pixel",
          status: "streaming",
          serial: "emulator-5554",
          error: null,
        },
      },
    ];
    const onOpenDevice = vi.fn();
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={onOpenDevice} />);

    const row = await screen.findByTestId("device-row-1");
    expect(row).toHaveTextContent("My Pixel");
    expect(row.querySelector(".settings-status-dot.on")).not.toBeNull();

    await user.click(row);
    expect(onOpenDevice).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("shows the warn dot while a device is booting", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        avdName: "pixel_7",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          avdName: "pixel_7",
          label: "My Pixel",
          status: "booting",
          serial: null,
          error: null,
        },
      },
    ];
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const row = await screen.findByTestId("device-row-1");
    expect(row.querySelector(".settings-status-dot.warn")).not.toBeNull();
  });

  // The poll-gating regression: PR #1324 built the CLI/MCP surface so an
  // agent can create a device with no panel ever open — gating this poll on
  // `devices.length > 0` would mean a human's sidebar stays blank until a
  // manual reload once that happens.
  it("keeps polling at zero devices, so an out-of-band create appears without a reload", async () => {
    vi.useFakeTimers();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("device-row-1")).not.toBeInTheDocument();

    // Simulate `mullion device create` landing out-of-band, with no panel
    // ever opened and no re-render triggered from this component's side.
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "Agent Pixel",
        avdName: "pixel_7",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEVICES_POLL_MS);
    });
    // A synchronous query, not findByTestId — the update is already flushed
    // by the time the awaited act() block above resolves, and findBy*'s own
    // internal polling relies on real timers, which are stubbed out here.
    expect(screen.getByTestId("device-row-1")).toBeInTheDocument();
  });

  // The killed-row regression, poll edition: deleting the last device must
  // make the section disappear and STAY gone across several more poll
  // ticks — a naive `devices.length` gate (no active-status filter) would
  // resurrect the row on the very next poll, since GET /api/devices still
  // returns it with `status: "killed"`.
  it("stays hidden across several poll intervals after the last device is deleted", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        avdName: "pixel_7",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    vi.useFakeTimers();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("device-row-1")).toBeInTheDocument();

    // Same shape a real DELETE /api/devices/:id leaves behind — flips
    // `status`, the row stays in the GET payload.
    devicesDb = devicesDb.map((d) => ({ ...d, status: "killed" }));

    for (let tick = 0; tick < 3; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEVICES_POLL_MS);
      });
      expect(screen.queryByTestId("device-row-1")).not.toBeInTheDocument();
    }
  });
});
