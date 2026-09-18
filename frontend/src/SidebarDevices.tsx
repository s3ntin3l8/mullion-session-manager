import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import type { Device } from "./api/index.js";
import { deviceDotClass } from "./deviceStatus.js";
import { usePolling } from "./hooks/usePolling.js";
import { DeviceIcon } from "./ui/icons.js";

// Sidebar entry point for the Android device panel (issue #1326) — mirrors
// the standalone Tasks button's "host-global thing above the Projects
// section" precedent (see the `.sidebar-tasks-entry` block this reuses in
// styles/empty-states.css), not Settings -> Hosts/Bridges: opening a
// device's screen is an everyday action, and Settings is a modal that owns
// no DockviewApi (see DevicesSection.tsx's own header comment on why
// create/delete live there instead).
//
// Deliberately its own component rather than folded into the
// already-1981-line Sidebar.tsx.
export const DEVICES_POLL_MS = 4000;

// GET /api/devices (routes/devices.ts) never drops a killed row — DELETE
// only flips `status` to "killed", the row stays forever (same "DB row is
// intent" shape sessions.status has). Filtering to "active" here is what
// keeps a deleted device from both re-appearing after the optimistic
// removal's next poll AND keeping this whole section pinned open once any
// device has ever been deleted. DevicesSection.tsx (Settings) intentionally
// does NOT apply this filter — it's the management surface and shows a
// killed device's final state.
function activeDevices(devices: Device[]): Device[] {
  return devices.filter((d) => d.status === "active");
}

export function SidebarDevices({ onOpenDevice }: { onOpenDevice: (device: Device) => void }) {
  const devices = useDashboardStore(useShallow((s) => activeDevices(s.devices)));
  const refreshDevices = useDashboardStore((s) => s.refreshDevices);

  // Poll unconditionally, even with zero active devices — there is no
  // device event in the event stream (store/slices/events.ts carries none),
  // and PR #1324 explicitly built the CLI/MCP surface so an agent can
  // create/drive a device with no panel open at all. Gating this poll on
  // `devices.length > 0` would mean a human's sidebar stays blank after an
  // agent runs `mullion device create` until a manual reload — the
  // no-clutter goal is served entirely by the render gate below, not by
  // disabling the fetch. `immediate` defaults to true, so this also covers
  // the mount-time fetch — no separate effect needed.
  //
  // Hermes review (PR #1341) — `.catch` is required here, not optional:
  // this component is always mounted (unlike DevicesSection, only mounted
  // while Settings is open), so an uncaught rejection on a transient
  // /api/devices failure (e.g. a server restart) would otherwise fire every
  // DEVICES_POLL_MS for as long as the tab stays visible.
  usePolling(() => refreshDevices().catch(() => {}), DEVICES_POLL_MS, {
    pauseWhenHidden: true,
    deps: [refreshDevices],
  });

  if (devices.length === 0) return null;

  return (
    <div className="sidebar-devices">
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Devices</span>
      </div>
      {devices.map((device) => (
        <button
          key={device.id}
          className="sidebar-tasks-entry"
          data-testid={`device-row-${device.id}`}
          title={device.live?.error ?? undefined}
          onClick={() => onOpenDevice(device)}
        >
          <DeviceIcon size={14} />
          <span className="sidebar-tasks-entry-label">{device.name || device.avdName}</span>
          <span className={`settings-status-dot ${deviceDotClass(device)}`} />
        </button>
      ))}
    </div>
  );
}
