import { useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api, ApiError } from "../../api/index.js";
import type {
  Device,
  DeviceHostEntry,
  DevicePlatform,
  IosSimulator,
  SystemImage,
} from "../../api/index.js";
import { LOCAL_HOST_ID } from "../../../../src/shared/constants.js";
import { normalizeAvdHardware } from "../../../../src/shared/avd-hardware.js";
import { useAsyncData } from "../../hooks/useAsyncData.js";
import { Dropdown, Row, SecondaryButton, TextInput } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { NewSimulatorForm } from "./NewSimulatorForm.js";
import { SimulatorPicker } from "./SimulatorPicker.js";
import { viewSimulators } from "./simulatorList.js";

// Same allowlist as src/routes/avds.ts's own AVD_NAME_PATTERN — checked
// client-side too so a bad name fails fast instead of round-tripping to the
// server first; the server's own check is still authoritative. Two
// independent, single-pass regexes (not one combined pattern) — see that
// file's own comment on the catastrophic-backtracking regex CodeQL caught
// in an earlier, combined version of this check.
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const AVD_NAME_HAS_ALPHANUMERIC = /[A-Za-z0-9]/;

function isAvdNameValid(name: string): boolean {
  return AVD_NAME_PATTERN.test(name) && AVD_NAME_HAS_ALPHANUMERIC.test(name);
}

function avdHardwareError(sdcard: string, ram: string, data: string): string | null {
  const result = normalizeAvdHardware({
    sdcardSize: sdcard,
    ramSize: ram,
    dataPartitionSize: data,
  });
  return result.ok ? null : result.message;
}

function optionalSize(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Names what's wrong with *this* value (the Row desc already states the
// allowed set). Gating on the raw length (not trim) so a whitespace-only
// name still gets an explanation instead of silently greying out Create AVD.
function describeAvdNameError(raw: string): string | null {
  if (raw.length === 0) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "This name is only whitespace — use a name with letters or digits.";
  }
  if (AVD_NAME_PATTERN.test(trimmed)) {
    if (AVD_NAME_HAS_ALPHANUMERIC.test(trimmed)) return null;
    return `“${trimmed}” needs at least one letter or digit.`;
  }
  const badChars = [
    ...new Set(
      Array.from(trimmed)
        .filter((ch) => !AVD_NAME_PATTERN.test(ch))
        .map((ch) => {
          if (ch.trim() === "" || /\p{Cf}/u.test(ch)) {
            return ch === " "
              ? "space"
              : `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
          }
          return ch;
        }),
    ),
  ];
  return `“${trimmed}” contains ${badChars.join(", ")} — remove ${badChars.length === 1 ? "it" : "them"}.`;
}

function describeSystemImage(image: SystemImage): string {
  if (image.apiLevel && image.tagDisplay) {
    return `API ${image.apiLevel} — ${image.tagDisplay} (${image.abi ?? image.packagePath})`;
  }
  return image.packagePath;
}

export function DeviceCreateForm({
  platform,
  deviceHosts,
  devices,
  installStatus,
  onCreated,
  onSimulatorsLoaded,
}: {
  // Fixed by the section that opened the form (Android or iOS Simulator).
  platform: DevicePlatform;
  // The hosts and the platforms each runs; null until loaded.
  deviceHosts: DeviceHostEntry[] | null;
  devices: Device[];
  installStatus: string;
  onCreated: () => void;
  onSimulatorsLoaded: (hostId: string, byUdid: Record<string, IosSimulator>) => void;
}) {
  const createDevice = useDashboardStore((s) => s.createDevice);
  const createIosDevice = useDashboardStore((s) => s.createIosDevice);

  const [createHostId, setCreateHostId] = useState(LOCAL_HOST_ID);
  const [avdName, setAvdName] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [simulators, setSimulators] = useState<IosSimulator[]>([]);
  const [simulatorsLoaded, setSimulatorsLoaded] = useState(false);
  const [simulatorsError, setSimulatorsError] = useState<string | null>(null);
  const [simulatorUdid, setSimulatorUdid] = useState("");

  const [avds, setAvds] = useState<string[]>([]);
  const [avdsLoaded, setAvdsLoaded] = useState(false);
  const [avdsError, setAvdsError] = useState<string | null>(null);

  const [newAvdOpen, setNewAvdOpen] = useState(false);
  const [newAvdName, setNewAvdName] = useState("");
  const [systemImages, setSystemImages] = useState<SystemImage[]>([]);
  const [deviceProfiles, setDeviceProfiles] = useState<string[]>([]);
  const [selectedSystemImage, setSelectedSystemImage] = useState("");
  const [selectedDeviceProfile, setSelectedDeviceProfile] = useState("");
  const [sdcardSize, setSdcardSize] = useState("");
  const [ramSize, setRamSize] = useState("");
  const [dataPartitionSize, setDataPartitionSize] = useState("");
  const [provisioningLoaded, setProvisioningLoaded] = useState(false);
  const [creatingAvd, setCreatingAvd] = useState(false);
  const [createAvdError, setCreateAvdError] = useState<string | null>(null);
  const avdNameError = describeAvdNameError(newAvdName);

  const iosHosts = useMemo(
    () => (deviceHosts ?? []).filter((h) => h.status === "ok" && h.platforms?.includes("ios")),
    [deviceHosts],
  );
  const hasIosHost = iosHosts.length > 0;
  const effectiveCreatePlatform: DevicePlatform = platform;

  useAsyncData(
    () => api.listAvds().then(({ avds: list }) => list),
    (list) => {
      setAvds(list);
      setAvdsLoaded(true);
      setAvdsError(null);
      setAvdName((prev) => (list.includes(prev) ? prev : (list[0] ?? "")));
    },
    (err: unknown) => {
      setAvdsError(err instanceof ApiError ? err.message : "Could not load AVDs");
      setAvdsLoaded(true);
    },
    [effectiveCreatePlatform],
    { enabled: effectiveCreatePlatform === "android" },
  );

  useAsyncData(
    () =>
      Promise.all([api.listSystemImages(), api.listDeviceProfiles()]).then(
        ([imagesResult, profilesResult]) => ({ imagesResult, profilesResult }),
      ),
    ({ imagesResult, profilesResult }) => {
      setSystemImages(imagesResult.systemImages);
      setDeviceProfiles(profilesResult.deviceProfiles);
      setProvisioningLoaded(true);
      setCreateAvdError(null);
      setSelectedSystemImage((prev) => prev || (imagesResult.systemImages[0]?.packagePath ?? ""));
      setSelectedDeviceProfile((prev) => prev || (profilesResult.deviceProfiles[0] ?? ""));
    },
    (err: unknown) => {
      setCreateAvdError(
        err instanceof ApiError ? err.message : "Could not load system images/device profiles",
      );
      setProvisioningLoaded(true);
    },
    [newAvdOpen],
    { enabled: newAvdOpen },
  );

  const newAvdOpenRef = useRef(newAvdOpen);
  useEffect(() => {
    newAvdOpenRef.current = newAvdOpen;
  }, [newAvdOpen]);
  useAsyncData(
    async () => {
      if (!newAvdOpenRef.current) return null;
      const { systemImages: images } = await api.listSystemImages();
      return images;
    },
    (images) => {
      if (!images) return;
      setSystemImages(images);
      setSelectedSystemImage((prev) =>
        prev && images.some((img) => img.packagePath === prev)
          ? prev
          : (images[0]?.packagePath ?? ""),
      );
    },
    () => {},
    [installStatus],
    { enabled: installStatus === "done" },
  );

  const hostOptions = useMemo(() => {
    if (effectiveCreatePlatform === "ios") {
      if (iosHosts.length < 2) return [];
      return iosHosts.map((h) => ({ value: h.hostId, label: h.name, disabled: false }));
    }
    if (!deviceHosts || deviceHosts.length < 2) return [];
    return deviceHosts.flatMap((h) => {
      if (h.status === "unsupported") {
        return [
          {
            value: h.hostId,
            label: `${h.name} — unsupported (agent needs an update)`,
            disabled: true,
          },
        ];
      }
      if (h.status === "unreachable") {
        return [{ value: h.hostId, label: `${h.name} — unreachable`, disabled: true }];
      }
      if (!h.deviceKinds.includes("emulator")) return [];
      return [{ value: h.hostId, label: h.name, disabled: false }];
    });
  }, [deviceHosts, effectiveCreatePlatform, iosHosts]);
  const singleRemoteIosHost =
    effectiveCreatePlatform === "ios" &&
    iosHosts.length === 1 &&
    iosHosts[0].hostId !== LOCAL_HOST_ID
      ? iosHosts[0]
      : null;
  const showHostPicker = hostOptions.length > 1;
  const effectiveHostId =
    effectiveCreatePlatform === "ios"
      ? iosHosts.some((h) => h.hostId === createHostId)
        ? createHostId
        : (iosHosts[0]?.hostId ?? LOCAL_HOST_ID)
      : hostOptions.some((o) => o.value === createHostId && !o.disabled)
        ? createHostId
        : LOCAL_HOST_ID;

  useAsyncData(
    () => api.listSimulators(effectiveHostId),
    (list) => {
      setSimulators(list);
      setSimulatorsLoaded(true);
      setSimulatorsError(null);
      onSimulatorsLoaded(effectiveHostId, Object.fromEntries(list.map((s) => [s.udid, s])));
    },
    (err: unknown) => {
      setSimulatorsError(err instanceof ApiError ? err.message : "Could not load simulators");
      setSimulatorsLoaded(true);
    },
    [effectiveCreatePlatform, effectiveHostId],
    {
      enabled: effectiveCreatePlatform === "ios" && hasIosHost,
      onStart: () => {
        setSimulators([]);
        setSimulatorsLoaded(false);
        setSimulatorsError(null);
      },
    },
  );

  const activeIosUdids = useMemo(
    () =>
      new Set(
        devices
          .filter(
            (d) =>
              d.platform === "ios" &&
              d.status === "active" &&
              d.hostId === effectiveHostId &&
              d.udid,
          )
          .map((d) => d.udid as string),
      ),
    [devices, effectiveHostId],
  );
  const selectedSimulatorUdid = useMemo(() => {
    if (
      simulatorUdid &&
      simulators.some((s) => s.udid === simulatorUdid && !activeIosUdids.has(s.udid))
    ) {
      return simulatorUdid;
    }
    // The first one the picker shows: a used simulator on the newest runtime,
    // not whatever simctl happens to list first (the oldest, never booted).
    const shown = viewSimulators(simulators, {
      query: "",
      showAll: false,
      activeUdids: activeIosUdids,
    }).groups.flatMap((g) => g.simulators);
    return (
      shown.find((s) => !activeIosUdids.has(s.udid))?.udid ??
      simulators.find((s) => !activeIosUdids.has(s.udid))?.udid ??
      simulators[0]?.udid ??
      ""
    );
  }, [simulatorUdid, simulators, activeIosUdids]);

  const submitCreate = () => {
    if (creating) return;
    if (effectiveCreatePlatform === "ios") {
      if (!selectedSimulatorUdid || activeIosUdids.has(selectedSimulatorUdid)) return;
      setCreateError(null);
      setCreating(true);
      createIosDevice(
        selectedSimulatorUdid,
        name.trim() || undefined,
        effectiveHostId === LOCAL_HOST_ID ? undefined : effectiveHostId,
      )
        .then(() => {
          onCreated();
        })
        .catch((err: unknown) => {
          setCreateError(err instanceof ApiError ? err.message : "Could not create this device");
        })
        .finally(() => setCreating(false));
      return;
    }
    const trimmedAvdName = avdName.trim();
    if (!trimmedAvdName) return;
    setCreateError(null);
    setCreating(true);
    createDevice(
      trimmedAvdName,
      name.trim() || undefined,
      effectiveHostId === LOCAL_HOST_ID ? undefined : effectiveHostId,
    )
      .then(() => {
        onCreated();
      })
      .catch((err: unknown) => {
        setCreateError(err instanceof ApiError ? err.message : "Could not create this device");
      })
      .finally(() => setCreating(false));
  };

  const submitCreateAvd = () => {
    if (creatingAvd) return;
    const trimmedName = newAvdName.trim();
    if (!isAvdNameValid(trimmedName) || !selectedSystemImage || !selectedDeviceProfile) {
      return;
    }
    const hardwareError = avdHardwareError(sdcardSize, ramSize, dataPartitionSize);
    if (hardwareError) {
      setCreateAvdError(hardwareError);
      return;
    }
    setCreateAvdError(null);
    setCreatingAvd(true);
    const sdcard = optionalSize(sdcardSize);
    const ram = optionalSize(ramSize);
    const data = optionalSize(dataPartitionSize);
    api
      .createAvd({
        name: trimmedName,
        systemImage: selectedSystemImage,
        deviceProfile: selectedDeviceProfile,
        ...(sdcard ? { sdcardSize: sdcard } : {}),
        ...(ram ? { ramSize: ram } : {}),
        ...(data ? { dataPartitionSize: data } : {}),
      })
      .then((created) => {
        const warning = created.warning ?? null;
        setNewAvdOpen(false);
        setNewAvdName("");
        setSdcardSize("");
        setRamSize("");
        setDataPartitionSize("");
        setAvdName(trimmedName);
        return api
          .listAvds()
          .then(({ avds: list }) => {
            setAvds(list);
            setAvdsLoaded(true);
            setAvdsError(warning);
          })
          .catch((err: unknown) => {
            const refresh =
              err instanceof ApiError ? err.message : "Could not refresh the AVD list";
            setAvdsError(warning ? `${warning} ${refresh}` : refresh);
          });
      })
      .catch((err: unknown) => {
        setCreateAvdError(err instanceof ApiError ? err.message : "Could not create this AVD");
      })
      .finally(() => setCreatingAvd(false));
  };

  return (
    <div style={{ marginTop: 10 }}>
      {(showHostPicker || singleRemoteIosHost) && (
        <Row
          label="Host"
          desc={
            effectiveCreatePlatform === "ios"
              ? "The machine that runs this simulator. The simulator list below is from this machine."
              : "The machine that runs this emulator. The virtual device below is chosen from this machine's list; its name is resolved on the host you pick here."
          }
        >
          {singleRemoteIosHost ? (
            <div className="settings-readonly-value">{singleRemoteIosHost.name}</div>
          ) : (
            <Dropdown
              ariaLabel="Host"
              options={hostOptions}
              value={effectiveHostId}
              onChange={setCreateHostId}
            />
          )}
        </Row>
      )}
      {effectiveCreatePlatform === "ios" ? (
        <>
          {!simulatorsLoaded && (
            <div className="settings-readonly-value" style={{ marginTop: 4 }}>
              Loading simulators…
            </div>
          )}
          {simulatorsLoaded && simulators.length > 0 && (
            <Row
              label="Simulator"
              desc={
                effectiveHostId === LOCAL_HOST_ID
                  ? "An available iOS Simulator on this machine."
                  : `An available iOS Simulator on ${iosHosts.find((h) => h.hostId === effectiveHostId)?.name ?? "the selected machine"}.`
              }
            >
              <SimulatorPicker
                simulators={simulators}
                activeUdids={activeIosUdids}
                value={selectedSimulatorUdid}
                onChange={setSimulatorUdid}
              />
            </Row>
          )}
          {simulatorsLoaded && !simulatorsError && simulators.length === 0 && (
            <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
              No iOS simulators available on this machine.
            </div>
          )}
          {simulatorsError && <ErrorText style={{ marginTop: 8 }}>{simulatorsError}</ErrorText>}
          <NewSimulatorForm
            hostId={effectiveHostId}
            onCreated={(created) => {
              const next = [...simulators.filter((s) => s.udid !== created.udid), created];
              setSimulators(next);
              setSimulatorsLoaded(true);
              setSimulatorsError(null);
              setSimulatorUdid(created.udid);
              onSimulatorsLoaded(effectiveHostId, Object.fromEntries(next.map((s) => [s.udid, s])));
            }}
          />
        </>
      ) : (
        <>
          {!avdsLoaded && (
            <div className="settings-readonly-value" style={{ marginTop: 4 }}>
              Loading AVDs…
            </div>
          )}
          {avdsLoaded && avds.length > 0 && (
            <Row
              label="Virtual device"
              desc="An Android virtual device (AVD) on this machine. Listing AVDs on other hosts is not supported yet."
            >
              <Dropdown
                options={avds.map((n) => ({ value: n, label: n }))}
                value={avdName}
                onChange={setAvdName}
              />
            </Row>
          )}
          {avdsLoaded && !avdsError && avds.length === 0 && !newAvdOpen && (
            <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
              No virtual devices on this machine yet. Create one below.
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
              <Row
                label="New virtual device name"
                desc="Letters, digits, periods, underscores, and hyphens only."
              >
                <TextInput
                  style={{ width: 220 }}
                  placeholder="Pixel_8_API_35"
                  value={newAvdName}
                  onChange={(e) => setNewAvdName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitCreateAvd();
                  }}
                  aria-invalid={avdNameError !== null}
                />
              </Row>
              {avdNameError !== null && (
                <ErrorText style={{ marginTop: 4 }}>{avdNameError}</ErrorText>
              )}
              {!provisioningLoaded && (
                <div className="settings-readonly-value" style={{ marginTop: 4 }}>
                  Loading system images and device profiles…
                </div>
              )}
              {provisioningLoaded && systemImages.length > 0 && (
                <Row label="System image" desc="An Android system image installed on this machine.">
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
                <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
                  No system images installed. Install one under "SDK system images" below.
                </div>
              )}
              {provisioningLoaded && deviceProfiles.length > 0 && (
                <Row label="Device profile" desc="The hardware to emulate.">
                  <Dropdown
                    options={deviceProfiles.map((p) => ({ value: p, label: p }))}
                    value={selectedDeviceProfile}
                    onChange={setSelectedDeviceProfile}
                  />
                </Row>
              )}
              {provisioningLoaded && !createAvdError && deviceProfiles.length === 0 && (
                <div style={{ fontSize: "0.71875rem", color: "var(--dim)", marginTop: 4 }}>
                  No device profiles found. Check the Android SDK command-line tools installation.
                </div>
              )}
              <Row
                label="SD card"
                desc="Optional. A size like 2048M or 2G. Blank keeps the SDK default."
              >
                <TextInput
                  style={{ width: 160 }}
                  aria-label="SD card size"
                  placeholder="2048M"
                  value={sdcardSize}
                  onChange={(e) => setSdcardSize(e.target.value)}
                />
              </Row>
              <Row label="RAM" desc="Optional. Megabytes, or a size like 2048M or 2G.">
                <TextInput
                  style={{ width: 160 }}
                  aria-label="RAM"
                  placeholder="2048"
                  value={ramSize}
                  onChange={(e) => setRamSize(e.target.value)}
                />
              </Row>
              <Row
                label="Data partition"
                desc="Optional. A size like 6G or 800M. Blank keeps the SDK default."
              >
                <TextInput
                  style={{ width: 160 }}
                  aria-label="Data partition"
                  placeholder="6G"
                  value={dataPartitionSize}
                  onChange={(e) => setDataPartitionSize(e.target.value)}
                />
              </Row>
              <div style={{ marginTop: 8 }}>
                <SecondaryButton
                  onClick={submitCreateAvd}
                  disabled={
                    creatingAvd ||
                    !isAvdNameValid(newAvdName.trim()) ||
                    !selectedSystemImage ||
                    !selectedDeviceProfile
                  }
                >
                  {creatingAvd ? "Creating AVD…" : "Create AVD"}
                </SecondaryButton>
              </div>
              {createAvdError && <ErrorText style={{ marginTop: 8 }}>{createAvdError}</ErrorText>}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 14 }}>
        <Row
          label="Name"
          desc={
            effectiveCreatePlatform === "ios"
              ? "Optional. Defaults to the simulator name."
              : "Optional. Defaults to the virtual device name."
          }
        >
          <TextInput
            style={{ width: 220 }}
            placeholder={effectiveCreatePlatform === "ios" ? "iPhone 16" : "Pixel 8"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
            }}
          />
        </Row>
      </div>
      <div style={{ marginTop: 8 }}>
        <SecondaryButton
          onClick={submitCreate}
          disabled={
            effectiveCreatePlatform === "ios"
              ? creating ||
                !simulatorsLoaded ||
                Boolean(simulatorsError) ||
                !selectedSimulatorUdid ||
                activeIosUdids.has(selectedSimulatorUdid)
              : creating || !avdName.trim()
          }
        >
          {creating ? "Creating…" : "Create"}
        </SecondaryButton>
      </div>
      {createError && <ErrorText style={{ marginTop: 8 }}>{createError}</ErrorText>}
    </div>
  );
}
