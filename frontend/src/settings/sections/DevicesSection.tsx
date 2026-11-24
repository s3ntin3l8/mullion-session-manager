import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError } from "../../api/index.js";
import type { Device, DeviceHostEntry, DiscoveredDevice, IosSimulator } from "../../api/index.js";
import { LOCAL_HOST_ID } from "../../../../src/shared/constants.js";
import { hostDisplayName } from "../../lib/hostBadge.js";
import { deviceDotClass } from "../../deviceStatus.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useAsyncData } from "../../hooks/useAsyncData.js";
import { useSystemImageInstall } from "../../hooks/useSystemImageInstall.js";
import { useSdkLicenses } from "../../hooks/useSdkLicenses.js";
import { DEVICES_POLL_MS } from "../../SidebarDevices.js";
import {
  AddButton,
  GroupHeading,
  ListRow,
  Row,
  SecondaryButton,
  StyledList,
  TextInput,
} from "../../ui/primitives.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { PlusIcon, TrashIcon } from "../../ui/icons.js";
import { DeviceCreateForm } from "./DeviceCreateForm.js";
import { SdkSystemImages } from "./SdkSystemImages.js";
import { PairDeviceDialog } from "./PairDeviceDialog.js";
import { Presence } from "../../ui/Presence.js";
import { findReconnectSuggestions } from "./deviceReconnect.js";
import { useServerInfo } from "../useServerInfo.js";
import {
  DeviceDiscoverySetting,
  EmulatorGpuSetting,
  EmulatorWindowSetting,
} from "../RuntimeSettings.js";

// Settings -> Devices (issue #1326) — the full-lifecycle management surface
// (create / pair / edit address / start / stop / delete) for the Android
// device panel. Deliberately NOT where a device is opened from day to day —
// that's SidebarDevices.tsx, which explains why in its own header comment
// (the sidebar does Start/Stop and open; everything irreversible or
// form-shaped lives here).
//
// A `status: "killed"` row is a STOPPED device, not a dead one: dimmed via
// `unavailable`, but still Start/Edit/Delete-able. It used to be shown
// read-only with no Delete, which is exactly how a device could get stuck
// here forever — DELETE now removes the row outright (routes/devices.ts),
// so this section never accumulates unreachable ghosts.
//
// Reads/writes through the `devices` store slice, not local `api.*` calls
// the way BridgesSection.tsx does — devices are also read by
// SidebarDevices.tsx, so any mutation here has to update the SAME data
// the sidebar renders, not a copy of it (a local-state version would leave
// the sidebar showing a stale list until its own next poll tick).
function describeDevice(device: Device): string {
  // Checked first: an unreachable host's `live` is null for lack of an
  // answer, which must not read as "stopped" / "not running".
  if (device.hostUnreachable) return "unavailable — host unreachable";
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

// The device hosts are re-read every this many device polls (~32 s at 4 s).
export const HOSTS_REFRESH_TICKS = 8;

// Reconnect-prompt scan cadence (issue #1380).
const DISCOVERY_RECONNECT_POLL_MS = 5000;

function ReconnectPrompt({
  device,
  candidates,
  ambiguous,
  busy,
  error,
  onReconnect,
}: {
  device: Device;
  candidates: DiscoveredDevice[];
  ambiguous: boolean;
  busy: boolean;
  error: string | undefined;
  onReconnect: (target: DiscoveredDevice) => void;
}) {
  const label = device.name || device.serial || "this device";
  return (
    <div
      data-testid={`reconnect-prompt-${device.id}`}
      className="settings-footer-note"
      style={{ margin: "0 12px 8px" }}
    >
      {ambiguous
        ? `${label} may have moved — pick the phone to reconnect to:`
        : `${label} is advertising a new address.`}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
        {candidates.map((c) => (
          <SecondaryButton key={c.id} onClick={() => onReconnect(c)} disabled={busy}>
            {ambiguous ? `Reconnect to ${c.name} (${c.connectAddress})` : `Reconnect to ${label}?`}
          </SecondaryButton>
        ))}
      </div>
      {error && <ErrorText style={{ marginTop: 6 }}>{error}</ErrorText>}
    </div>
  );
}

export function DevicesSection() {
  const serverInfo = useServerInfo();
  const devices = useDashboardStore(useShallow((s) => s.devices));
  const refreshDevices = useDashboardStore((s) => s.refreshDevices);
  const startDevice = useDashboardStore((s) => s.startDevice);
  const stopDevice = useDashboardStore((s) => s.stopDevice);
  const deleteDevice = useDashboardStore((s) => s.deleteDevice);
  const updateDeviceAddress = useDashboardStore((s) => s.updateDeviceAddress);

  // Distinguishes "not loaded yet" from "loaded and genuinely empty" — the
  // store's `devices` starts as `[]`, so (unlike BridgesSection's own
  // `bridges: BridgeSummary[] | null`) that can't double as the loading
  // signal here.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [deleting, setDeleting] = useState<Record<number, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Start/Stop in-flight, keyed by row id + which of the two (a row can
  // only ever have one) so the right button can label its own busy state.
  const [toggling, setToggling] = useState<Record<number, "start" | "stop">>({});
  const [toggleError, setToggleError] = useState<string | null>(null);

  const hosts = useDashboardStore(useShallow((s) => s.hosts));
  const [createOpen, setCreateOpen] = useState<"android" | "ios" | null>(null);
  // Which hosts run which platform: decides which platform sections exist.
  const [deviceHosts, setDeviceHosts] = useState<DeviceHostEntry[] | null>(null);
  const hostsInFlight = useRef(false);
  const hostsTicks = useRef(0);
  // Physical phones are paired from their own dialog (issue #1379) — see
  // PairDeviceDialog.tsx. This section only owns whether it's open.
  const [pairOpen, setPairOpen] = useState(false);
  const [simulatorsByHost, setSimulatorsByHost] = useState<
    Record<string, Record<string, IosSimulator>>
  >({});
  const handleSimulatorsLoaded = useCallback(
    (hostId: string, byUdid: Record<string, IosSimulator>) => {
      setSimulatorsByHost((prev) => ({ ...prev, [hostId]: byUdid }));
    },
    [],
  );

  const installOp = useSystemImageInstall();
  const licenseOp = useSdkLicenses();

  // Issue #1347 — editing a physical device's stored adb address in place,
  // without delete-and-recreate. Keyed by device id (not a boolean) so only
  // one row's form is open at a time, same "single open form" shape the
  // create form above already has.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const refresh = () => {
    // The hosts are re-read with the list: a Mac that was asleep, or updated to
    // report simulators, when Settings opened must show up without reopening it.
    // A failed read keeps what was known (null stays "not loaded", then empty).
    // One read at a time: the endpoint probes every host, so a slow answer must
    // not be overtaken by (or pile up behind) the next tick's. And not every
    // tick: what a host can run changes over minutes, the device list over
    // seconds, so the hosts are re-read every HOSTS_REFRESH_TICKS-th poll (and on
    // the first).
    const hostsTick = hostsTicks.current++;
    if (hostsTick % HOSTS_REFRESH_TICKS === 0 && !hostsInFlight.current) {
      hostsInFlight.current = true;
      api
        .listDeviceHosts()
        .then(setDeviceHosts)
        .catch(() => setDeviceHosts((prev) => prev ?? []))
        .finally(() => {
          hostsInFlight.current = false;
        });
    }
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

  // Issue #1380 — when mDNS rediscovers a paired phone on a new connect port,
  // offer the same in-place address update as "Edit address" as a one-click
  // inline prompt. Only polls while discovery is on AND at least one active
  // physical row exists to match against.
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [reconnecting, setReconnecting] = useState<Record<number, boolean>>({});
  const [reconnectError, setReconnectError] = useState<Record<number, string>>({});
  const discoveryOn = Boolean(serverInfo?.features.devices && serverInfo.features.deviceDiscovery);
  // Emulators are hidden only when the server positively lists its kinds and
  // "emulator" is not among them (#1854: a physical-only platform). An older
  // server, or one with the panel off (empty list), keeps today's UI.
  const deviceKinds = serverInfo?.features.deviceKinds;
  const noAndroidKind = deviceKinds?.length === 0;
  const emulatorOn = !deviceKinds?.length || deviceKinds.includes("emulator");
  const hasPhysical = devices.some((d) => d.kind === "physical" && d.status === "active");
  usePolling(
    (isCancelled) => {
      api
        .listDiscoveredDevices()
        .then((list) => {
          if (!isCancelled()) setDiscovered(list);
        })
        .catch(() => {
          // Best-effort hint only — a failed scan just means no prompt.
          if (!isCancelled()) setDiscovered([]);
        });
    },
    DISCOVERY_RECONNECT_POLL_MS,
    { enabled: discoveryOn && hasPhysical, pauseWhenHidden: true },
  );
  const reconnectSuggestions = useMemo(
    () => (discoveryOn ? findReconnectSuggestions(devices, discovered) : new Map()),
    [discoveryOn, devices, discovered],
  );

  const reconnect = (device: Device, target: DiscoveredDevice) => {
    const address = target.connectAddress;
    if (!address || reconnecting[device.id]) return;
    setReconnectError((prev) => {
      const next = { ...prev };
      delete next[device.id];
      return next;
    });
    setReconnecting((prev) => ({ ...prev, [device.id]: true }));
    updateDeviceAddress(device.id, address)
      .catch((err: unknown) => {
        setReconnectError((prev) => ({
          ...prev,
          [device.id]: err instanceof ApiError ? err.message : "Could not reconnect this device",
        }));
      })
      .finally(() =>
        setReconnecting((prev) => {
          const next = { ...prev };
          delete next[device.id];
          return next;
        }),
      );
  };

  const iosRowHostIds = useMemo(
    () =>
      [
        ...new Set(
          devices.filter((d) => d.platform === "ios" && !d.hostUnreachable).map((d) => d.hostId),
        ),
      ].sort(),
    [devices],
  );
  const iosRowHostsKey = iosRowHostIds.join("\0");
  useAsyncData(
    async () => {
      const entries = await Promise.all(
        iosRowHostIds.map(async (hostId) => {
          try {
            const list = await api.listSimulators(hostId);
            return [hostId, Object.fromEntries(list.map((s) => [s.udid, s]))] as const;
          } catch {
            return null;
          }
        }),
      );
      return entries.filter((e): e is NonNullable<typeof e> => e !== null);
    },
    (entries) => {
      if (entries.length === 0) return;
      setSimulatorsByHost((prev) => {
        const next = { ...prev };
        for (const [hostId, byUdid] of entries) next[hostId] = byUdid;
        return next;
      });
    },
    () => {},
    [iosRowHostsKey],
    { enabled: iosRowHostIds.length > 0 },
  );

  const toggleRunning = (device: Device, kind: "start" | "stop") => {
    setToggleError(null);
    setToggling((prev) => ({ ...prev, [device.id]: kind }));
    // `Promise<unknown>` rather than the `Promise<Device> | Promise<void>`
    // union — a union of two .catch signatures isn't callable directly.
    const op: Promise<unknown> = kind === "start" ? startDevice(device.id) : stopDevice(device.id);
    op.catch((err: unknown) => {
      setToggleError(err instanceof ApiError ? err.message : `Could not ${kind} this device`);
    }).finally(() => {
      setToggling((prev) => {
        const next = { ...prev };
        delete next[device.id];
        return next;
      });
    });
  };

  const remove = (device: Device) => {
    setDeleteError(null);
    setDeleting((prev) => ({ ...prev, [device.id]: true }));
    deleteDevice(device.id)
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

  const startEdit = (device: Device) => {
    setEditingId(device.id);
    setEditAddress(device.serial ?? "");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditError(null);
  };

  const submitEdit = (device: Device) => {
    if (editSaving) return;
    const address = editAddress.trim();
    if (!address) return;
    setEditError(null);
    setEditSaving(true);
    updateDeviceAddress(device.id, address)
      .then(() => {
        setEditingId(null);
      })
      .catch((err: unknown) => {
        setEditError(
          err instanceof ApiError ? err.message : "Could not update this device's address",
        );
      })
      .finally(() => setEditSaving(false));
  };

  const renderDevice = (device: Device) => {
    const isIos = device.platform === "ios";
    const sim = isIos && device.udid ? simulatorsByHost[device.hostId]?.[device.udid] : undefined;
    const rowTitle = isIos
      ? device.name || sim?.name || device.udid || "iOS Simulator"
      : device.name || device.avdName || device.serial;
    const detailText = isIos
      ? sim
        ? `${sim.name} · ${sim.runtime}`
        : (device.udid ?? "")
      : (device.avdName ?? device.serial ?? "");
    const rowSubtitle =
      device.hostId !== LOCAL_HOST_ID
        ? `${detailText} · ${hostDisplayName(device.hostId, hosts)}`
        : detailText || undefined;
    return (
      <Fragment key={device.id}>
        <ListRow
          testId={`device-row-${device.id}`}
          dot={deviceDotClass(device)}
          title={rowTitle}
          subtitle={rowSubtitle}
          unavailable={device.status === "killed" || device.hostUnreachable === true}
          trailing={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.65625rem", color: "var(--dim)" }}>
                {describeDevice(device)}
              </span>
              {/* Physical-only, but NO longer active-only: a stopped
                          phone's address is exactly the thing you may need to
                          fix (DHCP lease moved) before starting it, and PATCH
                          persists it without touching the process (routes/
                          devices.ts) — so gating this on `status === "active"`
                          would have made the fix require a running device. */}
              {device.kind === "physical" && (
                <SecondaryButton
                  onClick={() => (editingId === device.id ? cancelEdit() : startEdit(device))}
                >
                  {editingId === device.id ? "Cancel" : "Edit address"}
                </SecondaryButton>
              )}
              {device.status === "active" ? (
                <SecondaryButton
                  onClick={() => toggleRunning(device, "stop")}
                  disabled={toggling[device.id] != null || device.hostUnreachable === true}
                >
                  {toggling[device.id] === "stop" ? "Stopping…" : "Stop"}
                </SecondaryButton>
              ) : (
                <SecondaryButton
                  onClick={() => toggleRunning(device, "start")}
                  disabled={toggling[device.id] != null || device.hostUnreachable === true}
                >
                  {toggling[device.id] === "start" ? "Starting…" : "Start"}
                </SecondaryButton>
              )}
              {/* Available on EVERY row — the old active-only gate is
                          what stranded stopped devices with no way to clear
                          them (the bug this control set exists for). Delete
                          now removes the row (see routes/devices.ts), so the
                          copy says "removed" rather than the old soft-delete's
                          "stream stops and any open panel shows it as
                          disconnected". Hermes' earlier softening still holds
                          for the open-panel half: nothing here closes a
                          device-<id> panel (no DockviewApi in a Settings-owned
                          slice), DevicePane just reports it. */}
              <ConfirmButton
                title={`Delete ${rowTitle}. The device is torn down and removed from this list permanently.`}
                onConfirm={() => remove(device)}
                disabled={deleting[device.id] ?? false}
              >
                {/* aria-hidden so the trashcan never joins the
                            button's accessible name — "Delete" stays the
                            exact role name the tests (and a screen reader's
                            quick scan) match on. */}
                <TrashIcon size={13} aria-hidden="true" />
                Delete
              </ConfirmButton>
            </div>
          }
        />
        {editingId !== device.id && reconnectSuggestions.has(device.id) && (
          <ReconnectPrompt
            device={device}
            candidates={reconnectSuggestions.get(device.id)?.candidates ?? []}
            ambiguous={reconnectSuggestions.get(device.id)?.ambiguous ?? false}
            busy={reconnecting[device.id] ?? false}
            error={reconnectError[device.id]}
            onReconnect={(target) => reconnect(device, target)}
          />
        )}
        {editingId === device.id && (
          <div style={{ padding: "8px 12px" }}>
            <Row
              label="New address"
              desc="The IP address and port shown under Developer options → Wireless debugging on the phone. If the phone needs a new pairing code, delete it and pair it again."
            >
              <TextInput
                style={{ width: 220 }}
                placeholder="192.168.1.23:37251"
                value={editAddress}
                onChange={(e) => setEditAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitEdit(device);
                }}
                autoFocus
              />
            </Row>
            <div style={{ marginTop: 8 }}>
              <SecondaryButton
                onClick={() => submitEdit(device)}
                disabled={editSaving || !editAddress.trim()}
              >
                {editSaving ? "Saving…" : "Save"}
              </SecondaryButton>
            </div>
            {editError && <ErrorText style={{ marginTop: 8 }}>{editError}</ErrorText>}
          </div>
        )}
      </Fragment>
    );
  };

  const androidDevices = devices.filter((d) => d.platform !== "ios");
  const iosDevices = devices.filter((d) => d.platform === "ios");
  const hostsKnown = deviceHosts !== null && deviceHosts.length > 0;
  const reportsPlatform = (platform: "android" | "ios") =>
    (deviceHosts ?? []).some((h) => h.status === "ok" && h.platforms?.includes(platform));
  // A platform with no host that can run it, and no row left over from one that
  // could, is not shown (an iOS-only Mac has no Android section, and a server
  // that cannot run simulators has no iOS one). Until the hosts are known,
  // Android stays, as it was before the page had platform sections.
  const androidConfirmed = reportsPlatform("android") || androidDevices.length > 0;
  // Once shown it stays: the hosts are re-read as they come and go (a host that
  // drops out for a poll must not unmount the SDK image state, an install or a
  // license prompt in flight, under the user).
  const [androidSeen, setAndroidSeen] = useState(false);
  if (androidConfirmed && !androidSeen) setAndroidSeen(true);
  const showAndroid = !hostsKnown || androidConfirmed || androidSeen;
  // The same for iOS: one failed probe of the only simulator host (a Mac asleep)
  // must not close an open "Add a simulator" form under the user.
  const iosConfirmed = reportsPlatform("ios") || iosDevices.length > 0;
  const [iosSeen, setIosSeen] = useState(false);
  if (iosConfirmed && !iosSeen) setIosSeen(true);
  const showIos = iosConfirmed || iosSeen;
  const toggleCreate = (platform: "android" | "ios") =>
    setCreateOpen((open) => (open === platform ? null : platform));

  const emptyText = (platform: "android" | "ios") =>
    platform === "ios"
      ? "No simulators added yet. Add one to open its screen from the sidebar."
      : emulatorOn
        ? "No Android devices yet. Pair a phone or create an emulator to open its screen from the sidebar."
        : "No Android devices yet. Pair a phone to open its screen from the sidebar. Emulators are not supported on this server's platform.";

  const renderList = (platform: "android" | "ios", list: Device[]) => (
    <>
      {loaded && list.length > 0 && <StyledList>{list.map(renderDevice)}</StyledList>}
      {loaded && list.length === 0 && !loadError && createOpen !== platform && (
        <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 10 }}>
          {emptyText(platform)}
        </div>
      )}
    </>
  );

  return (
    <>
      {serverInfo && !serverInfo.features.devices && (
        <div className="settings-footer-note" style={{ marginTop: 0, marginBottom: 12 }}>
          Android devices are turned off on this server. The server administrator can enable them.
        </div>
      )}
      {/* An iOS-only host (no Android kind, #3436) has no discovery socket, so
          the row would be inert. An older server omits deviceKinds: keep it. */}
      {serverInfo && (serverInfo.features.deviceDiscovery || !noAndroidKind) && (
        <DeviceDiscoverySetting />
      )}
      {!loaded && <div className="settings-readonly-value">Loading…</div>}
      {loaded && loadError && devices.length === 0 && (
        <ErrorText style={{ marginTop: 10 }}>Couldn't load devices.</ErrorText>
      )}

      {showAndroid && (
        <section aria-label="Android" data-testid="devices-android">
          <GroupHeading
            title="Android"
            desc="Emulators and phones whose screens you can open in a panel."
          />
          {emulatorOn && <EmulatorWindowSetting />}
          {emulatorOn && <EmulatorGpuSetting />}
          {renderList("android", androidDevices)}
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <AddButton onClick={() => setPairOpen(true)}>
              <PlusIcon size={13} />
              Pair a phone or tablet
            </AddButton>
            {emulatorOn && (
              <AddButton onClick={() => toggleCreate("android")}>
                <PlusIcon size={13} />
                Create an emulator
              </AddButton>
            )}
          </div>
          {createOpen === "android" && emulatorOn && (
            <DeviceCreateForm
              platform="android"
              deviceHosts={deviceHosts}
              devices={devices}
              installStatus={installOp.status}
              onCreated={() => setCreateOpen(null)}
              onSimulatorsLoaded={handleSimulatorsLoaded}
            />
          )}
          <SdkSystemImages installOp={installOp} licenseOp={licenseOp} />
        </section>
      )}

      {showIos && (
        <section aria-label="iOS Simulator" data-testid="devices-ios" style={{ marginTop: 20 }}>
          <GroupHeading
            title="iOS Simulator"
            desc="Xcode simulators on a Mac host, streamed into a panel."
          />
          {renderList("ios", iosDevices)}
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {reportsPlatform("ios") ? (
              <AddButton onClick={() => toggleCreate("ios")}>
                <PlusIcon size={13} />
                Add a simulator
              </AddButton>
            ) : (
              <div style={{ fontSize: "0.71875rem", color: "var(--dim)" }}>
                No host can run simulators right now, so none can be added.
              </div>
            )}
          </div>
          {createOpen === "ios" && (
            <DeviceCreateForm
              platform="ios"
              deviceHosts={deviceHosts}
              devices={devices}
              installStatus={installOp.status}
              onCreated={() => setCreateOpen(null)}
              onSimulatorsLoaded={handleSimulatorsLoaded}
            />
          )}
        </section>
      )}

      {deleteError && <ErrorText style={{ marginTop: 8 }}>{deleteError}</ErrorText>}
      {toggleError && <ErrorText style={{ marginTop: 8 }}>{toggleError}</ErrorText>}
      <Presence when={pairOpen}>
        <PairDeviceDialog
          deviceHosts={deviceHosts}
          onClose={() => setPairOpen(false)}
          onPaired={() => setPairOpen(false)}
        />
      </Presence>
    </>
  );
}
