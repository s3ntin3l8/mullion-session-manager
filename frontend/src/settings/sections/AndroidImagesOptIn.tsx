import type { AndroidImagesStatus, ProbeMeta } from "../../api/index.js";
import { Toggle } from "../../ui/primitives.js";
import { formatBytes } from "../../formatBytes.js";
import { useDashboardStore } from "../../store/index.js";

const ID = "android-system-images";
const LABEL = "Also remove unused Android system images";

/**
 * Opt-in for the aggressive cleanup to uninstall SDK system images no AVD uses.
 * Shown when the SDK is configured and readable, or when the opt-in is already
 * saved, so a stale one can always be cleared.
 */
export function AndroidImagesOptIn({
  status,
}: {
  status: (AndroidImagesStatus & ProbeMeta) | null;
}) {
  const settings = useDashboardStore((s) => s.settings);
  const updateSettings = useDashboardStore((s) => s.updateSettings);
  const optIns = settings.diskCleanup.optIns;
  const on = optIns.includes(ID);
  if (!status?.available && !on) return null;
  const images = status?.available ? status.images : [];
  return (
    <div data-testid="android-images-optin">
      <div className="settings-info-row">
        <span className="settings-info-key">{LABEL}</span>
        <span className="settings-info-value">
          <Toggle
            size="small"
            on={on}
            ariaLabel={LABEL}
            onChange={(next) =>
              updateSettings({
                diskCleanup: {
                  cacheDirs: settings.diskCleanup.cacheDirs,
                  optIns: next
                    ? [...optIns.filter((id) => id !== ID), ID]
                    : optIns.filter((id) => id !== ID),
                },
              })
            }
          />
        </span>
      </div>
      {status && !status.available && (
        <div className="settings-footer-note">Nothing will be removed: {status.error}</div>
      )}
      {status?.available && images.length === 0 && (
        <div className="settings-footer-note">Every installed system image is used by an AVD.</div>
      )}
      {images.length > 0 && (
        <ul className="settings-footer-note" data-testid="android-images-list">
          {images.map((image) => (
            <li key={image.packagePath}>
              <code>{image.packagePath}</code> · {formatBytes(image.bytes)}
            </li>
          ))}
        </ul>
      )}
      <div className="settings-footer-note">
        Removed with sdkmanager; using one of these again means downloading it again. Images an AVD
        uses are never removed. Aggressive cleanup only.
      </div>
    </div>
  );
}
