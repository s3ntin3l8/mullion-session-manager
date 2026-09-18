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
  Segmented,
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
  const pairDevice = useDashboardStore((s) => s.pairDevice);
  const connectPhysicalDevice = useDashboardStore((s) => s.connectPhysicalDevice);
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
  const [createMode, setCreateMode] = useState<"emulator" | "physical">("emulator");
  const [avdName, setAvdName] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Physical mode is two independent actions, not a strict wizard: pairing
  // is one-time (the adb server remembers it across Mullion restarts — see
  // device-panel.md's own note), so a phone paired earlier via `mullion
  // device pair`/another session can skip straight to Connect. Kept as
  // separate state/handlers from the emulator fields above rather than
  // reusing them, since the two forms share no fields (an AVD name vs. an
  // adb address) beyond the optional label.
  const [pairingAddress, setPairingAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);

  const [connectAddress, setConnectAddress] = useState("");
  const [physicalName, setPhysicalName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

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

  const submitPair = () => {
    if (pairing) return;
    const address = pairingAddress.trim();
    const code = pairingCode.trim();
    if (!address || !code) return;
    setPairError(null);
    setPaired(false);
    setPairing(true);
    pairDevice(address, code)
      .then(() => {
        setPaired(true);
        setPairingAddress("");
        setPairingCode("");
      })
      .catch((err: unknown) => {
        setPairError(err instanceof ApiError ? err.message : "Could not pair this device");
      })
      .finally(() => setPairing(false));
  };

  const submitConnect = () => {
    if (connecting) return;
    const address = connectAddress.trim();
    if (!address) return;
    setConnectError(null);
    setConnecting(true);
    connectPhysicalDevice(address, physicalName.trim() || undefined)
      .then(() => {
        setCreateOpen(false);
        setConnectAddress("");
        setPhysicalName("");
        setPaired(false);
      })
      .catch((err: unknown) => {
        setConnectError(err instanceof ApiError ? err.message : "Could not connect this device");
      })
      .finally(() => setConnecting(false));
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
              title={device.name || device.avdName || device.serial}
              subtitle={device.avdName ?? device.serial}
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
                      title={`Stop ${device.name || device.avdName || device.serial} — its emulator/scrcpy session is torn down; any open panel for it shows disconnected instead of closing`}
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
            // typed or submitted anything. Covers all three modes' errors,
            // not just the emulator one, for the same reason.
            setCreateError(null);
            setPairError(null);
            setConnectError(null);
            setPaired(false);
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
          <Row
            label="Kind"
            desc="An emulator Mullion spawns itself, or a physical phone already reachable over wireless debugging."
          >
            <Segmented
              options={[
                { value: "emulator", label: "Emulator" },
                { value: "physical", label: "Physical" },
              ]}
              value={createMode}
              onChange={setCreateMode}
            />
          </Row>

          {createMode === "emulator" && (
            <>
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
            </>
          )}

          {createMode === "physical" && (
            <>
              {/* Two independent actions, not a strict wizard — see
                  submitPair's own comment on why. */}
              <Row
                label="Pairing address"
                desc="From the phone's Developer options -> Wireless debugging -> Pair device with pairing code — host:port, e.g. 192.168.1.23:41234. One-time; skip this and Pair below if already paired."
              >
                <div className="settings-numberfield" style={{ width: 220 }}>
                  <input
                    style={{ flex: 1, textAlign: "left", width: "auto" }}
                    placeholder="192.168.1.23:41234"
                    value={pairingAddress}
                    onChange={(e) => setPairingAddress(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitPair();
                    }}
                  />
                </div>
              </Row>
              <Row label="Pairing code" desc="The 6-digit code shown on the same screen.">
                <div className="settings-numberfield" style={{ width: 220 }}>
                  <input
                    style={{ flex: 1, textAlign: "left", width: "auto" }}
                    placeholder="123456"
                    value={pairingCode}
                    onChange={(e) => setPairingCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitPair();
                    }}
                  />
                </div>
              </Row>
              <div style={{ marginTop: 8 }}>
                <SecondaryButton
                  onClick={submitPair}
                  disabled={pairing || !pairingAddress.trim() || !pairingCode.trim()}
                >
                  {pairing ? "Pairing…" : "Pair"}
                </SecondaryButton>
              </div>
              {paired && (
                <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6 }}>
                  Paired — connect below.
                </div>
              )}
              {pairError && <ErrorText style={{ marginTop: 8 }}>{pairError}</ErrorText>}

              <div style={{ marginTop: 14 }}>
                <Row
                  label="Device address"
                  desc="A DIFFERENT port than pairing — shown at the top of the same Wireless debugging screen once paired, e.g. 192.168.1.23:37251."
                >
                  <div className="settings-numberfield" style={{ width: 220 }}>
                    <input
                      style={{ flex: 1, textAlign: "left", width: "auto" }}
                      placeholder="192.168.1.23:37251"
                      value={connectAddress}
                      onChange={(e) => setConnectAddress(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitConnect();
                      }}
                    />
                  </div>
                </Row>
              </div>
              <Row label="Name" desc="Optional — falls back to the address.">
                <div className="settings-numberfield" style={{ width: 220 }}>
                  <input
                    style={{ flex: 1, textAlign: "left", width: "auto" }}
                    placeholder="My Pixel"
                    value={physicalName}
                    onChange={(e) => setPhysicalName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitConnect();
                    }}
                  />
                </div>
              </Row>
              <div style={{ marginTop: 8 }}>
                <SecondaryButton
                  onClick={submitConnect}
                  disabled={connecting || !connectAddress.trim()}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </SecondaryButton>
              </div>
              {connectError && <ErrorText style={{ marginTop: 8 }}>{connectError}</ErrorText>}
            </>
          )}
        </div>
      )}
    </>
  );
}
