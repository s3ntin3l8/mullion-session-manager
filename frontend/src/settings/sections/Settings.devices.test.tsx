// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import type { Device } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";
import { mockFetch } from "../../test/mockFetch.js";
import { resetStore } from "../../test/resetStore.js";

// Issue #1326 — same fake-in-memory-backend shape as Settings.bridges.test.tsx:
// exercises Settings -> Devices against a fake GET/POST/DELETE /api/devices
// backend (through the real `devices` store slice, not a mocked one), so the
// component/store/api wiring the plan's own risk list calls out is what's
// under test here, not a hand-picked mock.
describe("Settings -> Devices (issue #1326)", () => {
  let devicesDb: Device[];
  let devicesShouldFail: boolean;
  let deviceEnabled: boolean;
  let createCounter: number;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    devicesDb = [];
    devicesShouldFail = false;
    deviceEnabled = true;
    createCounter = 0;

    ({ fetchMock, unexpectedCalls } = mockFetch({
      "GET /api/hosts": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/sessions": () => jsonResponse(200, []),
      "GET /api/devices": () =>
        devicesShouldFail
          ? jsonResponse(500, { message: "internal error" })
          : jsonResponse(200, devicesDb),
      "POST /api/devices": ({ init }) => {
        if (!deviceEnabled) {
          return jsonResponse(400, {
            message: "Device panel is disabled — set DEVICE_ENABLED=true.",
          });
        }
        const body = JSON.parse(init?.body as string) as { avdName: string; name?: string };
        createCounter += 1;
        const device: Device = {
          id: createCounter,
          hostId: "local",
          projectId: null,
          name: body.name ?? null,
          avdName: body.avdName,
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          live: null,
        };
        devicesDb = [...devicesDb, device];
        return jsonResponse(201, device);
      },
      "DELETE /api/devices/:id": ({ params }) => {
        const id = Number(params.id);
        if (!devicesDb.some((d) => d.id === id)) return jsonResponse(404, { message: "not found" });
        // Mirrors routes/devices.ts's own DELETE handler: it flips `status`
        // to "killed" in place, it never removes the row — the killed-row
        // regression test below depends on this exact shape.
        devicesDb = devicesDb.map((d) => (d.id === id ? { ...d, status: "killed" } : d));
        return jsonResponse(204);
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    resetStore({ devices: [] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no device exists", async () => {
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    expect(await screen.findByText(/No Android devices yet/)).toBeInTheDocument();
  });

  it("shows a load error instead of the empty state when the list fetch fails", async () => {
    devicesShouldFail = true;
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    expect(await screen.findByText("Couldn't load devices.")).toBeInTheDocument();
    expect(screen.queryByText(/No Android devices yet/)).not.toBeInTheDocument();
  });

  it("lists a streaming device with its name, avd name, and status", async () => {
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
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    expect(within(row).getByText("My Pixel")).toBeInTheDocument();
    expect(within(row).getByText("pixel_7")).toBeInTheDocument();
    expect(within(row).getByText("streaming")).toBeInTheDocument();
  });

  it("create surfaces the server's DEVICE_ENABLED=false message verbatim", async () => {
    deviceEnabled = false;
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.type(screen.getByPlaceholderText("Pixel_8_API_34"), "pixel_7");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("Device panel is disabled — set DEVICE_ENABLED=true."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // The regression this plan exists to prevent (BridgesSection's own local-
  // state pattern would NOT do this): creating a device from Settings must
  // update the shared `devices` store slice, not a copy local to this
  // component — that's what lets SidebarDevices.tsx's section appear
  // without depending on Settings ever having been open.
  it("creating a device updates the shared store, not just local component state", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    await user.click(await screen.findByText("New device"));
    await user.type(screen.getByPlaceholderText("Pixel_8_API_34"), "pixel_7");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await screen.findByTestId("device-row-1");
    expect(useDashboardStore.getState().devices).toEqual([
      expect.objectContaining({ id: 1, avdName: "pixel_7", status: "active" }),
    ]);
  });

  it("deleting the last active device renders it dimmed instead of removing it", async () => {
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
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="devices" />);

    const row = await screen.findByTestId("device-row-1");
    const deleteButton = within(row).getByRole("button", { name: "Delete" });
    await user.click(deleteButton);
    await user.click(deleteButton);

    await waitFor(() => {
      expect(within(screen.getByTestId("device-row-1")).getByText("stopped")).toBeInTheDocument();
    });
    // Still the SAME row, not removed — Settings is the one surface that
    // shows a killed device's final state (unlike SidebarDevices, which
    // filters it out entirely). No "Delete" button on an already-killed row.
    expect(
      within(screen.getByTestId("device-row-1")).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(useDashboardStore.getState().devices).toEqual([
      expect.objectContaining({ id: 1, status: "killed" }),
    ]);
  });
});
