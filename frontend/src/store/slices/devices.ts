import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import type { DashboardState, DevicesSlice } from "../types.js";

// Android device panel dashboard entry point (issue #1326) — mirrors
// hosts.ts's shape: a flat list refreshed wholesale after every mutation,
// since devices are host-global the same way hosts/bridges are. `devices`
// starts `[]` and is NOT filtered here — a `status: "killed"` row is a
// STOPPED device (still startable), and only a DELETE removes a row
// entirely; both land in this array unfiltered, and each surface picks
// what it shows: SidebarDevices lists everything (with Start/Stop controls),
// DevicesSection (the Settings management surface) is the full lifecycle.
export const createDevicesSlice: StateCreator<DashboardState, [], [], DevicesSlice> = (
  set,
  get,
) => {
  // Self-review (code-review high) — two independent pollers (SidebarDevices
  // + DevicesSection) can each have a refreshDevices() GET in flight at
  // once, and network resolution order doesn't have to match request order:
  // without this guard, a slow response from a poll tick issued BEFORE a
  // create/delete's own follow-up refresh could resolve AFTER it and
  // overwrite the store with stale (pre-mutation) data. Only the most
  // recently ISSUED call's response is ever applied.
  let latestRefreshId = 0;

  // Shared tail for every mutation below: re-fetch, best-effort, so a
  // transient GET failure never masquerades as a mutation failure (the
  // mutation already succeeded server-side by this point) — either poller's
  // next tick heals the store within DEVICES_POLL_MS regardless.
  const refreshAfterMutation = () => {
    void get()
      .refreshDevices()
      .catch(() => {});
  };

  return {
    devices: [],
    devicesLoaded: false,

    refreshDevices: async () => {
      const requestId = ++latestRefreshId;
      const devices = await api.listDevices();
      if (requestId === latestRefreshId) set({ devices, devicesLoaded: true });
    },

    createDevice: async (avdName, name) => {
      const device = await api.createDevice({ avdName, name });
      refreshAfterMutation();
      return device;
    },

    // Passthrough, deliberately NOT stored — the scan results are only ever
    // read by PairDeviceDialog while it's open, never by the sidebar.
    listDiscovered: () => api.listDiscoveredDevices(),

    pairAndConnect: async (body) => {
      // A failed `adb connect` still comes back 201 (the row's own
      // `live.status`/`error` reports it), and every error response has
      // already rolled its row back server-side — so, same as createDevice,
      // only a success has anything new for this refresh to pick up.
      const device = await api.pairAndConnectDevice(body);
      refreshAfterMutation();
      return device;
    },

    startDevice: async (id) => {
      const device = await api.startDevice(id);
      refreshAfterMutation();
      return device;
    },

    stopDevice: async (id) => {
      await api.stopDevice(id);
      refreshAfterMutation();
    },

    deleteDevice: async (id) => {
      await api.deleteDevice(id);
      refreshAfterMutation();
    },

    updateDeviceAddress: async (id, address) => {
      const device = await api.updateDeviceAddress(id, address);
      refreshAfterMutation();
      return device;
    },
  };
};
