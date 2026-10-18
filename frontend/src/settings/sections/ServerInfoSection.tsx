import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/index.js";
import type { ServerInfo, UpdateCheckResult, UpdateStatus } from "../../api/index.js";
import type {
  DockerPruneMode,
  DockerStorageStatus,
  SystemStats,
  TempStorageStatus,
  CacheStorageStatus,
  OpencodeStorageStatus,
  DevWorktreeCandidate,
  DevWorktreeStatus,
} from "../../api/index.js";
import { usePolling } from "../../hooks/usePolling.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { Eyebrow, SecondaryButton, Toggle } from "../../ui/primitives.js";
import { LogLevelSetting } from "../RuntimeSettings.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { claimPostUpdateReload } from "../../postUpdateReload.js";
import { formatBytes } from "../../formatBytes.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { useDashboardStore } from "../../store/index.js";

function describeWorktree(candidate: DevWorktreeCandidate): string {
  const kind = candidate.kind === "claude-agent" ? "Claude agent" : "worktree";
  const why =
    candidate.reason === "gone"
      ? "branch deleted on the remote"
      : candidate.reason === "merged"
        ? `PR ${candidate.detail ?? ""} merged`.trim()
        : "already in the default branch";
  return `${kind}, ${why}`;
}

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
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [docker, setDocker] = useState<DockerStorageStatus | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [temp, setTemp] = useState<TempStorageStatus | null>(null);
  const [caches, setCaches] = useState<CacheStorageStatus | null>(null);
  const [opencode, setOpencode] = useState<OpencodeStorageStatus | null>(null);
  const [worktrees, setWorktrees] = useState<DevWorktreeStatus | null>(null);
  const settings = useDashboardStore((s) => s.settings);
  const updateSettings = useDashboardStore((s) => s.updateSettings);
  const selectedCaches = settings.diskCleanup.cacheDirs;
  const hasCaches = !!caches?.available && caches.caches.some((c) => c.exists);
  const hasOpencode = !!opencode?.available && opencode.reclaimableBytes > 0;
  const hasWorktrees = !!worktrees?.available && worktrees.candidates.length > 0;
  // A cache that was opted in but has since disappeared from disk stays listed
  // (as "not found") so the stale opt-in can still be cleared.
  const visibleCaches = (caches?.caches ?? []).filter(
    (c) => c.exists || selectedCaches.includes(c.id),
  );
  const [pruningMode, setPruningMode] = useState<DockerPruneMode | null>(null);
  const pruning = pruningMode !== null;
  const [pruneResult, setPruneResult] = useState<string | null>(null);

  // Walks every project's worktrees (a git status each, and GitHub for the
  // unpushed ones), so it can be slow: loaded on its own, never holding up the
  // rest of the page.
  const refreshWorktrees = () =>
    api
      .getDevWorktrees()
      .then(setWorktrees)
      .catch(() => setWorktrees(null));

  const refreshResources = () => {
    void refreshWorktrees();
    return Promise.all([
      api.getSystemStats(),
      api.getDockerStorage(),
      api.getTempStorage().catch(() => null),
      api.getCacheStorage().catch(() => null),
      api.getOpencodeStorage().catch(() => null),
    ])
      .then(([nextStats, nextDocker, nextTemp, nextCaches, nextOpencode]) => {
        setStats(nextStats);
        setDocker(nextDocker);
        setTemp(nextTemp);
        setCaches(nextCaches);
        setOpencode(nextOpencode);
        setResourceError(null);
      })
      .catch((error: unknown) => {
        setResourceError(error instanceof ApiError ? error.message : "Could not load resources");
      });
  };

  useEffect(() => {
    api
      .getServerInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void refreshResources();
  }, []);

  const runPrune = (mode: DockerPruneMode) => {
    setPruningMode(mode);
    setPruneResult(null);
    void (async () => {
      try {
        const settle = async (
          fallback: string,
          run: () => Promise<{ reclaimedBytes: number; error?: string }>,
        ) => {
          try {
            return await run();
          } catch (error: unknown) {
            return {
              reclaimedBytes: 0,
              error: error instanceof ApiError ? error.message : fallback,
            };
          }
        };
        const dockerResult = docker?.available
          ? await settle("Docker cleanup failed.", () => api.pruneDockerStorage(mode))
          : null;
        const tempResult = temp?.available
          ? await settle("Temp file cleanup failed.", () => api.pruneTempStorage(mode))
          : null;
        // Caches are opt-in and aggressive-only; the server reads which ones
        // from the saved settings.
        const cacheResult =
          mode === "aggressive" && caches?.available && selectedCaches.length > 0
            ? await settle("Cache cleanup failed.", () => api.pruneCacheStorage(selectedCaches))
            : null;
        // Aggressive-only, and only while opencode isn't running (the server
        // re-checks, so a session that started since this loaded is still safe).
        const opencodeResult =
          mode === "aggressive" &&
          hasOpencode &&
          !opencode?.inUse &&
          !opencode?.holdersUnknown &&
          !opencode?.compacting
            ? await settle(
                "The request ended before opencode's database cleanup reported back; it may still be running.",
                () => api.pruneOpencodeStorage(),
              )
            : null;
        // Aggressive-only; the server decides which worktrees are stale.
        // Always in aggressive mode, whatever the preview says: it may still be
        // loading (it is the slow one), have failed, or be as of the last fetch,
        // and fetching is the first thing the cleanup does. The server decides
        // what is stale.
        const worktreeResult =
          mode === "aggressive"
            ? await settle("Developer worktree cleanup failed.", () => api.pruneDevWorktrees())
            : null;
        // Usually nothing, so only worth a mention when it did something.
        const worktreePart =
          worktreeResult && (worktreeResult.reclaimedBytes > 0 || worktreeResult.error)
            ? worktreeResult
            : null;
        const parts = [
          ["Docker", dockerResult],
          ["temp files", tempResult],
          ["caches", cacheResult],
          ["opencode database", opencodeResult],
          ["developer worktrees", worktreePart],
        ].filter((part): part is [string, NonNullable<typeof dockerResult>] => part[1] !== null);
        const total = parts.reduce((sum, [, result]) => sum + result.reclaimedBytes, 0);
        const errors = parts
          .map(([, result]) => result.error)
          .filter(Boolean)
          .join("; ");
        let message = `Freed ${formatBytes(total)}`;
        if (parts.length > 1) {
          message += ` (${parts
            .map(([label, result]) => `${label} ${formatBytes(result.reclaimedBytes)}`)
            .join(", ")})`;
        }
        setPruneResult(
          !errors ? `${message}.` : total === 0 ? errors : `${message}, then stopped: ${errors}`,
        );
      } finally {
        setPruningMode(null);
        await refreshResources();
      }
    })();
  };

  if (!info) return <div className="settings-readonly-value">Loading…</div>;

  return (
    <>
      <div className="settings-health-banner">
        <span className="settings-health-dot" />
        <span className="settings-health-label">Healthy</span>
        <span className="settings-health-status">Server is responding</span>
        <span className="settings-health-uptime">uptime {formatUptime(info.uptimeSeconds)}</span>
      </div>

      <div className="settings-stat-grid">
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

      <Eyebrow title="Storage" desc="Disks used by Mullion's data, sessions, and projects." />
      {resourceError && <ErrorText>{resourceError}</ErrorText>}
      {stats?.filesystems.map((filesystem) => (
        <div className="settings-info-table" key={`${filesystem.paths[0]}:${filesystem.labels[0]}`}>
          <div className="settings-info-row">
            <span className="settings-info-key">{filesystem.labels.join(", ")}</span>
            <span
              className={`settings-info-value resource-${filesystem.severity ?? "unavailable"}`}
            >
              {filesystem.available &&
              filesystem.freeBytes !== undefined &&
              filesystem.totalBytes !== undefined &&
              filesystem.freePercent !== undefined
                ? `${formatBytes(filesystem.freeBytes)} free / ${formatBytes(filesystem.totalBytes)} (${filesystem.freePercent.toFixed(1)}%)`
                : (filesystem.error ?? "Unavailable")}
            </span>
          </div>
          <div className="settings-info-row zebra">
            <span className="settings-info-key">Paths</span>
            <span className="settings-info-value">{filesystem.paths.join(", ")}</span>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <SecondaryButton
          onClick={() => {
            setResourceError(null);
            void refreshResources();
          }}
        >
          Refresh resources
        </SecondaryButton>
      </div>

      <Eyebrow title="Disk cleanup" desc="Measured when this page opens or refreshes." />
      {!docker && <div className="settings-readonly-value">Analyzing Docker…</div>}
      {docker && !docker.available && (
        <div className="settings-footer-note">
          Docker cleanup unavailable:{" "}
          {docker.error ?? "Docker is not installed or permission was denied."}
        </div>
      )}
      {docker?.available && (
        <>
          <div className="settings-stat-grid">
            <div className="settings-stat-card">
              <div className="settings-stat-label">Docker usage</div>
              <div className="settings-stat-value">{formatBytes(docker.totalSizeBytes)}</div>
            </div>
            <div className="settings-stat-card">
              <div className="settings-stat-label">Docker: safe frees ≈</div>
              <div className="settings-stat-value">
                {docker.estimates?.safeBytes == null
                  ? "unknown"
                  : formatBytes(docker.estimates.safeBytes)}
              </div>
            </div>
            <div className="settings-stat-card">
              <div className="settings-stat-label">Docker: aggressive frees ≈</div>
              <div className="settings-stat-value">
                {formatBytes(docker.estimates?.aggressiveBytes ?? docker.reclaimableBytes)}
              </div>
            </div>
          </div>
          <div className="settings-footer-note">
            Safe cleanup removes dangling images (any age), plus stopped containers and unused
            networks older than 7 days, and build cache older than 24 hours. Aggressive cleanup also
            removes <strong>all unused images, including tagged ones</strong> (they must be pulled
            or rebuilt again) and all unused build cache, and it drops the 7-day window for stopped
            containers and unused networks too. Neither uses <code>--volumes</code>, so volumes are
            always preserved. Figures are estimates.
          </div>
        </>
      )}
      {temp?.available && (
        <>
          <div className="settings-stat-grid">
            <div className="settings-stat-card">
              <div className="settings-stat-label">Temp files: safe frees ≈</div>
              <div className="settings-stat-value">{formatBytes(temp.estimates.safeBytes)}</div>
            </div>
            <div className="settings-stat-card">
              <div className="settings-stat-label">Temp files: aggressive frees ≈</div>
              <div className="settings-stat-value">
                {formatBytes(temp.estimates.aggressiveBytes)}
              </div>
            </div>
          </div>
          <div className="settings-footer-note">
            Temp cleanup only touches entries in <code>{temp.root}</code> owned by this server's
            user, and skips sockets and live tool caches. Safe removes entries untouched for 7+
            days; aggressive uses a 24-hour window and also clears the npm cache (an{" "}
            <code>npm ci</code> running in a session at that moment may fail). Claude scratch under{" "}
            <code>claude-*</code> is cleaned per session, and only for sessions that are no longer
            running: safe after 24 hours, aggressive after 10 minutes. The same windows cover
            bundled skills of Claude Code versions nobody is running and empty project folders;
            other stray files and folders there follow the general 7-day / 24-hour windows.
          </div>
          {temp.claudeScratch.skipped && (
            <div className="settings-footer-note">
              Claude scratch under <code>claude-*</code> is being left alone:{" "}
              {temp.claudeScratch.skipped}.
            </div>
          )}
          {temp.claudeScratch.warnings.length > 0 && (
            <div className="settings-footer-note">
              Skipped session registry files:
              <ul>
                {temp.claudeScratch.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {opencode?.available && (
        <>
          <div className="settings-stat-grid">
            <div className="settings-stat-card">
              <div className="settings-stat-label">opencode database</div>
              <div className="settings-stat-value">{formatBytes(opencode.fileBytes)}</div>
            </div>
            <div className="settings-stat-card">
              <div className="settings-stat-label">opencode database: aggressive frees</div>
              <div className="settings-stat-value">{formatBytes(opencode.reclaimableBytes)}</div>
            </div>
          </div>
          <div className="settings-footer-note">
            <code>{opencode.path}</code> keeps the space of every session it has deleted. Aggressive
            cleanup compacts it (<code>VACUUM</code>), which loses no session data and returns the
            exact figure shown.{" "}
            {opencode.compacting
              ? "It is being compacted right now, which can take several minutes; the figures above are from before it started."
              : opencode.inUse
                ? "opencode is running right now, so this is skipped until it is closed."
                : opencode.holdersUnknown
                  ? `Mullion couldn't tell whether opencode is running${
                      opencode.holdersUnknownReason ? ` (${opencode.holdersUnknownReason})` : ""
                    }, so this is skipped.`
                  : "It is skipped whenever opencode is running, and takes a minute or so on a large database."}
          </div>
        </>
      )}
      {hasWorktrees && worktrees && (
        <>
          <div className="settings-info-table">
            {worktrees.candidates.map((candidate, i) => (
              <div
                key={candidate.path}
                className={`settings-info-row${i % 2 === 0 ? " zebra" : ""}`}
              >
                <span className="settings-info-key">
                  {candidate.projectName} / {candidate.slug}
                </span>
                <span className="settings-info-value">
                  {describeWorktree(candidate)} · {formatBytes(candidate.bytes)}
                </span>
              </div>
            ))}
          </div>
          <div className="settings-footer-note">
            Developer worktrees (<code>.wt/</code> and Claude agents'{" "}
            <code>.claude/worktrees/</code>) whose work is already elsewhere free{" "}
            {formatBytes(worktrees.totalBytes)}. Aggressive cleanup removes them; one with
            uncommitted changes, a session in it, or activity in the last day is never touched, and
            the branch is always kept. Files git ignores go with the directory (
            <code>node_modules</code>, but also a local <code>.env</code>). Based on the last fetch,
            so a branch deleted since may only show up after the cleanup fetches.
          </div>
        </>
      )}
      {caches?.available && visibleCaches.length > 0 && (
        <>
          <div className="settings-info-table">
            {visibleCaches.map((cache, i) => (
              <div key={cache.id} className={`settings-info-row${i % 2 === 0 ? " zebra" : ""}`}>
                <span className="settings-info-key">{cache.label}</span>
                <span className="settings-info-value">
                  {cache.exists ? formatBytes(cache.bytes) : "not found"}{" "}
                  <Toggle
                    size="small"
                    on={selectedCaches.includes(cache.id)}
                    ariaLabel={`Clean ${cache.label} in aggressive cleanup`}
                    onChange={(on) =>
                      updateSettings({
                        diskCleanup: {
                          cacheDirs: on
                            ? [...selectedCaches, cache.id]
                            : selectedCaches.filter((id) => id !== cache.id),
                        },
                      })
                    }
                  />
                </span>
              </div>
            ))}
          </div>
          <div className="settings-footer-note">
            Ticked caches under <code>{caches.root}</code> are emptied by aggressive cleanup only (
            {formatBytes(
              caches.caches
                .filter((c) => selectedCaches.includes(c.id))
                .reduce((sum, c) => sum + c.bytes, 0),
            )}
            ). They are rebuilt or re-downloaded on next use, e.g. Playwright browsers and Hugging
            Face models. Close anything using them first, such as a running Playwright browser.
          </div>
        </>
      )}
      {(docker?.available || temp?.available || hasCaches || hasOpencode || hasWorktrees) && (
        <>
          {pruneResult && <div className="settings-footer-note">{pruneResult}</div>}
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <ConfirmButton
              variant="neutral"
              armedLabel="Confirm safe cleanup"
              title="Remove dangling images and stale containers, networks, build cache, and temp files"
              disabled={pruning}
              onConfirm={() => runPrune("safe")}
            >
              {pruningMode === "safe" ? "Cleaning up…" : "Clean up (safe)…"}
            </ConfirmButton>
            <span style={{ marginLeft: "auto" }}>
              <ConfirmButton
                variant="danger"
                armedLabel="Confirm aggressive cleanup"
                title="Remove ALL unused images (including tagged), ALL unused build cache, recent temp files, the npm cache, free space inside opencode's database, and developer worktrees whose branch is merged or gone"
                disabled={pruning}
                onConfirm={() => runPrune("aggressive")}
              >
                {pruningMode === "aggressive" ? "Cleaning up…" : "Aggressive cleanup…"}
              </ConfirmButton>
            </span>
          </div>
        </>
      )}

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
