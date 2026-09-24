import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError } from "../../api/index.js";
import type { Device, SystemImage, AvailableSystemImage } from "../../api/index.js";
import { deviceDotClass } from "../../deviceStatus.js";
import { matchesQuery } from "../../matchQuery.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useSystemImageInstall } from "../../hooks/useSystemImageInstall.js";
import { useSdkLicenses } from "../../hooks/useSdkLicenses.js";
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
import { ProgressBar } from "../../ui/ProgressBar.js";
import { Modal } from "../../ui/Modal.js";
import { CloseIcon, PlusIcon, SearchIcon } from "../../ui/icons.js";
import { PairDeviceDialog } from "./PairDeviceDialog.js";
import { useServerInfo } from "../useServerInfo.js";

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

// Names what's wrong with *this* value (the Row desc already states the
// allowed set). Gating on the raw length (not trim) so a whitespace-only
// name still gets an explanation instead of silently greying out Create AVD.
function describeAvdNameError(raw: string): string | null {
  if (raw.length === 0) return null; // empty field is the placeholder's job
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Fixed wording: interpolating raw here would render as “ ” once HTML
    // collapses the whitespace, so the message would look like it lost its
    // subject.
    return "This name is only whitespace — use a name with letters or digits.";
  }
  if (AVD_NAME_PATTERN.test(trimmed)) {
    if (AVD_NAME_HAS_ALPHANUMERIC.test(trimmed)) return null;
    return `“${trimmed}” needs at least one letter or digit.`;
  }
  // Single-char membership via AVD_NAME_PATTERN itself — one source for the
  // allowlist instead of re-spelling the char class here a third time.
  // Invisible culprits get a visible label — interpolating the raw char
  // would collapse to blank in HTML, the same failure the whitespace-only
  // branch above was fixed for. `ch.trim() === ""` covers JS WhiteSpace
  // (NBSP, thin space, …); `\p{Cf}` covers format chars (ZWSP, soft hyphen)
  // that render blank but are not WhiteSpace, so trim alone misses them.
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
  const serverInfo = useServerInfo();
  const devices = useDashboardStore(useShallow((s) => s.devices));
  const refreshDevices = useDashboardStore((s) => s.refreshDevices);
  const createDevice = useDashboardStore((s) => s.createDevice);
  const terminateDevice = useDashboardStore((s) => s.terminateDevice);
  const updateDeviceAddress = useDashboardStore((s) => s.updateDeviceAddress);

  // Distinguishes "not loaded yet" from "loaded and genuinely empty" — the
  // store's `devices` starts as `[]`, so (unlike BridgesSection's own
  // `bridges: BridgeSummary[] | null`) that can't double as the loading
  // signal here.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [deleting, setDeleting] = useState<Record<number, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  // Physical phones are paired from their own dialog (issue #1379) — see
  // PairDeviceDialog.tsx. This section only owns whether it's open.
  const [pairOpen, setPairOpen] = useState(false);
  const [avdName, setAvdName] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
  // Single source for the New-AVD name's invalid *message* — the input's
  // aria-invalid and the inline ErrorText both read this. Create AVD's
  // disabled check calls isAvdNameValid directly (it must stay disabled for
  // an empty field, which deliberately has no error message).
  const avdNameError = describeAvdNameError(newAvdName);

  // Available system images browser — fetched lazily, only once the section
  // is actually visible. Filters out already-installed images and groups
  // by API level for quick scanning.
  const [availableImages, setAvailableImages] = useState<AvailableSystemImage[]>([]);
  const [availableLoaded, setAvailableLoaded] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableFilter, setAvailableFilter] = useState<"all" | "installable" | "installed">(
    "all",
  );
  // Narrowing filters for the available-images list — client-side only (the
  // full sdkmanager listing is already in memory). "" means "all". Options
  // are derived from whatever the host's sdkmanager actually returned, so
  // they can't offer a variant/API that doesn't exist here.
  const [availableVariant, setAvailableVariant] = useState("");
  const [availableApi, setAvailableApi] = useState("");
  const [availableQuery, setAvailableQuery] = useState("");
  const installOp = useSystemImageInstall();
  const licenseOp = useSdkLicenses();
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [pendingInstallPath, setPendingInstallPath] = useState<string | null>(null);
  const pendingInstallRef = useRef<string | null>(null);

  useEffect(() => {
    if (!createOpen) return;
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
  }, [createOpen]);

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

  // Available system images — fetched lazily, only once the SDK section is
  // actually expanded (same pattern as the AVD picker and provisioning data).
  const [sdkImagesOpen, setSdkImagesOpen] = useState(false);
  useEffect(() => {
    if (!sdkImagesOpen) return;
    let cancelled = false;
    api
      .listAvailableSystemImages()
      .then(({ systemImages: images }) => {
        if (cancelled) return;
        setAvailableImages(images);
        setAvailableLoaded(true);
        setAvailableError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAvailableError(
          err instanceof ApiError ? err.message : "Could not load available system images",
        );
        setAvailableLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sdkImagesOpen]);

  // Distinct variant tags present, in first-seen order (the list is already
  // sorted newest-API-first by the backend, so the option order follows that).
  const variantOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const img of availableImages) {
      if (!seen.has(img.tag)) seen.set(img.tag, img.tagDisplay);
    }
    return [...seen.entries()].map(([tag, label]) => ({ value: tag, label }));
  }, [availableImages]);

  // Distinct API levels, newest first; codename levels (canary previews)
  // sort above numeric ones — same rule as the backend's own list sort.
  const apiOptions = useMemo(() => {
    const levels = [...new Set(availableImages.map((img) => img.apiLevel))];
    levels.sort((a, b) => {
      const aNum = parseInt(a, 10);
      const bNum = parseInt(b, 10);
      const aIsNaN = Number.isNaN(aNum);
      const bIsNaN = Number.isNaN(bNum);
      if (aIsNaN && !bIsNaN) return -1;
      if (!aIsNaN && bIsNaN) return 1;
      if (aIsNaN && bIsNaN) return a.localeCompare(b);
      return bNum - aNum;
    });
    return levels.map((level) => ({ value: level, label: `API ${level}` }));
  }, [availableImages]);

  // Trim once — both anyNarrowFilter and the filter predicate below read
  // the same value (Hermes review, PR #1386).
  const availableQueryTrimmed = availableQuery.trim();
  const anyNarrowFilter =
    availableVariant !== "" || availableApi !== "" || availableQueryTrimmed !== "";

  const filteredAvailable = availableImages.filter((img) => {
    if (availableFilter === "installable" && img.installed) return false;
    if (availableFilter === "installed" && !img.installed) return false;
    if (availableVariant !== "" && img.tag !== availableVariant) return false;
    if (availableApi !== "" && img.apiLevel !== availableApi) return false;
    if (
      availableQueryTrimmed !== "" &&
      !matchesQuery([img.packagePath, img.tagDisplay, img.apiLevel, img.abi], availableQueryTrimmed)
    ) {
      return false;
    }
    return true;
  });

  const handleInstall = (packagePath: string) => {
    pendingInstallRef.current = packagePath;
    installOp.install(packagePath);
  };

  // Detect license rejection errors from install and open the license modal.
  // The backend signals license errors with a structured code field.
  useEffect(() => {
    if (installOp.status === "error" && installOp.errorCode === "license") {
      setPendingInstallPath(pendingInstallRef.current);
      setShowLicenseModal(true);
    }
  }, [installOp.status, installOp.errorCode]);

  const handleLicenseAccept = () => {
    licenseOp.accept(() => {
      setShowLicenseModal(false);
      if (pendingInstallPath) {
        installOp.install(pendingInstallPath);
        setPendingInstallPath(null);
      }
    });
  };

  // Refresh available images after a successful install/uninstall.
  useEffect(() => {
    if (installOp.status !== "done") return;
    let cancelled = false;
    api
      .listAvailableSystemImages()
      .then(({ systemImages: images }) => {
        if (cancelled) return;
        setAvailableImages(images);
        setAvailableLoaded(true);
      })
      .catch(() => {
        // Non-critical — the stale list will still render; the user can
        // re-open the section to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [installOp.status]);

  // Refresh the installed-image list the New-AVD dropdown reads so a freshly
  // installed image (e.g. a Play Store image) shows up without reopening the
  // form. Only while the form is already open — reopening after the fact is
  // covered by the newAvdOpen effect above — so opening the form later never
  // fires this effect a second time for the same install.
  const newAvdOpenRef = useRef(newAvdOpen);
  useEffect(() => {
    newAvdOpenRef.current = newAvdOpen;
  }, [newAvdOpen]);
  useEffect(() => {
    if (installOp.status !== "done" || !newAvdOpenRef.current) return;
    let cancelled = false;
    api
      .listSystemImages()
      .then(({ systemImages: images }) => {
        if (cancelled) return;
        setSystemImages(images);
        setSelectedSystemImage((prev) =>
          prev && images.some((img) => img.packagePath === prev)
            ? prev
            : (images[0]?.packagePath ?? ""),
        );
      })
      .catch(() => {
        // Non-critical — same posture as above: the dropdown keeps its
        // current list and refetches the next time the form is opened.
      });
    return () => {
      cancelled = true;
    };
  }, [installOp.status]);

  // Issue #1347 — editing a physical device's stored adb address in place,
  // without delete-and-recreate. Keyed by device id (not a boolean) so only
  // one row's form is open at a time, same "single open form" shape the
  // create form above already has.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
    if (!isAvdNameValid(trimmedName) || !selectedSystemImage || !selectedDeviceProfile) {
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

  return (
    <>
      {serverInfo && !serverInfo.features.devices && (
        <div className="settings-footer-note" style={{ marginTop: 0, marginBottom: 12 }}>
          Android devices are turned off on this server. The server administrator can enable them.
        </div>
      )}
      <GroupHeading
        title="Android devices"
        desc="Emulators and phones whose screens you can open in a panel."
      />
      {!loaded && <div className="settings-readonly-value">Loading…</div>}
      {loaded && devices.length > 0 && (
        <StyledList>
          {devices.map((device) => (
            <Fragment key={device.id}>
              <ListRow
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
                    {device.kind === "physical" && device.status === "active" && (
                      <SecondaryButton
                        onClick={() => (editingId === device.id ? cancelEdit() : startEdit(device))}
                      >
                        {editingId === device.id ? "Cancel" : "Edit address"}
                      </SecondaryButton>
                    )}
                    {device.status === "active" && (
                      <ConfirmButton
                        // Hermes review (PR #1341) — softened from "its panel
                        // closes": nothing in this action closes an already-open
                        // device-<id> panel (that would need a DockviewApi this
                        // Settings-owned slice doesn't have, per the design's
                        // own "Settings owns no DockviewApi" reasoning above);
                        // DevicePane just goes on to show a disconnected/stopped
                        // state once its emulator/scrcpy session is torn down.
                        title={`Delete ${device.name || device.avdName || device.serial}. Its stream stops and any open panel shows it as disconnected.`}
                        onConfirm={() => remove(device)}
                        disabled={deleting[device.id] ?? false}
                      >
                        Delete
                      </ConfirmButton>
                    )}
                  </div>
                }
              />
              {editingId === device.id && (
                <div style={{ padding: "8px 12px" }}>
                  <Row
                    label="New address"
                    desc="The IP address and port shown under Developer options → Wireless debugging on the phone. If the phone needs a new pairing code, delete it and pair it again."
                  >
                    <div className="settings-numberfield" style={{ width: 220 }}>
                      <input
                        style={{ flex: 1, textAlign: "left", width: "auto" }}
                        placeholder="192.168.1.23:37251"
                        value={editAddress}
                        onChange={(e) => setEditAddress(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitEdit(device);
                        }}
                        autoFocus
                      />
                    </div>
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
          ))}
        </StyledList>
      )}
      {deleteError && <ErrorText style={{ marginTop: 8 }}>{deleteError}</ErrorText>}

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <AddButton onClick={() => setPairOpen(true)}>
          <PlusIcon size={13} />
          Pair a phone or tablet
        </AddButton>
        <AddButton
          onClick={() => {
            // Self-review (code-review high) — without this, closing the
            // form after a failed create (e.g. DEVICE_ENABLED=false) and
            // reopening it shows that same stale error before the user has
            // typed or submitted anything.
            setCreateError(null);
            setCreateAvdError(null);
            setNewAvdOpen(false);
            setCreateOpen((open) => !open);
          }}
        >
          <PlusIcon size={13} />
          Create an emulator
        </AddButton>
      </div>
      {pairOpen && (
        <PairDeviceDialog onClose={() => setPairOpen(false)} onPaired={() => setPairOpen(false)} />
      )}

      {loaded && devices.length === 0 && loadError && (
        <ErrorText style={{ marginTop: 10 }}>Couldn't load devices.</ErrorText>
      )}
      {loaded && devices.length === 0 && !loadError && !createOpen && (
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 10 }}>
          No Android devices yet. Pair a phone or create an emulator to open its screen from the
          sidebar.
        </div>
      )}

      {createOpen && (
        <div style={{ marginTop: 10 }}>
          {!avdsLoaded && (
            <div className="settings-readonly-value" style={{ marginTop: 4 }}>
              Loading AVDs…
            </div>
          )}
          {avdsLoaded && avds.length > 0 && (
            <Row label="Virtual device" desc="An Android virtual device (AVD) on this host.">
              <Dropdown
                options={avds.map((n) => ({ value: n, label: n }))}
                value={avdName}
                onChange={setAvdName}
              />
            </Row>
          )}
          {avdsLoaded && !avdsError && avds.length === 0 && !newAvdOpen && (
            <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
              No virtual devices on this host yet. Create one below.
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
                <div className="settings-numberfield" style={{ width: 220 }}>
                  <input
                    style={{ flex: 1, textAlign: "left", width: "auto" }}
                    placeholder="Pixel_8_API_35"
                    value={newAvdName}
                    onChange={(e) => setNewAvdName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitCreateAvd();
                    }}
                    aria-invalid={avdNameError !== null}
                  />
                </div>
              </Row>
              {/* The Row desc above states the allowed set; this error
                      names what's wrong with *this* value so Create AVD's
                      disabled state (e.g. "Pixel 10 Pro XL" or "   ") isn't a
                      silent mystery. role="alert" is the announce channel —
                      no aria-describedby here, to avoid double-reading. */}
              {avdNameError !== null && (
                <ErrorText style={{ marginTop: 4 }}>{avdNameError}</ErrorText>
              )}
              {!provisioningLoaded && (
                <div className="settings-readonly-value" style={{ marginTop: 4 }}>
                  Loading system images and device profiles…
                </div>
              )}
              {provisioningLoaded && systemImages.length > 0 && (
                <Row label="System image" desc="An Android system image installed on this host.">
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
                <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4 }}>
                  No device profiles found. Check the Android SDK command-line tools installation.
                </div>
              )}
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

          <div style={{ marginTop: 14 }}>
            <Row label="Name" desc="Optional. Defaults to the virtual device name.">
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
        </div>
      )}

      {/* SDK system images section */}
      <div style={{ marginTop: 20 }}>
        <GroupHeading
          title="SDK system images"
          desc="Install Android system images from Google. You need one to create a virtual device."
        />

        {!sdkImagesOpen && (
          <div style={{ marginTop: 8 }}>
            <SecondaryButton onClick={() => setSdkImagesOpen(true)}>
              Load available images
            </SecondaryButton>
          </div>
        )}

        {sdkImagesOpen && !availableLoaded && (
          <div className="settings-readonly-value" style={{ marginTop: 8 }}>
            Loading available images…
          </div>
        )}
        {availableError && <ErrorText style={{ marginTop: 8 }}>{availableError}</ErrorText>}

        {availableLoaded && !availableError && (
          <>
            {/* Filter bar — installed-status segmented + variant/API dropdowns
                + free-text search. All four AND together. */}
            <div className="settings-image-filters">
              <Segmented
                options={[
                  { value: "all", label: "All" },
                  { value: "installable", label: "Not installed" },
                  { value: "installed", label: "Installed" },
                ]}
                value={availableFilter}
                onChange={setAvailableFilter}
              />
              <Dropdown
                options={[{ value: "", label: "All variants" }, ...variantOptions]}
                value={availableVariant}
                onChange={setAvailableVariant}
                small
              />
              <Dropdown
                options={[{ value: "", label: "All APIs" }, ...apiOptions]}
                value={availableApi}
                onChange={setAvailableApi}
                small
              />
              <div className="settings-image-filters-search">
                <SearchIcon size={13} strokeWidth={1.9} />
                <input
                  type="text"
                  placeholder="Filter images…"
                  value={availableQuery}
                  onChange={(e) => setAvailableQuery(e.target.value)}
                  aria-label="Filter system images"
                />
                {availableQuery !== "" && (
                  <button
                    type="button"
                    className="settings-image-filters-clear"
                    // title alone has inconsistent screen-reader exposure —
                    // icon-only button needs its own accessible name (Hermes
                    // review, PR #1386), same posture as ConfirmButton.
                    aria-label="Clear filter"
                    title="Clear filter"
                    onClick={() => setAvailableQuery("")}
                  >
                    <CloseIcon size={10} />
                  </button>
                )}
              </div>
            </div>

            {/* Images list */}
            {filteredAvailable.length === 0 && (
              <div style={{ fontSize: 11.5, color: "var(--dim)" }}>
                {anyNarrowFilter
                  ? "No images match the current filters."
                  : availableFilter === "installable"
                    ? "All available images are already installed."
                    : availableFilter === "installed"
                      ? "No system images installed yet."
                      : "No system images available."}
              </div>
            )}
            {filteredAvailable.length > 0 && (
              <StyledList>
                {filteredAvailable.map((img) => (
                  <ListRow
                    key={img.packagePath}
                    stacked
                    title={`API ${img.apiLevel} — ${img.tagDisplay} (${img.abi})`}
                    subtitle={img.packagePath}
                    trailing={
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {img.installed ? (
                          <ConfirmButton
                            title={`Uninstall ${img.packagePath} — removes this system image from the host`}
                            onConfirm={() => installOp.uninstall(img.packagePath)}
                            disabled={installOp.status === "running"}
                          >
                            Uninstall
                          </ConfirmButton>
                        ) : (
                          <SecondaryButton
                            onClick={() => handleInstall(img.packagePath)}
                            disabled={installOp.status === "running"}
                          >
                            Install
                          </SecondaryButton>
                        )}
                      </div>
                    }
                  />
                ))}
              </StyledList>
            )}

            {/* Install/uninstall progress */}
            {installOp.status === "running" && (
              <div style={{ marginTop: 10 }}>
                <ProgressBar />
                {installOp.progress.length > 0 && (
                  <div className="sdk-operation-log" style={{ marginTop: 8 }}>
                    {installOp.progress.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {installOp.status === "done" && (
              <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 8 }}>
                Operation complete.
              </div>
            )}
            {installOp.status === "error" && (
              <ErrorText style={{ marginTop: 8 }}>{installOp.error}</ErrorText>
            )}
          </>
        )}
      </div>

      {/* License acceptance modal */}
      {showLicenseModal && (
        <Modal onClose={() => setShowLicenseModal(false)} title="Accept SDK licenses">
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            Some Android SDK packages require accepting Google's license agreements before they can
            be installed. This accepts all pending SDK licenses on the host.
          </div>
          {licenseOp.status === "running" && (
            <div style={{ marginTop: 10 }}>
              <ProgressBar />
              {licenseOp.progress.length > 0 && (
                <div className="sdk-operation-log" style={{ marginTop: 8 }}>
                  {licenseOp.progress.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {licenseOp.status === "error" && (
            <ErrorText style={{ marginTop: 8 }}>{licenseOp.error}</ErrorText>
          )}
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            {licenseOp.status !== "running" && (
              <SecondaryButton onClick={handleLicenseAccept}>Accept licenses</SecondaryButton>
            )}
            <SecondaryButton onClick={() => setShowLicenseModal(false)}>Cancel</SecondaryButton>
          </div>
        </Modal>
      )}
    </>
  );
}
