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
  // Self-review (code-review high) — several independent pollers
  // (SidebarDevices, DevicesSection and every open DevicePane, #3540) can
  // each have a refreshDevices() GET in flight at once, and network
  // resolution order doesn't have to match request order: without this
  // guard, a slow response from a poll tick issued BEFORE a create/delete's
  // own follow-up refresh could resolve AFTER it and overwrite the store with
  // stale (pre-mutation) data. Two rules:
  // - a response is dropped once a NEWER-issued one has landed. Not "only
  //   the latest issued": with several pollers out of phase a list slower
  //   than the gap between their ticks (a remote host's live() can take up
  //   to its 5 s timeout) would then never land at all (#3540);
  // - a response issued before a mutation's own follow-up refresh is always
  //   dropped (`mutationFloor`), so a stopped or deleted row never comes back
  //   for a moment from a list read before the mutation.
  let latestRefreshId = 0;
  let latestAppliedId = 0;
  let mutationFloor = 0;

  // Shared tail for every mutation below: re-fetch, best-effort, so a
  // transient GET failure never masquerades as a mutation failure (the
  // mutation already succeeded server-side by this point) — either poller's
  // next tick heals the store within DEVICES_POLL_MS regardless.
  const refreshAfterMutation = () => {
    // The id the refreshDevices() call below is about to take.
    mutationFloor = latestRefreshId + 1;
    void get()
      .refreshDevices()
      .catch(() => {});
  };

  return {
    devices: [],
    devicesLoaded: false,
    devicesFetchedAt: 0,

    refreshDevices: async () => {
      const requestId = ++latestRefreshId;
      const requestedAt = Date.now();
      const devices = await api.listDevices();
      if (requestId > latestAppliedId && requestId >= mutationFloor) {
        latestAppliedId = requestId;
        set({ devices, devicesLoaded: true, devicesFetchedAt: requestedAt });
      }
    },

    createDevice: async (avdName, name, hostId) => {
      const device = await api.createDevice({ avdName, name, ...(hostId ? { hostId } : {}) });
      refreshAfterMutation();
      return device;
    },

    createIosDevice: async (udid, name, hostId) => {
      const device = await api.createDevice({
        platform: "ios",
        udid,
        ...(name ? { name } : {}),
        ...(hostId ? { hostId } : {}),
      });
      refreshAfterMutation();
      return device;
    },

    // Passthrough, deliberately NOT stored — the scan results are only ever
    // read by PairDeviceDialog while it's open, never by the sidebar.
    listDiscovered: (hostId) => api.listDiscoveredDevices(hostId),

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
