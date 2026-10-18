import { useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "../../api/index.js";
import type {
  DevWorktreeCandidate,
  DockerPruneMode,
  Measured,
  ProbeMeta,
  SystemStats,
} from "../../api/index.js";
import { hasMeasuredData } from "../measured.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { Eyebrow, SecondaryButton, Toggle } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { formatBytes } from "../../formatBytes.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { useDashboardStore } from "../../store/index.js";
import { useStorageProbes } from "../useStorageProbes.js";

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

/** One source's line in a tier card. */
interface TierRow {
  label: string;
  /** null: nothing to report (e.g. Docker could not be inspected). */
  bytes: number | null;
  /** Still measuring, so the figure is missing or about to change. */
  pending: boolean;
  note?: string;
}

/**
 * A tier row from one probe. `read` returns null to leave the row out (the
 * source does not exist on this host) or the figure to show.
 */
function tierRow<T>(
  label: string,
  probe: Measured<T> | null,
  read: (data: T & ProbeMeta) => { bytes: number | null; note?: string } | null,
): TierRow | null {
  if (!hasMeasuredData(probe)) {
    return probe?.state === "error"
      ? { label, bytes: null, pending: false, note: probe.error ?? "Could not measure" }
      : { label, bytes: null, pending: true };
  }
  const read_ = read(probe);
  if (!read_) return null;
  return {
    label,
    bytes: read_.bytes,
    pending: probe.state === "measuring",
    note:
      probe.state === "error" ? `Could not refresh: ${probe.error ?? "unknown error"}` : read_.note,
  };
}

function TierCard({
  title,
  variant,
  rows,
  busy,
  action,
}: {
  title: string;
  variant: "safe" | "aggressive";
  rows: TierRow[];
  busy: boolean;
  action: ReactNode;
}) {
  const total = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  const pending = rows.some((row) => row.pending);
  return (
    <div className={`storage-tier ${variant}`} aria-busy={busy}>
      <div className="storage-tier-head">
        <span className="storage-tier-title">{title}</span>
        <span className="storage-tier-total">
          ≈ {formatBytes(total)}
          {pending ? "+" : ""}
        </span>
      </div>
      <div className="storage-tier-rows">
        {rows.map((row) => (
          <div key={row.label} className="storage-tier-row">
            <span>
              {row.label}
              {row.note && <span className="storage-tier-note"> · {row.note}</span>}
            </span>
            <span className={`storage-tier-figure${row.pending ? " pending" : ""}`}>
              {row.bytes === null
                ? row.pending
                  ? "measuring…"
                  : "—"
                : `${formatBytes(row.bytes)}${row.pending ? " · updating…" : ""}`}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="storage-tier-row">Nothing to clean here.</div>}
      </div>
      <div className="storage-tier-actions">{action}</div>
    </div>
  );
}

function DiskRow({ filesystem }: { filesystem: SystemStats["filesystems"][number] }) {
  const usable =
    filesystem.available &&
    filesystem.freeBytes !== undefined &&
    filesystem.totalBytes !== undefined &&
    filesystem.totalBytes > 0;
  const usedPercent = usable
    ? Math.min(100, Math.max(0, (1 - filesystem.freeBytes! / filesystem.totalBytes!) * 100))
    : 0;
  // A mount that can't be measured is not a low-disk alert: it gets its own,
  // muted style, and no meter.
  const severity = usable ? (filesystem.severity ?? "normal") : "unavailable";
  return (
    <div className="storage-disk" title={filesystem.paths.join("\n")}>
      <div className="storage-disk-head">
        <span className="storage-disk-name">{filesystem.labels.join(", ")}</span>
        <span className={`storage-disk-figure resource-${severity}`}>
          {usable
            ? `${formatBytes(filesystem.freeBytes!)} free of ${formatBytes(filesystem.totalBytes!)} (${filesystem.freePercent?.toFixed(1) ?? "?"}%)`
            : (filesystem.error ?? "Unavailable")}
        </span>
      </div>
      {usable && (
        <div className="storage-meter" role="img" aria-label={`${usedPercent.toFixed(0)}% used`}>
          <div
            className={`storage-meter-fill ${severity}`}
            style={{ width: `${usedPercent.toFixed(1)}%` }}
          />
        </div>
      )}
      <div className="storage-disk-paths">{filesystem.paths.join(", ")}</div>
    </div>
  );
}

export function StorageSection() {
  const probes = useStorageProbes();
  const { stats, statsError, busy, refresh } = probes;
  const docker = hasMeasuredData(probes.docker) ? probes.docker : null;
  const temp = hasMeasuredData(probes.temp) ? probes.temp : null;
  const caches = hasMeasuredData(probes.caches) ? probes.caches : null;
  const opencode = hasMeasuredData(probes.opencode) ? probes.opencode : null;
  const worktrees = hasMeasuredData(probes.worktrees) ? probes.worktrees : null;

  const settings = useDashboardStore((s) => s.settings);
  const updateSettings = useDashboardStore((s) => s.updateSettings);
  const selectedCaches = settings.diskCleanup.cacheDirs;
  const hasOpencode = !!opencode?.available && opencode.reclaimableBytes > 0;
  // A cache that was opted in but has since disappeared from disk stays listed
  // (as "not found") so the stale opt-in can still be cleared.
  const visibleCaches = (caches?.caches ?? []).filter(
    (c) => c.exists || selectedCaches.includes(c.id),
  );
  const [pruningMode, setPruningMode] = useState<DockerPruneMode | null>(null);
  const pruning = pruningMode !== null;
  const [pruneResult, setPruneResult] = useState<string | null>(null);

  // What cleanup reads (is Docker there? is opencode running?) must have been
  // measured first, or a tier would silently skip a source that merely hasn't
  // answered yet. Worktrees are exempt: aggressive cleanup doesn't depend on
  // their preview. A probe that failed has "settled" too.
  const settled = (probe: ProbeMeta | null) =>
    probe !== null && (probe.measuredAt !== null || probe.state === "error");
  const ready =
    settled(probes.docker) &&
    settled(probes.temp) &&
    settled(probes.caches) &&
    settled(probes.opencode);

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
        // The server dropped its measurements when it pruned, so this starts
        // fresh runs; the page keeps working while they finish.
        void refresh();
      }
    })();
  };

  const dockerSafeRow = tierRow("Docker", probes.docker, (data) =>
    data.available ? { bytes: data.estimates?.safeBytes ?? null, note: undefined } : null,
  );
  const dockerAggressiveRow = tierRow("Docker", probes.docker, (data) =>
    data.available ? { bytes: data.estimates?.aggressiveBytes ?? data.reclaimableBytes } : null,
  );
  const tempSafeRow = tierRow("Temp files", probes.temp, (data) =>
    data.available ? { bytes: data.estimates.safeBytes } : null,
  );
  const tempAggressiveRow = tierRow("Temp files", probes.temp, (data) =>
    data.available
      ? { bytes: data.estimates.aggressiveBytes - data.estimates.npmCacheBytes }
      : null,
  );
  const npmRow = tierRow("npm cache", probes.temp, (data) =>
    data.available && data.estimates.npmCacheBytes > 0
      ? { bytes: data.estimates.npmCacheBytes }
      : null,
  );
  const cacheRow = tierRow("Opted-in caches", probes.caches, (data) => {
    if (!data.available || visibleCaches.length === 0) return null;
    return {
      bytes: data.caches
        .filter((c) => selectedCaches.includes(c.id))
        .reduce((sum, c) => sum + c.bytes, 0),
      note: selectedCaches.length === 0 ? "none ticked" : undefined,
    };
  });
  const opencodeRow = tierRow("opencode database", probes.opencode, (data) => {
    if (!data.available || data.reclaimableBytes === 0) return null;
    const blocked = data.compacting
      ? "compacting now"
      : data.inUse
        ? "skipped: opencode is running"
        : data.holdersUnknown
          ? "skipped: can't tell if it's running"
          : undefined;
    return { bytes: blocked ? 0 : data.reclaimableBytes, note: blocked };
  });
  const worktreeRow = tierRow("Developer worktrees", probes.worktrees, (data) =>
    data.available && data.candidates.length > 0 ? { bytes: data.totalBytes } : null,
  );
  const present = (rows: Array<TierRow | null>) =>
    rows.filter((row): row is TierRow => row !== null);

  const dockerUnavailable = docker && !docker.available;
  const measuredTimes = [
    probes.docker,
    probes.temp,
    probes.caches,
    probes.opencode,
    probes.worktrees,
  ]
    .map((probe) => (hasMeasuredData(probe) ? probe.measuredAt : null))
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at));
  const oldest = measuredTimes.length > 0 ? Math.min(...measuredTimes) : null;

  const cleanupTitle = (text: string) => (ready ? text : "Waiting for the measurements above…");

  return (
    <>
      <Eyebrow title="Disk usage" desc="Disks used by Mullion's data, sessions, and projects." />
      {statsError && <ErrorText>{statsError}</ErrorText>}
      {!stats && !statsError && <div className="settings-readonly-value">Measuring…</div>}
      {stats && (
        <div className="storage-disks">
          {stats.filesystems.map((filesystem) => (
            <DiskRow
              key={`${filesystem.paths[0]}:${filesystem.labels[0]}`}
              filesystem={filesystem}
            />
          ))}
        </div>
      )}

      <Eyebrow
        title="Disk cleanup"
        desc="Estimates of what each tier would free. Large temp folders can take a moment to measure."
      />
      <div className="storage-refresh">
        <SecondaryButton onClick={() => void refresh()} disabled={busy}>
          {busy ? "Measuring…" : "Refresh"}
        </SecondaryButton>
        <span className="storage-refresh-age">
          {oldest !== null ? `Measured ${formatRelativeAge(oldest)}` : ""}
        </span>
      </div>
      {dockerUnavailable && (
        <div className="settings-footer-note">
          Docker cleanup unavailable:{" "}
          {docker.error ?? "Docker is not installed or permission was denied."}
        </div>
      )}

      <div className="storage-tiers">
        <TierCard
          title="Safe"
          variant="safe"
          busy={busy}
          rows={present([dockerSafeRow, tempSafeRow])}
          action={
            <ConfirmButton
              variant="neutral"
              armedLabel="Confirm safe cleanup"
              title={cleanupTitle(
                "Remove dangling images and stale containers, networks, build cache, and temp files",
              )}
              disabled={pruning || !ready}
              onConfirm={() => runPrune("safe")}
            >
              {pruningMode === "safe" ? "Cleaning up…" : "Clean up (safe)…"}
            </ConfirmButton>
          }
        />
        <TierCard
          title="Aggressive"
          variant="aggressive"
          busy={busy}
          rows={present([
            dockerAggressiveRow,
            tempAggressiveRow,
            npmRow,
            cacheRow,
            opencodeRow,
            worktreeRow,
          ])}
          action={
            <ConfirmButton
              variant="danger"
              armedLabel="Confirm aggressive cleanup"
              title={cleanupTitle(
                "Remove ALL unused images (including tagged), ALL unused build cache, recent temp files, the npm cache, free space inside opencode's database, and developer worktrees whose branch is merged or gone",
              )}
              disabled={pruning || !ready}
              onConfirm={() => runPrune("aggressive")}
            >
              {pruningMode === "aggressive" ? "Cleaning up…" : "Aggressive cleanup…"}
            </ConfirmButton>
          }
        />
      </div>
      {pruneResult && <div className="settings-footer-note">{pruneResult}</div>}

      {caches?.available && visibleCaches.length > 0 && (
        <>
          <div className="storage-subhead">Also empty in aggressive cleanup</div>
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

      {worktrees?.available && worktrees.candidates.length > 0 && (
        <>
          <div className="storage-subhead">Developer worktrees aggressive cleanup would remove</div>
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
        </>
      )}

      {temp?.available && temp.claudeScratch.skipped && (
        <div className="settings-footer-note">
          Claude scratch under <code>claude-*</code> is being left alone:{" "}
          {temp.claudeScratch.skipped}.
        </div>
      )}
      {temp?.available && temp.claudeScratch.warnings.length > 0 && (
        <div className="settings-footer-note">
          Skipped session registry files:
          <ul>
            {temp.claudeScratch.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="storage-details">
        <summary>What does each tier remove?</summary>
        <div className="settings-footer-note">
          <strong>Docker.</strong> Safe cleanup removes dangling images (any age), plus stopped
          containers and unused networks older than 7 days, and build cache older than 24 hours.
          Aggressive cleanup also removes <strong>all unused images, including tagged ones</strong>{" "}
          (they must be pulled or rebuilt again) and all unused build cache, and it drops the 7-day
          window for stopped containers and unused networks too. Neither uses <code>--volumes</code>
          , so volumes are always preserved. Figures are estimates.
        </div>
        {temp?.available && (
          <div className="settings-footer-note">
            <strong>Temp files.</strong> Temp cleanup only touches entries in{" "}
            <code>{temp.root}</code> owned by this server's user, and skips sockets and live tool
            caches. Safe removes entries untouched for 7+ days; aggressive uses a 24-hour window and
            also clears the npm cache (an <code>npm ci</code> running in a session at that moment
            may fail). Claude scratch under <code>claude-*</code> is cleaned per session, and only
            for sessions that are no longer running: safe after 24 hours, aggressive after 10
            minutes. The same windows cover bundled skills of Claude Code versions nobody is running
            and empty project folders; other stray files and folders there follow the general 7-day
            / 24-hour windows.
          </div>
        )}
        {opencode?.available && (
          <div className="settings-footer-note">
            <strong>opencode database.</strong> <code>{opencode.path}</code> (
            {formatBytes(opencode.fileBytes)}) keeps the space of every session it has deleted.
            Aggressive cleanup compacts it (<code>VACUUM</code>), which loses no session data and
            returns the exact figure shown.{" "}
            {opencode.compacting
              ? "It is being compacted right now, which can take several minutes; the figures are from before it started."
              : opencode.inUse
                ? "opencode is running right now, so this is skipped until it is closed."
                : opencode.holdersUnknown
                  ? `Mullion couldn't tell whether opencode is running${
                      opencode.holdersUnknownReason ? ` (${opencode.holdersUnknownReason})` : ""
                    }, so this is skipped.`
                  : "It is skipped whenever opencode is running, and takes a minute or so on a large database."}
          </div>
        )}
        {worktrees?.available && worktrees.candidates.length > 0 && (
          <div className="settings-footer-note">
            <strong>Developer worktrees.</strong> Developer worktrees (<code>.wt/</code> and Claude
            agents' <code>.claude/worktrees/</code>) whose work is already elsewhere free{" "}
            {formatBytes(worktrees.totalBytes)}. Aggressive cleanup removes them; one with
            uncommitted changes, a session in it, or activity in the last day is never touched, and
            the branch is always kept. Files git ignores go with the directory (
            <code>node_modules</code>, but also a local <code>.env</code>). Based on the last fetch,
            so a branch deleted since may only show up after the cleanup fetches.
          </div>
        )}
      </details>
    </>
  );
}
