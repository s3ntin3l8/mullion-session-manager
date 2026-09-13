import { useState } from "react";
import { api } from "./api/index.js";
import type { ResourceSeverity, SystemStats } from "./api/index.js";
import { usePolling } from "./hooks/usePolling.js";
import { WarningTriangleIcon } from "./ui/icons.js";

const POLL_MS = 60_000;
const DISMISS_MS = 24 * 60 * 60 * 1000;
const DISMISS_KEY = "mullion:storage-warning-dismissed-at";

function dismissedRecently(): boolean {
  try {
    const value = localStorage.getItem(DISMISS_KEY);
    return value !== null && Date.now() - Number(value) < DISMISS_MS;
  } catch {
    return false;
  }
}

function worstSeverity(stats: SystemStats | null): ResourceSeverity {
  if (stats?.filesystems.some((filesystem) => filesystem.severity === "critical")) {
    return "critical";
  }
  if (stats?.filesystems.some((filesystem) => filesystem.severity === "warning")) {
    return "warning";
  }
  return "normal";
}

export function ResourceAlertBanner({ onOpenServer }: { onOpenServer: () => void }) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [dismissed, setDismissed] = useState(dismissedRecently);

  usePolling(
    () => {
      void api
        .getSystemStats()
        .then(setStats)
        .catch(() => {});
    },
    POLL_MS,
    { pauseWhenHidden: true },
  );

  const severity = worstSeverity(stats);
  if (severity === "normal" || (severity === "warning" && dismissed)) return null;

  const affected =
    stats?.filesystems
      .filter((filesystem) => filesystem.severity === severity)
      .flatMap((filesystem) => filesystem.labels)
      .join(", ") ?? "server storage";

  return (
    <div
      className={`update-banner resource-alert ${severity}`}
      onClick={onOpenServer}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onOpenServer();
      }}
    >
      <WarningTriangleIcon size={16} style={{ flexShrink: 0 }} />
      <span className="update-banner-title">
        {severity === "critical" ? "Critical disk space" : "Low disk space"}: {affected}
      </span>
      <span className="update-banner-subtext">Open Server info</span>
      {severity === "warning" && (
        <span
          className="update-banner-dismiss"
          role="button"
          tabIndex={0}
          title="Dismiss for 24 hours"
          onClick={(event) => {
            event.stopPropagation();
            try {
              localStorage.setItem(DISMISS_KEY, String(Date.now()));
            } catch {
              // The in-memory dismissal still applies when storage is blocked.
            }
            setDismissed(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              try {
                localStorage.setItem(DISMISS_KEY, String(Date.now()));
              } catch {
                // See click path above.
              }
              setDismissed(true);
            }
          }}
        >
          ×
        </span>
      )}
    </div>
  );
}
