// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevicesSidebarView } from "./DevicesSidebarView.js";
import type { RightSidebarActions } from "./views.js";
import type { Device } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

const device = (over: Partial<Device>): Device =>
  ({
    id: 1,
    name: "Pixel",
    avdName: null,
    serial: "emulator-5554",
    status: "active",
    live: { status: "streaming", error: null },
    ...over,
  }) as Device;

describe("DevicesSidebarView (#3012)", () => {
  let db: Device[];
  let failStart = false;
  const onOpenDevice = vi.fn();
  const actions = { onOpenDevice } as unknown as RightSidebarActions;

  beforeEach(() => {
    onOpenDevice.mockClear();
    failStart = false;
    db = [
      device({ id: 1, name: "Pixel" }),
      device({ id: 2, name: "Tablet", status: "killed", live: null }),
    ];
    const { fetchMock } = mockFetch({
      "GET /api/devices": () => jsonResponse(200, db),
      "POST /api/devices/:id/stop": ({ params }) => {
        db = db.map((d) =>
          d.id === Number(params.id) ? { ...d, status: "killed", live: null } : d,
        );
        return jsonResponse(204);
      },
      "POST /api/devices/:id/start": ({ params }) => {
        if (failStart) return jsonResponse(500, { message: "adb refused the connection" });
        db = db.map((d) => (d.id === Number(params.id) ? { ...d, status: "active" } : d));
        return jsonResponse(
          200,
          db.find((d) => d.id === Number(params.id)),
        );
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ devices: db });
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderView = () => render(<DevicesSidebarView projectId={0} actions={actions} />);

  it("lists devices without the left sidebar's section header", async () => {
    renderView();
    expect(await screen.findByTestId("device-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("device-row-2")).toBeInTheDocument();
    expect(document.querySelector(".sidebar-section-header")).toBeNull();
  });

  it("opens a device's screen through actions.onOpenDevice", async () => {
    renderView();
    await userEvent.click(await screen.findByTestId("device-row-1"));
    expect(onOpenDevice).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("stops a running device and starts a stopped one without opening it", async () => {
    renderView();
    await userEvent.click(await screen.findByTestId("device-stop-1"));
    await waitFor(() => expect(db[0].status).toBe("killed"));
    await userEvent.click(await screen.findByTestId("device-start-2"));
    await waitFor(() => expect(db[1].status).toBe("active"));
    expect(onOpenDevice).not.toHaveBeenCalled();
  });

  it("shows a failed start inline on its row", async () => {
    failStart = true;
    renderView();
    await userEvent.click(await screen.findByTestId("device-start-2"));
    expect(await screen.findByRole("alert")).toHaveTextContent("adb refused the connection");
  });

  it("shows an empty state, not a blank view, with no devices", async () => {
    db = [];
    resetStore({ devices: [] });
    renderView();
    expect(await screen.findByText(/No devices yet/)).toBeInTheDocument();
  });

  it("does not claim there are no devices before the first fetch lands", () => {
    db = [];
    resetStore({ devices: [], devicesLoaded: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderView();
    expect(screen.queryByText(/No devices yet/)).toBeNull();
  });
});
