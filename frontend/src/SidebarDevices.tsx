import { useState } from "react";
import { useDashboardStore } from "./store/index.js";
import { useShallow } from "zustand/react/shallow";
import type { Device } from "./api/index.js";
import { deviceDotClass } from "./deviceStatus.js";
import { usePolling } from "./hooks/usePolling.js";
import { describeError } from "./lib/describeError.js";
import { ErrorText } from "./ui/ErrorText.js";
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

// The row's label, in the order every other device surface uses it (name →
// AVD name → serial). One helper, so the row's visible text, its accessible
// name and the failure message below all name the SAME device.
function deviceLabel(device: Device): string | null {
  return device.name || device.avdName || device.serial;
}

// What to CALL the device when it is spoken — an aria-label, a failure
// message. A device with no name, no AVD name and no serial is possible in
// the type, and "null" is not a word anyone can hear.
function deviceSpokenName(device: Device): string {
  // `||`, not `??`: deviceLabel's own `||` chain can still return an EMPTY
  // string — a device whose name, AVD name and serial are all empty
  // strings falls through the chain to the last one — and an empty
  // accessible name is worse than the generic one, not better. It is the
  // exact case this helper exists to prevent.
  return deviceLabel(device) || "device";
}

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
  // A failed start/stop is rendered INLINE, under the row it happened to.
  // It used to ride on the row's `title` tooltip alone — invisible on a
  // touch device, never announced by a screen reader, and gone the moment
  // the pointer moved away (audit finding 31). The old comment here
  // ("a sidebar row has nowhere to put a second line") described the
  // defect, not a constraint: the row now makes room for one, and only the
  // failing row does.
  //
  // Keyed BY ROW: the message belongs to the row that failed, so it is
  // read per row below and can never leak into another row's line (a
  // single shared string would put whichever row failed LAST into every
  // other row).
  const [lifecycleError, setLifecycleError] = useState<{ id: number; message: string } | null>(
    null,
  );

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
    // Clear THIS row's error only. Another row's failure stays on its own
    // row — the error is per-row state, so it is cleared per row too.
    setLifecycleError((prev) => (prev?.id === device.id ? null : prev));
    try {
      if (kind === "start") await startDevice(device.id);
      else await stopDevice(device.id);
    } catch (err) {
      const message = describeError(err);
      setLifecycleError({ id: device.id, message });
      // Two surfaces, two jobs. The inline error below is the ROW-scoped
      // one: it stays on the row that failed until that row succeeds
      // again. This is the app-wide ANNOUNCEMENT channel — the toast
      // slice's live region (store/slices/toasts.ts, rendered by
      // ui/ToastHost.tsx), the same pattern PaneTab.tsx and
      // WorkspaceSwitcher.tsx use. It has to be a separate surface
      // because this row is a role="button", and a button's descendants
      // are presentational (ARIA): the nested alert below is exposed in
      // the accessibility tree but is not reliably announced on its own,
      // while a live region outside the button is.
      useDashboardStore
        .getState()
        .reportError(`Could not ${kind} ${deviceSpokenName(device)}.`, message);
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
        const label = deviceLabel(device);
        // This row's own failure, or nothing — never another row's.
        const rowError = lifecycleError?.id === device.id ? lifecycleError.message : null;
        const title =
          rowError ?? (stopped ? "Stopped — click to start" : (device.live?.error ?? undefined));
        return (
          // role/tabIndex/Enter-Space + `e.target !== e.currentTarget`, same
          // P10 pattern as Sidebar.tsx's SessionRow/project-row-header (see
          // that row's comment for the full rationale): this row nests a
          // real <button> below, whose keydown would otherwise bubble here
          // and open the panel when the user meant to start/stop it.
          <div
            key={device.id}
            // `sidebar-device-row-wrap` only rides along when this row has
            // an error line to make room for — a row without one keeps the
            // exact layout it always had (see styles/sidebar.css).
            className={`sidebar-tasks-entry${stopped ? " stopped" : ""}${
              rowError ? " sidebar-device-row-wrap" : ""
            }`}
            data-testid={`device-row-${device.id}`}
            role="button"
            tabIndex={0}
            // An explicit name, so the inline error below is never swallowed
            // into the button's accessible name (name-from-content would
            // otherwise read "My Pixel Stop My Pixel adb refused the
            // connection" as one string). Same convention as Sidebar.tsx's
            // SessionRow (`Open session …`) and NotificationBell's
            // EventRow — the row names itself, its content does not.
            aria-label={`Open device ${deviceSpokenName(device)}`}
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
            {/* The failure, inline and IN the row — the same presentation
                Settings -> Devices gives its own errors under its table
                (ErrorText: role="alert", so assistive tech announces it
                and it does not rely on colour alone). */}
            {rowError && <ErrorText className="sidebar-device-error">{rowError}</ErrorText>}
          </div>
        );
      })}
    </div>
  );
}
