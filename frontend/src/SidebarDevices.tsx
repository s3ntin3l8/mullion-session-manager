import { useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import type { Device } from "./api/index.js";
import { deviceDotClass } from "./deviceStatus.js";
import { usePolling } from "./hooks/usePolling.js";
import { DeviceIcon, PlayIcon, StopIcon } from "./ui/icons.js";

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

export function SidebarDevices({ onOpenDevice }: { onOpenDevice: (device: Device) => void }) {
  // Unfiltered, deliberately: a `status: "killed"` row is a STOPPED device,
  // which is exactly what Start exists for. This used to filter to
  // active-only, but that filter only existed to hide rows DELETE left
  // behind — DELETE now removes the row outright (routes/devices.ts), so
  // there is nothing left to hide and a stopped device that no longer shows
  // up would be un-startable from here. Settings -> Devices remains the
  // management surface (create/pair/edit-address/delete); this section is
  // start/stop + open.
  const devices = useDashboardStore(useShallow((s) => s.devices));
  const refreshDevices = useDashboardStore((s) => s.refreshDevices);
  const startDevice = useDashboardStore((s) => s.startDevice);
  const stopDevice = useDashboardStore((s) => s.stopDevice);
  // One lifecycle call at a time, keyed by row id: both control buttons on
  // the in-flight row (and every other row's, so a slow `start` can't be
  // raced by a second click) disable until it resolves. Local, not store —
  // only this surface ever needs the notion.
  const [pendingId, setPendingId] = useState<number | null>(null);
  // No inline error slot in this section (DevicesSection has one under its
  // table; a sidebar row has nowhere to put a second line without shifting
  // the whole column) — so the failure rides on the row's `title` instead,
  // next to the device's own live error.
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  // Poll unconditionally, even with zero devices — there is no
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

  const runLifecycle = async (device: Device, kind: "start" | "stop") => {
    if (pendingId !== null) return;
    setPendingId(device.id);
    setLifecycleError(null);
    try {
      if (kind === "start") await startDevice(device.id);
      else await stopDevice(device.id);
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="sidebar-devices">
      <div className="sidebar-section-header">
        <span className="sidebar-section-title">Devices</span>
      </div>
      {devices.map((device) => {
        const stopped = device.status === "killed";
        const label = device.name || device.avdName || device.serial;
        const title =
          lifecycleError ??
          (stopped ? "Stopped — click to start" : (device.live?.error ?? undefined));
        return (
          // role/tabIndex/Enter-Space + `e.target !== e.currentTarget`, same
          // P10 pattern as Sidebar.tsx's SessionRow/project-row-header (see
          // that row's comment for the full rationale): this row nests a
          // real <button> below, whose keydown would otherwise bubble here
          // and open the panel when the user meant to start/stop it.
          <div
            key={device.id}
            className={`sidebar-tasks-entry${stopped ? " stopped" : ""}`}
            data-testid={`device-row-${device.id}`}
            role="button"
            tabIndex={0}
            title={title}
            onClick={() => onOpenDevice(device)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenDevice(device);
              }
            }}
          >
            <DeviceIcon size={14} />
            <span className="sidebar-tasks-entry-label">{label}</span>
            <span className={`settings-status-dot ${deviceDotClass(device)}`} />
            <span className="device-row-actions">
              {stopped ? (
                <button
                  type="button"
                  data-testid={`device-start-${device.id}`}
                  aria-label={`Start ${label}`}
                  title="Start"
                  disabled={pendingId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    void runLifecycle(device, "start");
                  }}
                >
                  <PlayIcon size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`device-stop-${device.id}`}
                  aria-label={`Stop ${label}`}
                  title="Stop"
                  disabled={pendingId !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    void runLifecycle(device, "stop");
                  }}
                >
                  <StopIcon size={13} />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
