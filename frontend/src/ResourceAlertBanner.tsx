import { useState } from "react";
import { api } from "./api/index.js";
import type { ResourceSeverity, SystemStats } from "./api/index.js";
import { usePolling } from "./hooks/usePolling.js";
import { WarningTriangleIcon } from "./ui/icons.js";
import { ActionBanner } from "./ActionBanner.js";

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

export function ResourceAlertBanner({ onOpenStorage }: { onOpenStorage: () => void }) {
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

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // The in-memory dismissal still applies when storage is blocked.
    }
    setDismissed(true);
  };

  return (
    <ActionBanner
      className={`resource-alert ${severity}`}
      icon={<WarningTriangleIcon size={16} style={{ flexShrink: 0 }} />}
      title={`${severity === "critical" ? "Critical disk space" : "Low disk space"}: ${affected}`}
      subtext="Open server settings"
      onOpen={onOpenStorage}
      onDismiss={severity === "warning" ? dismiss : undefined}
      dismissTitle="Dismiss for 24 hours"
    />
  );
}
