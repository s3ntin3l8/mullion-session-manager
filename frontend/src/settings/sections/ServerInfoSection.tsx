import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import type { ServerInfo, UpdateCheckResult, UpdateStatus } from "../../api.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { Eyebrow, SecondaryButton } from "../../ui/primitives.js";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ServerInfoSection() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return <div className="settings-readonly-value">Loading…</div>;

  return (
    <>
      <div className="settings-health-banner">
        <span className="settings-health-dot" />
        <span className="settings-health-label">Healthy</span>
        <span className="settings-health-status">/health · /ready → 200</span>
        <span className="settings-health-uptime">uptime {formatUptime(info.uptimeSeconds)}</span>
      </div>

      <div className="settings-stat-grid">
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
      </div>

      <div className="settings-footer-note">
        Read-only diagnostics from deploy-time configuration. Values reflect the running process and
        cannot be edited here.
      </div>

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
            // reload so every other tab/websocket reconnects against it
            // too, rather than leaving this whole dashboard talking to a
            // stale in-memory app state.
            if (s.phase === "done") setTimeout(() => window.location.reload(), 1500);
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
      <Eyebrow title="Updates" desc="Checks this project's GitHub releases for a newer version." />

      {checkError && (
        <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
          {checkError}
        </div>
      )}

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
          Auto-update requires a versioned-release install (<code>MULLION_HOME</code>) — see{" "}
          <code>deploy/README.md</code>.
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
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          Update failed: {status.error || "unknown error"}
        </div>
      )}
      {status?.phase === "done" && <div className="settings-footer-note">Updated — reloading…</div>}
      {applyError && (
        <div style={{ fontSize: 12, color: "var(--r)", marginTop: 8 }} role="alert">
          {applyError}
        </div>
      )}
    </>
  );
}
