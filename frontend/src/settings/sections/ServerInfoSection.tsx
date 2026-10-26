import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { ServerInfo, UpdateCheckResult, UpdateStatus } from "../../api/index.js";
import type { SystemStats } from "../../api/index.js";
import { usePolling } from "../../hooks/usePolling.js";
import { useAsyncData } from "../../hooks/useAsyncData.js";
import { describeError } from "../../lib/describeError.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { Eyebrow, SecondaryButton } from "../../ui/primitives.js";
import { LogLevelSetting } from "../RuntimeSettings.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { claimPostUpdateReload } from "../../postUpdateReload.js";
import { formatBytes } from "../../formatBytes.js";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// The two failure headlines. Each names WHAT failed, so the reader is never
// left guessing which of the section's numbers is missing — the detail
// after it says why.
const SERVER_INFO_ERROR = "Could not load the server status.";
const SYSTEM_STATS_ERROR = "Could not load the CPU and RAM figures.";

// Same composition as the store's reportError(): the headline first, the
// raw error text after it, and no trailing detail when the error carried
// none of its own.
function failureMessage(headline: string, err: unknown): string {
  const detail = describeError(err, "");
  return detail ? `${headline} ${detail}` : headline;
}

export function ServerInfoSection() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  // A token per probe: each Retry re-runs only its own fetch, so a retry of
  // the stats probe can't fail the info probe behind the user's back (a
  // failure of a probe whose data is already on screen has nowhere to go).
  // Same "bump a token, the effect re-runs" shape CreateProjectModal.tsx
  // uses for its own retriable fetch.
  const [infoReloadToken, setInfoReloadToken] = useState(0);
  const [statsReloadToken, setStatsReloadToken] = useState(0);

  const reloadInfo = () => setInfoReloadToken((n) => n + 1);
  const reloadStats = () => setStatsReloadToken((n) => n + 1);

  // `null` used to mean BOTH "still loading" and "the request failed", so a
  // failed fetch rendered "Loading…" forever and the user was told nothing
  // (audit finding 13). The failures are their own state now, so the section
  // can say what went wrong and offer a Retry.
  useAsyncData(
    () => api.getServerInfo(),
    (next) => {
      setInfo(next);
      setInfoError(null);
    },
    (err: unknown) => {
      setInfoError(failureMessage(SERVER_INFO_ERROR, err));
    },
    [infoReloadToken],
    // Clears the previous failure as the new request starts, so a retry that
    // succeeds shows the data instead of the old error.
    { onStart: () => setInfoError(null) },
  );

  // CPU and RAM load on their own; nothing here waits on the disk probes.
  useAsyncData(
    () => api.getSystemStats(),
    (next) => {
      setStats(next);
      setStatsError(null);
    },
    (err: unknown) => {
      // The figures are CLEARED, not kept: this section says the stats
      // failed "in place" rather than going blank, so the error and the
      // CPU/RAM cards are mutually exclusive by construction. Leaving the
      // old figures in state would make "the probe failed" and "these are
      // the last known figures" indistinguishable — and no trigger can
      // produce that state today (the only way to re-run this probe is
      // the Retry button, which exists only once the error is set), so it
      // would be a distinction nothing could ever reach. The surfaces
      // where the stale case IS reachable — the sidebar's project list and
      // the git panel's status — keep the last-known-good data and mark it
      // stale instead.
      setStats(null);
      setStatsError(failureMessage(SYSTEM_STATS_ERROR, err));
    },
    [statsReloadToken],
    { onStart: () => setStatsError(null) },
  );

  if (!info) {
    if (infoError) {
      return (
        <>
          <ErrorText>{infoError}</ErrorText>
          <div style={{ marginTop: 10 }}>
            <SecondaryButton onClick={reloadInfo}>Retry</SecondaryButton>
          </div>
        </>
      );
    }
    // Banner, then the two-by-two stat cards, then the info lines — the
    // shape this section has once the probe lands. The word "Loading…"
    // gave none of that, so the cards jumped in. The status is clipped
    // off screen. The bones are hidden, so they do not carry aria-busy:
    // a busy state on an aria-hidden node is never exposed, and putting
    // it on an ancestor of the status would defer the announcement.
    return (
      <div>
        <span className="visually-hidden" role="status">
          Loading server status
        </span>
        <div className="ui-skeleton-stack" aria-hidden="true">
          <Skeleton height={40} radius={11} />
          <div className="settings-stat-grid">
            <Skeleton height={58} radius={10} />
            <Skeleton height={58} radius={10} />
            <Skeleton height={58} radius={10} />
            <Skeleton height={58} radius={10} />
          </div>
          <Skeleton height={14} />
          <Skeleton height={14} width="86%" />
          <Skeleton height={14} width="72%" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-health-banner">
        <span className="settings-health-dot" />
        <span className="settings-health-label">Healthy</span>
        <span className="settings-health-status">Server is responding</span>
        <span className="settings-health-uptime">uptime {formatUptime(info.uptimeSeconds)}</span>
      </div>

      <div className="settings-stat-grid">
        {/* The stats probe is its own, smaller failure: the CPU and RAM
            cards are simply missing, so the section says so in place
            rather than going blank. Spans the grid so the other cards
            (Version, Role, …) keep their own rows. */}
        {statsError && (
          <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
            <ErrorText style={{ flex: 1 }}>{statsError}</ErrorText>
            <SecondaryButton onClick={reloadStats}>Retry</SecondaryButton>
          </div>
        )}
        {stats && (
          <>
            <div className="settings-stat-card">
              <div className="settings-stat-label">CPU</div>
              <div className="settings-stat-value">
                {stats.cpu.loadAverage1m.toFixed(2)} 1m load / {stats.cpu.logicalCores} logical
                cores
              </div>
            </div>
            <div className="settings-stat-card">
              <div className="settings-stat-label">RAM</div>
              <div className="settings-stat-value">
                {formatBytes(stats.memory.freeBytes)} free / {formatBytes(stats.memory.totalBytes)}
              </div>
            </div>
          </>
        )}
        <div className="settings-stat-card">
          <div className="settings-stat-label">Version</div>
          <div className="settings-stat-value">{info.version}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Role</div>
          <div className="settings-stat-value">{info.role === "primary" ? "Primary" : "Agent"}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Environment</div>
          <div className="settings-stat-value">{info.nodeEnv}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Port</div>
          <div className="settings-stat-value">{info.port}</div>
        </div>
        <div className="settings-stat-card">
          <div className="settings-stat-label">Encryption at rest</div>
          <div className={`settings-stat-value${info.encryptionEnabled ? " good" : ""}`}>
            {info.encryptionEnabled && <span className="settings-stat-value-dot" />}
            {info.encryptionEnabled ? "On" : "Off"}
          </div>
        </div>
      </div>

      <div className="settings-info-table">
        <div className="settings-info-row zebra">
          <span className="settings-info-key">Sessions directory</span>
          <span className="settings-info-value">{info.sessionsDir}</span>
        </div>
        <div className="settings-info-row">
          <span className="settings-info-key">Database</span>
          <span className="settings-info-value">{info.dbPath}</span>
        </div>
        <div className="settings-info-row zebra">
          <span className="settings-info-key">Rate limit</span>
          <span className="settings-info-value">
            {info.rateLimit.max} req / {info.rateLimit.window}
          </span>
        </div>
        <div className="settings-info-row">
          <span className="settings-info-key">Browser pane</span>
          <span className="settings-info-value">{info.features.browser ? "On" : "Off"}</span>
        </div>
        <div className="settings-info-row zebra">
          <span className="settings-info-key">Android devices</span>
          <span className="settings-info-value">
            {info.features.devices
              ? `On${info.features.deviceDiscovery ? ", with network discovery" : ""}`
              : "Off"}
          </span>
        </div>
      </div>

      <div className="settings-footer-note">
        Set by the server administrator. These values can't be changed here.
      </div>

      <Eyebrow title="Logging" />
      <LogLevelSetting />

      <UpdatesSubsection />
    </>
  );
}

const UPDATE_STATUS_POLL_MS = 2000;

function UpdatesSubsection() {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // No setState call at the top level (only inside .then/.catch, deferred)
  // so this is safe to call directly from the mount effect below without
  // tripping react-hooks/set-state-in-effect.
  const fetchCheck = (force?: boolean) =>
    api
      .checkForUpdate(force)
      .then((result) => {
        setCheck(result);
        setCheckError(null);
      })
      .catch((err: unknown) => {
        setCheckError(err instanceof ApiError ? err.message : "Could not check for updates");
      });

  useEffect(() => {
    fetchCheck();
  }, []);

  const runCheck = () => {
    // Deliberately doesn't clear `check` first (Hermes review, PR #130) —
    // clearing it would hide the stat grid, "Last checked" label, and the
    // whole action row (gated on `check &&`) for the duration of the
    // refetch. Keeping the stale result on screen while `checking` is true
    // reads better than a flash of "Checking…" on every re-check.
    setCheckError(null);
    setChecking(true);
    fetchCheck(true).finally(() => setChecking(false));
  };

  // Polls only while an update is actually running — matches the
  // poll-until-terminal-state pattern in GitHubDeviceFlowModal.tsx.
  // `enabled: applying` both starts the poll AND, via usePolling's own
  // effect-restart-on-`enabled`-change, stops it once `setApplying(false)`
  // below takes effect on the next render — no explicit `clearInterval`
  // call needed here the way the pre-extraction effect had. `immediate:
  // false` matches the original: the first check was always the first
  // *interval* tick, `UPDATE_STATUS_POLL_MS` after `applying` became true.
  usePolling(
    () => {
      api
        .getUpdateStatus()
        .then((s) => {
          setStatus(s);
          if (s.phase === "done" || s.phase === "failed") {
            setApplying(false);
            // The server just restarted itself into the new release —
            // reload so this tab's own websocket reconnects against it too,
            // rather than leaving it talking to a stale in-memory app
            // state. Routed through claimPostUpdateReload() (issue #1008):
            // main.tsx's registerSW() reload (every open tab, on
            // service-worker activation) usually fires for this same tab
            // around the same time, and the two triggers don't otherwise
            // know about each other — without the guard, the tab that
            // initiated the update could reload twice in a row.
            if (s.phase === "done") {
              setTimeout(() => {
                if (claimPostUpdateReload()) window.location.reload();
              }, 1500);
            }
          }
        })
        .catch(() => {
          // A transient poll failure keeps the last known state on screen
          // rather than flashing an error for one missed beat.
        });
    },
    UPDATE_STATUS_POLL_MS,
    { enabled: applying, immediate: false },
  );

  const apply = () => {
    if (!check?.latestVersion || !check.assetUrl || !check.checksumUrl) return;
    setApplyError(null);
    setStatus({ phase: "downloading", version: check.latestVersion });
    setApplying(true);
    api
      .applyUpdate(check.latestVersion, check.assetUrl, check.checksumUrl)
      .catch((err: unknown) => {
        setApplying(false);
        setApplyError(err instanceof ApiError ? err.message : "Could not start the update");
      });
  };

  return (
    <>
      <Eyebrow title="Updates" desc="Checks GitHub releases for a newer version of Mullion." />

      {checkError && <ErrorText>{checkError}</ErrorText>}

      {!checkError && !check && <div className="settings-readonly-value">Checking…</div>}

      {check && (
        <div className="settings-stat-grid">
          <div className="settings-stat-card">
            <div className="settings-stat-label">Current</div>
            <div className="settings-stat-value">{check.currentVersion}</div>
          </div>
          <div className="settings-stat-card">
            <div className="settings-stat-label">Latest</div>
            <div
              className={`settings-stat-value${check.updateAvailable ? " warn" : check.latestVersion ? " good" : ""}`}
            >
              {check.updateAvailable && <span className="settings-stat-value-dot warn" />}
              {check.releaseUrl ? (
                <a href={check.releaseUrl} target="_blank" rel="noreferrer">
                  {check.latestVersion ?? "unknown"}
                </a>
              ) : (
                (check.latestVersion ?? "unknown")
              )}
            </div>
          </div>
        </div>
      )}

      {/* Distinguishes "checked just now" from "showing an hour-old cached
          result" — previously both looked identical (issue #123). */}
      {check && (
        <div className="settings-footer-note">
          Last checked: {formatRelativeAge(check.checkedAt)}
        </div>
      )}

      {check && !check.applyAvailable && (
        <div className="settings-footer-note">
          Automatic updates need a versioned install. See the deployment guide.
          {check.updateAvailable && " A newer version is available; update this host manually."}
        </div>
      )}

      {check && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
          {check.applyAvailable && check.updateAvailable && (
            <SecondaryButton
              onClick={apply}
              disabled={applying || !check.assetUrl || !check.checksumUrl}
            >
              {applying ? "Updating…" : "Update now"}
            </SecondaryButton>
          )}
          {/* Always available (not gated on applyAvailable) so a dev checkout
              can still force a fresh check, not just versioned-release
              installs (issue #123). */}
          <SecondaryButton onClick={runCheck} disabled={applying || checking}>
            {checking ? "Checking…" : "Check again"}
          </SecondaryButton>
          {check.applyAvailable &&
            check.updateAvailable &&
            (!check.assetUrl || !check.checksumUrl) && (
              <span className="settings-footer-note" style={{ marginTop: 0 }}>
                No installable release asset yet.
              </span>
            )}
          {applying && status && (
            <span className="settings-info-value" style={{ flex: "unset" }}>
              {status.phase}…
            </span>
          )}
        </div>
      )}

      {status?.phase === "failed" && (
        <ErrorText style={{ marginTop: 8 }}>
          Update failed: {status.error || "unknown error"}
        </ErrorText>
      )}
      {status?.phase === "done" && <div className="settings-footer-note">Updated — reloading…</div>}
      {applyError && <ErrorText style={{ marginTop: 8 }}>{applyError}</ErrorText>}
    </>
  );
}
