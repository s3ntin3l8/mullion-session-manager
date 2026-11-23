import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { AvailableSystemImage } from "../../api/index.js";
import { matchesQuery } from "../../matchQuery.js";
import { useAsyncData } from "../../hooks/useAsyncData.js";
import type { useSystemImageInstall } from "../../hooks/useSystemImageInstall.js";
import type { useSdkLicenses } from "../../hooks/useSdkLicenses.js";
import {
  Dropdown,
  GroupHeading,
  ListRow,
  SecondaryButton,
  Segmented,
  StyledList,
} from "../../ui/primitives.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { ProgressBar } from "../../ui/ProgressBar.js";
import { Modal } from "../../ui/Modal.js";
import { Presence } from "../../ui/Presence.js";
import { CloseIcon, SearchIcon } from "../../ui/icons.js";

// Android SDK system images (install / uninstall, license acceptance): the
// Android half of Settings -> Devices, rendered under its Android section only.
// The install and license operations are owned by DevicesSection because the
// create form also reads the install status (to refresh its image list).
export function SdkSystemImages({
  installOp,
  licenseOp,
}: {
  installOp: ReturnType<typeof useSystemImageInstall>;
  licenseOp: ReturnType<typeof useSdkLicenses>;
}) {
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
  const [showLicenseModal, setShowLicenseModal] = useState(false);
  const [pendingInstallPath, setPendingInstallPath] = useState<string | null>(null);
  const pendingInstallRef = useRef<string | null>(null);

  // Available system images — fetched lazily, only once the SDK section is
  // actually expanded (same pattern as the AVD picker and provisioning data,
  // and the same `useAsyncData` shape — issue #2411).
  const [sdkImagesOpen, setSdkImagesOpen] = useState(false);
  useAsyncData(
    () => api.listAvailableSystemImages().then(({ systemImages: images }) => images),
    (images) => {
      setAvailableImages(images);
      setAvailableLoaded(true);
      setAvailableError(null);
    },
    (err: unknown) => {
      setAvailableError(
        err instanceof ApiError ? err.message : "Could not load available system images",
      );
      setAvailableLoaded(true);
    },
    [sdkImagesOpen],
    { enabled: sdkImagesOpen },
  );

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
      // An error this mount did not start (it was remounted mid-operation) has
      // nothing to retry after the licenses are accepted.
      if (!pendingInstallRef.current) return;
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
  useAsyncData(
    () => api.listAvailableSystemImages().then(({ systemImages: images }) => images),
    (images) => {
      setAvailableImages(images);
      setAvailableLoaded(true);
    },
    () => {
      // Non-critical — the stale list will still render; the user can
      // re-open the section to retry.
    },
    [installOp.status],
    { enabled: installOp.status === "done" },
  );

  return (
    <>
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
                ariaLabel="Installed status filter"
                options={[
                  { value: "all", label: "All" },
                  { value: "installable", label: "Not installed" },
                  { value: "installed", label: "Installed" },
                ]}
                value={availableFilter}
                onChange={setAvailableFilter}
              />
              <Dropdown
                ariaLabel="Variant filter"
                options={[{ value: "", label: "All variants" }, ...variantOptions]}
                value={availableVariant}
                onChange={setAvailableVariant}
                small
              />
              <Dropdown
                ariaLabel="API filter"
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
              <div style={{ fontSize: "0.71875rem", color: "var(--dim)" }}>
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
                            title={`Uninstall ${img.packagePath} — removes this system image from this machine`}
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
              <div style={{ fontSize: "0.6875rem", color: "var(--dim)", marginTop: 8 }}>
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
      <Presence when={showLicenseModal}>
        <Modal onClose={() => setShowLicenseModal(false)} title="Accept SDK licenses">
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 12 }}>
            Some Android SDK packages require accepting Google's license agreements before they can
            be installed. This accepts all pending SDK licenses on this machine.
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
      </Presence>
    </>
  );
}
