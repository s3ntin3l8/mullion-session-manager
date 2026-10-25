// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEVICES_POLL_MS, SidebarDevices } from "./SidebarDevices.js";
import type { Device } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// Issue #1326 — drives the real `devices` store slice against a fake
// GET/POST /api/devices backend, same shape Settings.devices.test.tsx uses
// for the Settings side of this feature. Three things get their own test
// here: a STOPPED row renders (dimmed, with a Start control — the old
// active-only filter is what made a stopped device unreachable from here),
// the Start/Stop controls hit the right endpoints without opening the
// panel, and the poll keeps running at zero devices so an agent-created
// device (no panel ever opened) still shows up.
describe("SidebarDevices (issue #1326)", () => {
  let devicesDb: Device[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];
  // Per-row outage switch: a key here makes that row's next start/stop fail
  // with the mapped message, which is how the per-row error tests below get
  // one row to fail while its neighbour stays healthy.
  let lifecycleFailures: Map<number, string>;

  beforeEach(() => {
    devicesDb = [];
    lifecycleFailures = new Map();

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/devices": () => jsonResponse(200, devicesDb),
      "POST /api/devices/:id/stop": ({ params }) => {
        const id = Number(params.id);
        if (!devicesDb.some((d) => d.id === id)) return jsonResponse(404, { message: "not found" });
        const failure = lifecycleFailures.get(id);
        if (failure) return jsonResponse(500, { message: failure });
        devicesDb = devicesDb.map((d) =>
          d.id === id ? { ...d, status: "killed", live: null } : d,
        );
        return jsonResponse(204);
      },
      "POST /api/devices/:id/start": ({ params }) => {
        const id = Number(params.id);
        const existing = devicesDb.find((d) => d.id === id);
        if (!existing) return jsonResponse(404, { message: "not found" });
        const failure = lifecycleFailures.get(id);
        if (failure) return jsonResponse(500, { message: failure });
        devicesDb = devicesDb.map((d) => (d.id === id ? { ...d, status: "active" } : d));
        return jsonResponse(200, { ...existing, status: "active" });
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ devices: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders nothing when there are no devices", async () => {
    const { container } = render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // The stopped-row invariant this section is built on: a `status: "killed"`
  // row IS a stopped device, so it must render — that is exactly what Start
  // exists for. The section used to filter to active-only, but that filter
  // only existed to hide rows DELETE left behind; DELETE now removes the row
  // outright (routes/devices.ts), so there is nothing left to hide — and a
  // stopped device that didn't show up would be un-startable from here.
  it("renders a stopped (killed) device dimmed, with a Start control and no Stop", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "Old Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const row = await screen.findByTestId("device-row-1");
    expect(row.classList.contains("stopped")).toBe(true);
    expect(within(row).getByTestId("device-start-1")).toBeInTheDocument();
    expect(within(row).queryByTestId("device-stop-1")).not.toBeInTheDocument();
    expect(row.querySelector(".settings-status-dot.off")).not.toBeNull();
  });

  it("renders an active device row and opens it on click", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          kind: "emulator",
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
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: {
          id: "1",
          kind: "emulator",
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
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
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
  // Hard-delete edition: after DELETE, the row is simply GONE from the GET
  // payload, so the section must disappear and STAY gone across several more
  // poll ticks — this is the "deleted device stays in the list" bug's
  // regression test from the sidebar's side (a leftover `devices.length`
  // gate would pass either way; the render gate is what's under test).
  it("stays hidden across several poll intervals after the last device is deleted", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
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

    // Same shape a real DELETE /api/devices/:id leaves behind: the row is
    // removed from the payload entirely.
    devicesDb = [];

    for (let tick = 0; tick < 3; tick++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEVICES_POLL_MS);
      });
      expect(screen.queryByTestId("device-row-1")).not.toBeInTheDocument();
    }
  });

  it("Stop posts to /stop and does NOT open the panel", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    const onOpenDevice = vi.fn();
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={onOpenDevice} />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByTestId("device-stop-1"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/1/stop",
      expect.objectContaining({ method: "POST" }),
    );
    // The action button stops propagation — starting/stopping must not also
    // open (or re-open) the device's panel.
    expect(onOpenDevice).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("device-row-1").classList.contains("stopped")).toBe(true);
    });
  });

  it("Start on a stopped row posts to /start", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    const onOpenDevice = vi.fn();
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={onOpenDevice} />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByTestId("device-start-1"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/1/start",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onOpenDevice).not.toHaveBeenCalled();
  });

  // A failed start/stop still rides on the row's `title` tooltip, which
  // makes the error per-row data: one shared string would put whichever row
  // failed LAST into every other row's tooltip until the next click.
  //
  // The `title` is still there (it is a fine TOOLTIP for the failure), but
  // it is no longer the ONLY place the message appears — see the inline
  // error tests below.
  it("shows a failed stop message only on the row it happened to", async () => {
    const shared = {
      hostId: "local",
      projectId: null,
      kind: "emulator" as const,
      avdName: "pixel_7",
      serial: null,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      live: null,
    };
    devicesDb = [
      { ...shared, id: 1, name: "Broken Pixel" },
      { ...shared, id: 2, name: "Healthy Pixel" },
    ];
    lifecycleFailures.set(1, "adb refused the connection");
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    await screen.findByTestId("device-row-1");
    await user.click(screen.getByTestId("device-stop-1"));

    await waitFor(() => {
      expect(screen.getByTestId("device-row-1").getAttribute("title")).toContain(
        "adb refused the connection",
      );
    });
    const neighbourTitle = screen.getByTestId("device-row-2").getAttribute("title") ?? "";
    expect(neighbourTitle).not.toContain("adb refused the connection");
  });

  // Audit finding 31 — the failure used to live ONLY in the row's `title`
  // tooltip: invisible on a touch device, never announced by a screen
  // reader, and gone the moment the pointer moved away. It is now rendered
  // INLINE, in the row it happened to.
  it("renders a failed start as an inline error inside the row, not only in a title tooltip", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    lifecycleFailures.set(1, "adb refused the connection");
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByTestId("device-start-1"));

    // The message is in the row's own DOM — a text node a screen reader can
    // reach, not just an attribute.
    await waitFor(() => {
      expect(within(row).getByText("adb refused the connection")).toBeInTheDocument();
    });
    // The tooltip is still there too; it is simply no longer the only place
    // the failure is shown.
    expect(row.getAttribute("title")).toContain("adb refused the connection");
  });

  // The error is per-ROW state: it belongs to the row whose start failed
  // and must never leak into a neighbour's row.
  it("keeps a failed start's error on the failing row and off every other row", async () => {
    const shared = {
      hostId: "local",
      projectId: null,
      kind: "emulator" as const,
      avdName: "pixel_7",
      serial: null,
      status: "killed" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      live: null,
    };
    devicesDb = [
      { ...shared, id: 1, name: "Broken Pixel" },
      { ...shared, id: 2, name: "Healthy Pixel" },
    ];
    lifecycleFailures.set(1, "adb refused the connection");
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const failedRow = await screen.findByTestId("device-row-1");
    const healthyRow = screen.getByTestId("device-row-2");
    await user.click(within(failedRow).getByTestId("device-start-1"));

    await waitFor(() => {
      expect(within(failedRow).getByText("adb refused the connection")).toBeInTheDocument();
    });
    expect(within(healthyRow).queryByText("adb refused the connection")).toBeNull();
    expect(healthyRow).not.toHaveTextContent("adb refused the connection");
    // One error, one row: the section renders a single alert.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  // A row's error is its own: it goes away when THAT row succeeds, not
  // when some other row's start succeeds.
  it("clears the row's error once that row's start succeeds", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    lifecycleFailures.set(1, "adb refused the connection");
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByTestId("device-start-1"));
    await waitFor(() => {
      expect(within(row).getByText("adb refused the connection")).toBeInTheDocument();
    });

    // The backend recovers; the same row's next start succeeds.
    lifecycleFailures.delete(1);
    await user.click(screen.getByTestId("device-start-1"));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId("device-row-1")).queryByText("adb refused the connection"),
    ).toBeNull();
  });

  // The failure has to reach assistive technology, not just a `title`
  // attribute: it is an alert in the accessibility tree, the row's own
  // accessible name stays the row's (so the message is not swallowed into
  // the button's name), and the app's permanent live region announces it
  // too — a button's descendants are presentational, so the nested alert
  // alone is not reliably announced.
  it("exposes a failed start to assistive technology, not only through the title tooltip", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "killed",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    lifecycleFailures.set(1, "adb refused the connection");
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={vi.fn()} />);

    const row = await screen.findByTestId("device-row-1");
    await user.click(within(row).getByTestId("device-start-1"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("adb refused the connection");
    expect(alert).toBeInTheDocument();
    // The row's accessible name is the row's own — the failure never
    // becomes part of it.
    expect(row).toHaveAccessibleName("Open device My Pixel");
    // The app-wide announcement channel (the toast slice's live region)
    // carries the failure as well.
    const toasts = useDashboardStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].message).toContain("adb refused the connection");
  });

  // Keyboard parity for the div-row conversion (role="button" + tabIndex +
  // Enter/Space), including the `e.target !== e.currentTarget` guard: a
  // nested action button's own keydown bubbles to the row, and without the
  // guard tabbing to Stop and pressing Enter would BOTH stop the device and
  // open its panel.
  it("Enter on the row opens it, but Enter on the nested action button only runs the action", async () => {
    devicesDb = [
      {
        id: 1,
        hostId: "local",
        projectId: null,
        name: "My Pixel",
        kind: "emulator",
        avdName: "pixel_7",
        serial: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        live: null,
      },
    ];
    const onOpenDevice = vi.fn();
    const user = userEvent.setup();
    render(<SidebarDevices onOpenDevice={onOpenDevice} />);

    const row = await screen.findByTestId("device-row-1");
    row.focus();
    await user.keyboard("{Enter}");
    expect(onOpenDevice).toHaveBeenCalledTimes(1);

    const stopButton = within(row).getByTestId("device-stop-1");
    stopButton.focus();
    await user.keyboard("{Enter}");
    expect(onOpenDevice).toHaveBeenCalledTimes(1); // unchanged — the guard held
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/1/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
