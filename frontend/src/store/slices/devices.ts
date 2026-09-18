import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import type { DashboardState, DevicesSlice } from "../types.js";

// Android device panel dashboard entry point (issue #1326) — mirrors
// hosts.ts's shape: a flat list refreshed wholesale after every mutation,
// since devices are host-global the same way hosts/bridges are. `devices`
// starts `[]` and is NOT filtered here — both a `status: "active"` row and
// a `status: "killed"` one (GET /api/devices never drops killed rows, see
// routes/devices.ts) land in this array unfiltered. SidebarDevices.tsx
// filters to active-only for its render/poll gate; DevicesSection.tsx (the
// Settings management surface) intentionally shows killed rows too.
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

  return {
    devices: [],

    refreshDevices: async () => {
      const requestId = ++latestRefreshId;
      const devices = await api.listDevices();
      if (requestId === latestRefreshId) set({ devices });
    },

    createDevice: async (avdName, name) => {
      const device = await api.createDevice({ avdName, name });
      // Same "best-effort, don't let a refresh failure masquerade as a
      // mutation failure" shape as projects.ts's own createProject — the
      // create itself already succeeded server-side by this point, and
      // awaiting would fail createDevice's own promise (surfacing a
      // misleading "could not create this device" to DevicesSection) on a
      // transient failure of this GET alone. Either poller's next tick
      // heals the store within DEVICES_POLL_MS regardless.
      void get()
        .refreshDevices()
        .catch(() => {});
      return device;
    },

    terminateDevice: async (id) => {
      await api.terminateDevice(id);
      // Same reasoning as createDevice above.
      void get()
        .refreshDevices()
        .catch(() => {});
    },
  };
};
