import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError } from "../../api/index.js";
import type { Device, SystemImage } from "../../api/index.js";
import { deviceDotClass } from "../../deviceStatus.js";
import { usePolling } from "../../hooks/usePolling.js";
import { DEVICES_POLL_MS } from "../../SidebarDevices.js";
import {
  AddButton,
  Dropdown,
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

// Same allowlist as src/routes/avds.ts's own AVD_NAME_PATTERN — checked
// client-side too so a bad name fails fast instead of round-tripping to the
// server first; the server's own check is still authoritative.
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

function describeSystemImage(image: SystemImage): string {
  if (image.apiLevel && image.tagDisplay) {
    return `API ${image.apiLevel} — ${image.tagDisplay} (${image.abi ?? image.packagePath})`;
  }
  return image.packagePath;
}

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

  // The AVD picker (GET /api/avds) — fetched lazily, only once the create
  // form is actually open in emulator mode, not eagerly at mount (these
  // routes shell out to avdmanager on the host). `avdName` above is REUSED
  // as this picker's selected value, not free text anymore — submitCreate's
  // own logic (POST /api/devices {avdName}) is unchanged either way.
  const [avds, setAvds] = useState<string[]>([]);
  const [avdsLoaded, setAvdsLoaded] = useState(false);
  const [avdsError, setAvdsError] = useState<string | null>(null);

  // The "New AVD" sub-form — system images/device profiles are fetched
  // lazily too, only once this sub-form is actually opened.
  const [newAvdOpen, setNewAvdOpen] = useState(false);
  const [newAvdName, setNewAvdName] = useState("");
  const [systemImages, setSystemImages] = useState<SystemImage[]>([]);
  const [deviceProfiles, setDeviceProfiles] = useState<string[]>([]);
  const [selectedSystemImage, setSelectedSystemImage] = useState("");
  const [selectedDeviceProfile, setSelectedDeviceProfile] = useState("");
  const [provisioningLoaded, setProvisioningLoaded] = useState(false);
  const [creatingAvd, setCreatingAvd] = useState(false);
  const [createAvdError, setCreateAvdError] = useState<string | null>(null);

  useEffect(() => {
    if (!createOpen || createMode !== "emulator") return;
    let cancelled = false;
    api
      .listAvds()
      .then(({ avds: list }) => {
        if (cancelled) return;
        setAvds(list);
        setAvdsLoaded(true);
        setAvdsError(null);
        setAvdName((prev) => (list.includes(prev) ? prev : (list[0] ?? "")));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAvdsError(err instanceof ApiError ? err.message : "Could not load AVDs");
        setAvdsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, createMode]);

  useEffect(() => {
    if (!newAvdOpen) return;
    let cancelled = false;
    Promise.all([api.listSystemImages(), api.listDeviceProfiles()])
      .then(([imagesResult, profilesResult]) => {
        if (cancelled) return;
        setSystemImages(imagesResult.systemImages);
        setDeviceProfiles(profilesResult.deviceProfiles);
        setProvisioningLoaded(true);
        setCreateAvdError(null);
        setSelectedSystemImage((prev) => prev || (imagesResult.systemImages[0]?.packagePath ?? ""));
        setSelectedDeviceProfile((prev) => prev || (profilesResult.deviceProfiles[0] ?? ""));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCreateAvdError(
          err instanceof ApiError ? err.message : "Could not load system images/device profiles",
        );
        setProvisioningLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [newAvdOpen]);

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

  const submitCreateAvd = () => {
    if (creatingAvd) return;
    const trimmedName = newAvdName.trim();
    if (!AVD_NAME_PATTERN.test(trimmedName) || !selectedSystemImage || !selectedDeviceProfile) {
      return;
    }
    setCreateAvdError(null);
    setCreatingAvd(true);
    api
      .createAvd({
        name: trimmedName,
        systemImage: selectedSystemImage,
        deviceProfile: selectedDeviceProfile,
      })
      .then(() => {
        // Creation itself succeeded — close the sub-form and select the new
        // AVD unconditionally from here on. A failure to refresh the
        // picker's own list past this point is a separate, lesser problem
        // (surfaced via avdsError, the same channel the picker's own load
        // effect uses) and must NOT be reported as "could not create this
        // AVD" (Hermes review) — the AVD was created; the picker is just
        // stale until the next refresh.
        setNewAvdOpen(false);
        setNewAvdName("");
        setAvdName(trimmedName);
        return api
          .listAvds()
          .then(({ avds: list }) => {
            setAvds(list);
            setAvdsLoaded(true);
            setAvdsError(null);
          })
          .catch((err: unknown) => {
            setAvdsError(err instanceof ApiError ? err.message : "Could not refresh the AVD list");
          });
      })
      .catch((err: unknown) => {
        setCreateAvdError(err instanceof ApiError ? err.message : "Could not create this AVD");
      })
      .finally(() => setCreatingAvd(false));
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
            setCreateAvdError(null);
            setNewAvdOpen(false);
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
              {!avdsLoaded && (
                <div className="settings-readonly-value" style={{ marginTop: 4 }}>
                  Loading AVDs…
                </div>
              )}
              {avdsLoaded && avds.length > 0 && (
                <Row label="AVD name" desc="An AVD already provisioned on the host.">
                  <Dropdown
                    options={avds.map((n) => ({ value: n, label: n }))}
                    value={avdName}
                    onChange={setAvdName}
                  />
                </Row>
              )}
              {avdsLoaded && !avdsError && avds.length === 0 && !newAvdOpen && (
                <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
                  No AVDs on this host yet — create one below.
                </div>
              )}
              {avdsError && <ErrorText style={{ marginTop: 8 }}>{avdsError}</ErrorText>}

              <div style={{ marginTop: 8 }}>
                <SecondaryButton onClick={() => setNewAvdOpen((open) => !open)}>
                  {newAvdOpen ? "Cancel new AVD" : "+ New AVD"}
                </SecondaryButton>
              </div>

              {newAvdOpen && (
                <div style={{ marginTop: 10 }}>
                  <Row label="New AVD name" desc="Letters, digits, '.', '_', and '-' only.">
                    <div className="settings-numberfield" style={{ width: 220 }}>
                      <input
                        style={{ flex: 1, textAlign: "left", width: "auto" }}
                        placeholder="Pixel_8_API_35"
                        value={newAvdName}
                        onChange={(e) => setNewAvdName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitCreateAvd();
                        }}
                      />
                    </div>
                  </Row>
                  {!provisioningLoaded && (
                    <div className="settings-readonly-value" style={{ marginTop: 4 }}>
                      Loading system images and device profiles…
                    </div>
                  )}
                  {provisioningLoaded && systemImages.length > 0 && (
                    <Row
                      label="System image"
                      desc="An Android system image already installed on the host."
                    >
                      <Dropdown
                        options={systemImages.map((img) => ({
                          value: img.packagePath,
                          label: describeSystemImage(img),
                        }))}
                        value={selectedSystemImage}
                        onChange={setSelectedSystemImage}
                      />
                    </Row>
                  )}
                  {provisioningLoaded && !createAvdError && systemImages.length === 0 && (
                    <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
                      No system images installed on this host — install one via the SDK's sdkmanager
                      first.
                    </div>
                  )}
                  {provisioningLoaded && deviceProfiles.length > 0 && (
                    <Row label="Device profile" desc="A hardware profile avdmanager knows about.">
                      <Dropdown
                        options={deviceProfiles.map((p) => ({ value: p, label: p }))}
                        value={selectedDeviceProfile}
                        onChange={setSelectedDeviceProfile}
                      />
                    </Row>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <SecondaryButton
                      onClick={submitCreateAvd}
                      disabled={
                        creatingAvd ||
                        !AVD_NAME_PATTERN.test(newAvdName.trim()) ||
                        !selectedSystemImage ||
                        !selectedDeviceProfile
                      }
                    >
                      {creatingAvd ? "Creating AVD…" : "Create AVD"}
                    </SecondaryButton>
                  </div>
                  {createAvdError && (
                    <ErrorText style={{ marginTop: 8 }}>{createAvdError}</ErrorText>
                  )}
                </div>
              )}

              <div style={{ marginTop: 14 }}>
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
              </div>
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
