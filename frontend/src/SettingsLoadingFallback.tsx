import { CloseIcon } from "./ui/icons.js";
import { Skeleton } from "./ui/Skeleton.js";

// Settings-specific Suspense fallback — the modal shell so clicking the
// gear icon shows the panel's shape while the chunk loads, rather than
// nothing happening for a beat. The backdrop stays clickable (onClose),
// matching Settings.tsx's own click-outside-to-close, so a slow chunk
// load doesn't strand the user unable to dismiss it.
//
// Issue #1885 — a centered spinner in an empty box tells you nothing
// about the nav rail and the section body that are about to land. Bones
// in those two columns keep the shape. The dialog carries aria-busy; the
// bones are hidden, and the status text is clipped off screen so the
// shell doesn't grow a visible "Loading…" next to its title.
export function SettingsLoadingFallback({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        aria-busy="true"
      >
        <div className="settings-modal-header">
          <h2 className="settings-modal-title">Settings</h2>
          <button
            className="settings-modal-close"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon size={15} />
          </button>
        </div>
        <span className="visually-hidden" role="status">
          Loading settings
        </span>
        <div className="settings-modal-body" aria-hidden="true">
          <div className="settings-nav">
            <div className="settings-nav-items">
              <div className="ui-skeleton-stack">
                <Skeleton height={34} radius={9} />
                <Skeleton height={28} />
                <Skeleton height={28} />
                <Skeleton height={28} width="80%" />
                <Skeleton height={28} />
                <Skeleton height={28} width="70%" />
              </div>
            </div>
          </div>
          <div className="settings-content">
            <div className="settings-content-header">
              <div className="ui-skeleton-stack">
                <Skeleton width={160} height={16} />
                <Skeleton width="70%" height={12} />
              </div>
            </div>
            <div className="cmux-scroll settings-content-body">
              <div className="ui-skeleton-stack">
                <Skeleton height={48} radius={9} />
                <Skeleton height={48} radius={9} />
                <Skeleton height={48} radius={9} />
                <Skeleton height={48} radius={9} width="92%" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
