import { useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { useShallow } from "zustand/react/shallow";
import { ApiError } from "../../api/index.js";
import type { Device } from "../../api/index.js";
import { deviceDotClass } from "../../deviceStatus.js";
import { usePolling } from "../../hooks/usePolling.js";
import { DEVICES_POLL_MS } from "../../SidebarDevices.js";
import {
  AddButton,
  GroupHeading,
  ListRow,
  Row,
  SecondaryButton,
  StyledList,
} from "../../ui/primitives.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { PlusIcon } from "../../ui/icons.js";

// Settings -> Devices (issue #1326) — the management surface (create/stop/
// delete) for the Android device panel. Deliberately NOT where a device is
// opened from day to day — that's SidebarDevices.tsx, which explains why in
// its own header comment. This section shows a device's FULL lifecycle,
// including killed rows (unlike the sidebar, which filters them out): a
// killed device is where you'd see its final `live.error`.
//
// Reads/writes through the `devices` store slice, not local `api.*` calls
// the way BridgesSection.tsx does — devices are also read by
// SidebarDevices.tsx, so a create/delete here has to update the SAME data
// the sidebar renders, not a copy of it (a local-state version would leave
// the sidebar showing a stale list until its own next poll tick).
function describeDevice(device: Device): string {
  if (device.status === "killed") return "stopped";
  switch (device.live?.status) {
    case "streaming":
      return "streaming";
    case "booting":
      return "booting";
    case "starting":
      return "starting";
    case "exited":
      return "exited";
    case "error":
      return device.live.error ? `error: ${device.live.error}` : "error";
    default:
      return "not running";
  }
}

export function DevicesSection() {
  const devices = useDashboardStore(useShallow((s) => s.devices));
  const refreshDevices = useDashboardStore((s) => s.refreshDevices);
  const createDevice = useDashboardStore((s) => s.createDevice);
  const terminateDevice = useDashboardStore((s) => s.terminateDevice);

  // Distinguishes "not loaded yet" from "loaded and genuinely empty" — the
  // store's `devices` starts as `[]`, so (unlike BridgesSection's own
  // `bridges: BridgeSummary[] | null`) that can't double as the loading
  // signal here.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [deleting, setDeleting] = useState<Record<number, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [avdName, setAvdName] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = () => {
    refreshDevices()
      .then(() => {
        setLoadError(false);
        setLoaded(true);
      })
      .catch(() => {
        setLoadError(true);
        setLoaded(true);
      });
  };

  usePolling(refresh, DEVICES_POLL_MS, { pauseWhenHidden: true, deps: [refreshDevices] });

  const submitCreate = () => {
    if (creating) return;
    const trimmedAvdName = avdName.trim();
    if (!trimmedAvdName) return;
    setCreateError(null);
    setCreating(true);
    createDevice(trimmedAvdName, name.trim() || undefined)
      .then(() => {
        setCreateOpen(false);
        setAvdName("");
        setName("");
      })
      .catch((err: unknown) => {
        // DEVICE_ENABLED off surfaces here verbatim (routes/devices.ts:
        // "Device panel is disabled — set DEVICE_ENABLED=true.") — this repo
        // has no frontend-visible feature flag for it, so the server's own
        // 400 message IS the disabled-state UI.
        setCreateError(err instanceof ApiError ? err.message : "Could not create this device");
      })
      .finally(() => setCreating(false));
  };

  const remove = (device: Device) => {
    setDeleteError(null);
    setDeleting((prev) => ({ ...prev, [device.id]: true }));
    terminateDevice(device.id)
      .catch((err: unknown) => {
        setDeleteError(err instanceof ApiError ? err.message : "Could not delete this device");
      })
      .finally(() => {
        setDeleting((prev) => {
          const next = { ...prev };
          delete next[device.id];
          return next;
        });
      });
  };

  return (
    <>
      <GroupHeading
        title="Android devices"
        desc="Emulators and physical phones streamed into a dockview panel over Mullion's own WebSocket."
      />
      {!loaded && <div className="settings-readonly-value">Loading…</div>}
      {loaded && devices.length > 0 && (
        <StyledList>
          {devices.map((device) => (
            <ListRow
              key={device.id}
              testId={`device-row-${device.id}`}
              dot={deviceDotClass(device)}
              title={device.name || device.avdName}
              subtitle={device.avdName}
              unavailable={device.status === "killed"}
              trailing={
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
                    {describeDevice(device)}
                  </span>
                  {device.status === "active" && (
                    <ConfirmButton
                      // Hermes review (PR #1341) — softened from "its panel
                      // closes": nothing in this action closes an already-open
                      // device-<id> panel (that would need a DockviewApi this
                      // Settings-owned slice doesn't have, per the design's
                      // own "Settings owns no DockviewApi" reasoning above);
                      // DevicePane just goes on to show a disconnected/stopped
                      // state once its emulator/scrcpy session is torn down.
                      title={`Stop ${device.name || device.avdName} — its emulator/scrcpy session is torn down; any open panel for it shows disconnected instead of closing`}
                      onConfirm={() => remove(device)}
                      disabled={deleting[device.id] ?? false}
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </div>
              }
            />
          ))}
        </StyledList>
      )}
      {deleteError && <ErrorText style={{ marginTop: 8 }}>{deleteError}</ErrorText>}

      <div style={{ marginTop: 10 }}>
        <AddButton
          onClick={() => {
            // Self-review (code-review high) — without this, closing the
            // form after a failed create (e.g. DEVICE_ENABLED=false) and
            // reopening it shows that same stale error before the user has
            // typed or submitted anything.
            setCreateError(null);
            setCreateOpen((open) => !open);
          }}
        >
          <PlusIcon size={13} />
          New device
        </AddButton>
      </div>

      {loaded && devices.length === 0 && loadError && (
        <ErrorText style={{ marginTop: 10 }}>Couldn't load devices.</ErrorText>
      )}
      {loaded && devices.length === 0 && !loadError && !createOpen && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
          No Android devices yet — create one to open its screen from the sidebar.
        </div>
      )}

      {createOpen && (
        <div style={{ marginTop: 10 }}>
          {/* There is no GET /api/avds — no route lists available AVDs on
              this host, so this is a free-text field, not a picker. */}
          <Row label="AVD name" desc="Must match an AVD already provisioned on the host.">
            <div className="settings-numberfield" style={{ width: 220 }}>
              <input
                style={{ flex: 1, textAlign: "left", width: "auto" }}
                placeholder="Pixel_8_API_34"
                value={avdName}
                onChange={(e) => setAvdName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                }}
              />
            </div>
          </Row>
          <Row label="Name" desc="Optional — falls back to the AVD name.">
            <div className="settings-numberfield" style={{ width: 220 }}>
              <input
                style={{ flex: 1, textAlign: "left", width: "auto" }}
                placeholder="Pixel 8"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                }}
              />
            </div>
          </Row>
          <div style={{ marginTop: 8 }}>
            <SecondaryButton onClick={submitCreate} disabled={creating || !avdName.trim()}>
              {creating ? "Creating…" : "Create"}
            </SecondaryButton>
          </div>
          {createError && <ErrorText style={{ marginTop: 8 }}>{createError}</ErrorText>}
        </div>
      )}
    </>
  );
}
