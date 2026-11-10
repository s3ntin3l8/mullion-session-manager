// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import type { Device } from "../api/index.js";
import { useCloseMissingDevicePanels } from "./useCloseMissingDevicePanels.js";

function device(id: number): Device {
  return {
    id,
    hostId: "local",
    projectId: null,
    name: null,
    kind: "physical",
    avdName: null,
    serial: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    live: null,
  };
}

function panel(id: string) {
  const close = vi.fn();
  return { id, close, api: { close } };
}

function makeApi(panels: ReturnType<typeof panel>[]) {
  return {
    panels,
    getPanel: (id: string) => panels.find((item) => item.id === id),
  } as unknown as DockviewApi;
}

describe("useCloseMissingDevicePanels", () => {
  it("does nothing without a dock, or before the device list has loaded", () => {
    const orphan = panel("device-2");
    const api = makeApi([orphan]);
    renderHook(() =>
      useCloseMissingDevicePanels({ devices: [], devicesLoaded: true, dockviewApi: null }),
    );
    renderHook(() =>
      useCloseMissingDevicePanels({
        devices: [],
        devicesLoaded: false,
        dockviewApi: api,
      }),
    );
    expect(orphan.close).not.toHaveBeenCalled();
  });

  it("closes panels whose device row is gone and leaves the rest", () => {
    const kept = panel("device-1");
    const missing = panel("device-2");
    const notADevice = panel("session-2");
    const malformed = panel("device-abc");
    const api = makeApi([kept, missing, notADevice, malformed]);
    renderHook(() =>
      useCloseMissingDevicePanels({
        devices: [device(1)],
        devicesLoaded: true,
        dockviewApi: api,
      }),
    );
    expect(kept.close).not.toHaveBeenCalled();
    expect(missing.close).toHaveBeenCalledTimes(1);
    expect(notADevice.close).not.toHaveBeenCalled();
    expect(malformed.close).not.toHaveBeenCalled();
  });
});
