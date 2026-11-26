import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/index.js";
import type { Device } from "../api/index.js";
import { useDashboardStore } from "./index.js";

// refreshDevices' ordering guard (#3540): several pollers (the sidebar and
// every open DevicePane) overlap their GETs, so a response must be dropped
// only when a newer-issued one has already landed — never merely because a
// newer one has been ISSUED, or out-of-phase pollers slower than the poll
// interval would starve the store forever.
function row(id: number): Device {
  return { id, platform: "ios" } as Device;
}

function deferred() {
  let resolve!: (devices: Device[]) => void;
  const promise = new Promise<Device[]>((r) => (resolve = r));
  return { promise, resolve };
}

describe("devices slice: refreshDevices ordering (#3540)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies an older request that lands while a newer one is still in flight", async () => {
    const first = deferred();
    const second = deferred();
    vi.spyOn(api, "listDevices")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useDashboardStore.setState({ devices: [], devicesLoaded: false });
    const { refreshDevices } = useDashboardStore.getState();

    const a = refreshDevices();
    const b = refreshDevices();
    first.resolve([row(3)]);
    await a;

    expect(useDashboardStore.getState().devices).toEqual([row(3)]);
    expect(useDashboardStore.getState().devicesLoaded).toBe(true);

    second.resolve([row(4)]);
    await b;
    expect(useDashboardStore.getState().devices).toEqual([row(4)]);
  });

  it("drops an older response that lands after a newer one was applied", async () => {
    const first = deferred();
    const second = deferred();
    vi.spyOn(api, "listDevices")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useDashboardStore.setState({ devices: [], devicesLoaded: false });
    const { refreshDevices } = useDashboardStore.getState();

    const a = refreshDevices();
    const b = refreshDevices();
    second.resolve([row(4)]);
    await b;
    first.resolve([row(3)]);
    await a;

    expect(useDashboardStore.getState().devices).toEqual([row(4)]);
  });

  it("never applies a list requested before a mutation, even while the mutation's own refresh is pending", async () => {
    const beforeStop = deferred();
    const afterStop = deferred();
    vi.spyOn(api, "listDevices")
      .mockReturnValueOnce(beforeStop.promise)
      .mockReturnValueOnce(afterStop.promise);
    vi.spyOn(api, "stopDevice").mockResolvedValue(undefined as never);
    useDashboardStore.setState({ devices: [row(3)], devicesLoaded: true });
    const { refreshDevices, stopDevice } = useDashboardStore.getState();

    const poll = refreshDevices();
    await stopDevice(3);
    // The pre-stop poll lands first, while the stop's refresh is in flight.
    beforeStop.resolve([{ ...row(3), status: "active" }]);
    await poll;
    expect(useDashboardStore.getState().devices).toEqual([row(3)]);

    afterStop.resolve([{ ...row(3), status: "killed" }]);
    await vi.waitFor(() =>
      expect(useDashboardStore.getState().devices).toEqual([{ ...row(3), status: "killed" }]),
    );
  });
});
