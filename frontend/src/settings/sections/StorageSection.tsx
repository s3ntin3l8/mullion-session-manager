import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  CleanupJob,
  CleanupStepState,
  DevWorktreeCandidate,
  OrphanRemovalStatus,
  Measured,
  ProbeMeta,
  SystemStats,
} from "../../api/index.js";
import { hasMeasuredData } from "../measured.js";
import { formatRelativeAge } from "../../relativeTime.js";
import { Eyebrow, SecondaryButton, Toggle } from "../../ui/primitives.js";
import { ErrorText } from "../../ui/ErrorText.js";
import { formatBytes } from "../../formatBytes.js";
import { formatDuration } from "../../formatDuration.js";
import { ConfirmButton } from "../../ui/ConfirmButton.js";
import { useDashboardStore } from "../../store/index.js";
import { useStorageProbes } from "../useStorageProbes.js";
import { useCleanupJob } from "../useCleanupJob.js";
import { useOrphanRemoval } from "../useOrphanRemoval.js";
import { summarizeCleanup } from "../cleanupSummary.js";
import { KeptSessionWorktrees } from "./KeptSessionWorktrees.js";
import { SpaceReport } from "./SpaceReport.js";

function describeWorktree(candidate: DevWorktreeCandidate): string {
  const kind = candidate.kind === "claude-agent" ? "Claude agent" : "worktree";
  const why =
    candidate.reason === "gone"
      ? "branch deleted on the remote"
      : candidate.reason === "merged"
        ? `PR ${candidate.detail ?? ""} merged`.trim()
        : candidate.reason === "orphaned"
          ? "not a registered git worktree"
          : "already in the default branch";
  return `${kind}, ${why}`;
}

/** " (pid 123: opencode serve)" for the first process holding opencode's database. */
function holderText(holders: Array<{ pid: number; command: string }> | undefined): string {
  const [first] = holders ?? [];
  if (!first) return "";
  const more = holders!.length > 1 ? ` and ${String(holders!.length - 1)} more` : "";
  return ` (pid ${String(first.pid)}${first.command ? `: ${first.command}` : ""}${more})`;
}

/** The current time, re-read every second while `active`, so elapsed counters tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const ORPHAN_REFUSAL: Record<string, string> = {
  "invalid-path": "This path is outside an allowed worktree root or is not a directory.",
  "not-orphan": "This directory is no longer an orphan. Refresh the list.",
  "in-use": "A session or resumable task is using this directory.",
  "contains-mount":
    "This directory contains a mounted filesystem. Unmount it before removing the directory.",
  unavailable: "Could not verify this directory. Refresh and try again.",
  "unsupported-platform": "Orphan removal is not supported on this platform yet.",
  "cross-device":
    "This directory is on a different filesystem. Check its contents and remove it manually.",
  changed: "The directory changed while it was checked. Refresh and try again.",
  "remove-failed": "Removal failed after starting; some files may already have been deleted.",
};

function OrphanWorktreeRow({
  candidate,
  zebra,
  job,
  busy,
  measuredAt,
  onStart,
}: {
  candidate: DevWorktreeCandidate;
  zebra: boolean;
  job: OrphanRemovalStatus;
  busy: boolean;
  measuredAt: string | null;
  onStart: (projectId: number, path: string) => void;
}) {
  const matches =
    job.state !== "idle" && job.projectId === candidate.projectId && job.path === candidate.path;
  const done = matches && job.state === "done" ? job : null;
  if (
    done?.result.removed &&
    (!measuredAt || Date.parse(measuredAt) <= Date.parse(done.finishedAt))
  )
    return null;
  const error = done && !done.result.removed ? ORPHAN_REFUSAL[done.result.reason] : null;
  const removing = matches && job.state === "running";
  return (
    <div className={`settings-info-row kept-worktree-row${zebra ? " zebra" : ""}`}>
      <span className="settings-info-key">
        {candidate.projectName} / {candidate.slug}
      </span>
      <span className="settings-info-value" title={candidate.path}>
        <code>{candidate.path}</code> · {formatBytes(candidate.bytes)}
        {error && <ErrorText>{error}</ErrorText>}
      </span>
      <ConfirmButton
        disabled={busy}
        title="Permanently delete this directory and all its files, including uncommitted and ignored work."
        armedLabel="Confirm removal"
        onConfirm={() => onStart(candidate.projectId, candidate.path)}
      >
        {removing ? "Removing…" : "Remove"}
      </ConfirmButton>
    </div>
  );
}

/** One source's line in a tier card. */
interface TierRow {
  label: string;
  /** null: nothing to report (e.g. Docker could not be inspected). */
  bytes: number | null;
  /** Still measuring, so the figure is missing or about to change. */
  pending: boolean;
  /** ISO time the measurement in progress started, for "measuring… 1m 20s". */
  since?: string;

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
      : { label, bytes: null, pending: true, since: probe?.startedAt };
  }
  const read_ = read(probe);
  if (!read_) return null;
  return {
    label,
    bytes: read_.bytes,
    pending: probe.state === "measuring",
    since: probe.startedAt,
    note:
      probe.state === "error" ? `Could not refresh: ${probe.error ?? "unknown error"}` : read_.note,
  };
}

/** " 1m 20s" since a measurement started, or "" when the start isn't known. */
function elapsed(since: string | undefined, now: number): string {
  return since ? ` ${formatDuration(now - Date.parse(since))}` : "";
}

function TierCard({
  title,
  variant,
  rows,
  busy,
  now,
  action,
}: {
  title: string;
  variant: "safe" | "aggressive";
  rows: TierRow[];
  busy: boolean;
  now: number;
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
                  ? `measuring…${elapsed(row.since, now)}`
                  : "—"
                : `${formatBytes(row.bytes)}${row.pending ? ` · updating…${elapsed(row.since, now)}` : ""}`}
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="storage-tier-row">Nothing to clean here.</div>}
      </div>
      <div className="storage-tier-actions">{action}</div>
    </div>
  );
}

const STEP_STATE_TEXT: Record<CleanupStepState["state"], string> = {
  pending: "waiting…",
  running: "cleaning up…",
  done: "done",
  skipped: "skipped",
  error: "failed",
};

/** The running (or last) cleanup, one line per source, then what it freed. */
function CleanupProgress({ job, error }: { job: CleanupJob | null; error: string | null }) {
  if (!job && !error) return null;
  return (
    <div className="storage-job" aria-live="polite">
      {error && <ErrorText>{error}</ErrorText>}
      {job && (
        <>
          <div className="storage-job-head">
            {job.state === "running"
              ? `Cleaning up (${job.mode})…`
              : `Last cleanup (${job.mode}${
                  job.finishedAt ? `, ${formatRelativeAge(Date.parse(job.finishedAt))}` : ""
                })`}
          </div>
          <div className="storage-tier-rows">
            {job.steps.map((step) => (
              <div key={step.source} className="storage-tier-row">
                <span>{step.label}</span>
                <span
                  className={`storage-tier-figure${step.state === "pending" ? " pending" : ""}`}
                >
                  {step.state === "done"
                    ? `freed ${formatBytes(step.reclaimedBytes)}${step.note ? `: ${step.note}` : ""}`
                    : step.state === "skipped" || step.state === "error"
                      ? `${STEP_STATE_TEXT[step.state]}${step.note ? `: ${step.note}` : ""}`
                      : STEP_STATE_TEXT[step.state]}
                </span>
              </div>
            ))}
          </div>
          {job.state === "done" && (
            <div className="settings-footer-note">{summarizeCleanup(job)}</div>
          )}
        </>
      )}
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

const RECOVERY_KEY = "mullion.orphanRecoveryPaths";
type OrphanRecovery = {
  recoveryPath: string;
  originalPath: string;
  mayBePartial?: boolean;
  unverified?: boolean;
  dismissed?: boolean;
};
function readRecoveries(): OrphanRecovery[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is OrphanRecovery =>
            typeof entry === "object" &&
            entry !== null &&
            typeof entry.recoveryPath === "string" &&
            typeof entry.originalPath === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function StorageSection() {
  const [recoveries, setRecoveries] = useState<OrphanRecovery[]>(readRecoveries);
  const saveRecoveries = (next: OrphanRecovery[]) => {
    setRecoveries(next);
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(next));
    } catch {
      /* The visible notice still works. */
    }
  };
  const mergeRecoveries = (incoming: OrphanRecovery[]) => {
    setRecoveries((current) => {
      const next = [...current];
      let changed = false;
      for (const item of incoming) {
        const index = next.findIndex((existing) => existing.recoveryPath === item.recoveryPath);
        if (index < 0) {
          next.push(item);
          changed = true;
        } else if (
          (item.mayBePartial && !next[index]?.mayBePartial) ||
          (item.unverified !== undefined && Boolean(next[index]?.unverified) !== item.unverified)
        ) {
          next[index] = {
            ...next[index]!,
            mayBePartial: next[index]?.mayBePartial || item.mayBePartial,
            unverified: item.unverified ?? next[index]?.unverified,
          };
          changed = true;
        }
      }
      if (!changed) return current;
      try {
        localStorage.setItem(RECOVERY_KEY, JSON.stringify(next));
      } catch {
        /* The visible notice still works. */
      }
      return next;
    });
  };
  const probes = useStorageProbes();
  const { stats, statsError, busy, refresh } = probes;
  const orphan = useOrphanRemoval(
    () => void refresh(),
    (items) =>
      mergeRecoveries(items.map((item) => ({ ...item, unverified: item.unverified ?? false }))),
  );
  const orphanResult =
    orphan.showSuccess && orphan.job.state === "done" && orphan.job.result.removed
      ? `Removed ${orphan.job.path.split(/[\\/]/).pop() ?? orphan.job.path}; freed approximately ${formatBytes(orphan.job.result.reclaimedBytes)}.`
      : null;
  const now = useNow(busy);
  const docker = hasMeasuredData(probes.docker) ? probes.docker : null;
  const temp = hasMeasuredData(probes.temp) ? probes.temp : null;
  const caches = hasMeasuredData(probes.caches) ? probes.caches : null;
  const opencode = hasMeasuredData(probes.opencode) ? probes.opencode : null;
  const worktrees = hasMeasuredData(probes.worktrees) ? probes.worktrees : null;
  // Orphans are excluded from automatic cleanup, but can be removed individually.
  const removableWorktrees = (worktrees?.candidates ?? []).filter((c) => c.reason !== "orphaned");
  const orphanedWorktrees = (worktrees?.candidates ?? []).filter((c) => c.reason === "orphaned");

  const settings = useDashboardStore((s) => s.settings);
  const updateSettings = useDashboardStore((s) => s.updateSettings);
  const selectedCaches = settings.diskCleanup.cacheDirs;
  // A cache that was opted in but has since disappeared from disk stays listed
  // (as "not found") so the stale opt-in can still be cleared.
  const visibleCaches = (caches?.caches ?? []).filter(
    (c) => c.exists || selectedCaches.includes(c.id),
  );
  // The server runs the cleanup (it can take minutes) and decides which sources
  // take part; this only starts it and follows its progress. When it finishes
  // the server has dropped its measurements, so ask for fresh ones.
  const cleanup = useCleanupJob(() => void refresh());

  // These services report their own failures as `available: false` plus an
  // `error` rather than rejecting, so a row for one that failed says why. With no
  // error it simply isn't there (opencode not installed), and stays out of the way.
  const failed = (data: { available: boolean; error?: string }) =>
    !data.available && data.error ? { bytes: null, note: data.error } : null;

  const dockerSafeRow = tierRow("Docker", probes.docker, (data) =>
    data.available ? { bytes: data.estimates?.safeBytes ?? null, note: undefined } : null,
  );
  const dockerAggressiveRow = tierRow("Docker", probes.docker, (data) =>
    data.available ? { bytes: data.estimates?.aggressiveBytes ?? data.reclaimableBytes } : null,
  );
  const tempSafeRow = tierRow("Temp files", probes.temp, (data) =>
    data.available ? { bytes: data.estimates.safeBytes } : failed(data),
  );
  const tempAggressiveRow = tierRow("Temp files", probes.temp, (data) =>
    data.available
      ? { bytes: data.estimates.aggressiveBytes - data.estimates.npmCacheBytes }
      : failed(data),
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
    if (!data.available) return failed(data);
    if (data.reclaimableBytes === 0) return null;
    const blocked = data.compacting
      ? "compacting now"
      : data.inUse
        ? `skipped: opencode is running${holderText(data.holders)} · ${formatBytes(data.reclaimableBytes)} once it is closed`
        : data.holdersUnknown
          ? "skipped: can't tell if it's running"
          : undefined;
    return { bytes: blocked ? 0 : data.reclaimableBytes, note: blocked };
  });
  const worktreeRow = tierRow("Developer worktrees", probes.worktrees, (data) =>
    data.available
      ? data.candidates.some((c) => c.reason !== "orphaned")
        ? { bytes: data.totalBytes }
        : null
      : failed(data),
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
    probes.space,
  ]
    .map((probe) => (hasMeasuredData(probe) ? probe.measuredAt : null))
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at));
  const oldest = measuredTimes.length > 0 ? Math.min(...measuredTimes) : null;
  // The longest a measurement has been running, and how long the slowest took.
  const allProbes = [
    probes.docker,
    probes.temp,
    probes.caches,
    probes.opencode,
    probes.worktrees,
    probes.space,
  ];
  const runningSince = allProbes
    .map((probe) => (probe?.state === "measuring" ? probe.startedAt : undefined))
    .filter((at): at is string => at !== undefined)
    .map((at) => Date.parse(at));
  const longestRunMs = runningSince.length > 0 ? now - Math.min(...runningSince) : null;
  const slowestTookMs = Math.max(0, ...allProbes.map((probe) => probe?.durationMs ?? 0));

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
          {oldest !== null
            ? `Measured ${formatRelativeAge(oldest)}${
                slowestTookMs > 0 ? ` (slowest took ${formatDuration(slowestTookMs)})` : ""
              }`
            : ""}
        </span>
      </div>
      {busy && (
        <div className="storage-measuring-note" role="status">
          Measuring{longestRunMs !== null ? ` for ${formatDuration(longestRunMs)}` : ""}. This runs
          on the server, so you can leave this page and come back: finished figures are kept for 30
          minutes.
        </div>
      )}
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
          now={now}
          rows={present([dockerSafeRow, tempSafeRow])}
          action={
            <ConfirmButton
              variant="neutral"
              armedLabel="Confirm safe cleanup"
              title="Remove dangling images and stale containers, networks, build cache, and temp files"
              disabled={cleanup.running}
              onConfirm={() => void cleanup.start("safe", selectedCaches)}
            >
              {cleanup.activeMode === "safe" ? "Cleaning up…" : "Clean up (safe)…"}
            </ConfirmButton>
          }
        />
        <TierCard
          title="Aggressive"
          variant="aggressive"
          busy={busy}
          now={now}
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
              title="Remove ALL unused images (including tagged), ALL unused build cache, recent temp files, the npm cache, free space inside opencode's database, and developer worktrees whose branch is merged or gone"
              disabled={cleanup.running}
              onConfirm={() => void cleanup.start("aggressive", selectedCaches)}
            >
              {cleanup.activeMode === "aggressive" ? "Cleaning up…" : "Aggressive cleanup…"}
            </ConfirmButton>
          }
        />
      </div>
      <CleanupProgress job={cleanup.job} error={cleanup.error} />

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

      {worktrees?.available && removableWorktrees.length > 0 && (
        <>
          <div className="storage-subhead">Developer worktrees aggressive cleanup would remove</div>
          <div className="settings-info-table">
            {removableWorktrees.map((candidate, i) => (
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

      {worktrees?.available && orphanedWorktrees.length > 0 && (
        <>
          <div className="storage-subhead">
            Directories under a worktree root that git doesn't know
          </div>
          <div className="settings-info-table">
            {orphanedWorktrees.map((candidate, i) => (
              <OrphanWorktreeRow
                key={`${candidate.projectId}:${candidate.path}`}
                candidate={candidate}
                zebra={i % 2 === 0}
                job={orphan.job}
                busy={orphan.busy}
                measuredAt={probes.worktrees?.measuredAt ?? null}
                onStart={(projectId, path) => void orphan.start(projectId, path)}
              />
            ))}
          </div>
          <div className="settings-footer-note">
            Cleanup leaves these alone. Check each directory before removing it: it may contain
            uncommitted or ignored work.
          </div>
        </>
      )}

      {orphan.error && <ErrorText>{orphan.error}</ErrorText>}
      {orphan.job.state === "done" &&
        !orphan.job.result.removed &&
        orphan.job.result.reason === "remove-failed" && (
          <ErrorText>
            Removal of <code>{orphan.job.path}</code> failed; some files may already have been
            deleted.
          </ErrorText>
        )}
      {orphan.job.state === "running" && (
        <div className="settings-footer-note" role="status">
          Removing <code>{orphan.job.path}</code> on the server. You can leave this page and return.
        </div>
      )}
      {recoveries
        .filter((item) => !item.dismissed)
        .map(({ recoveryPath, originalPath, mayBePartial, unverified }) => (
          <ErrorText key={recoveryPath}>
            {mayBePartial && "Removal started; some files may already have been deleted. "}
            {unverified &&
              "The recovery location could not be verified; check it before moving files. "}
            {unverified ? "Remaining files may be at " : "Remaining files are at "}
            <code>{recoveryPath}</code>.
            {recoveryPath === originalPath ? (
              " Check that directory."
            ) : (
              <>
                {" "}
                Move them back to <code>{originalPath}</code> after checking that destination.
              </>
            )}
            <SecondaryButton
              onClick={() =>
                saveRecoveries(
                  recoveries.map((item) =>
                    item.recoveryPath === recoveryPath ? { ...item, dismissed: true } : item,
                  ),
                )
              }
            >
              Dismiss recovery notice
            </SecondaryButton>
          </ErrorText>
        ))}

      {orphan.warnings.map((warning) => (
        <ErrorText key={warning}>{warning}</ErrorText>
      ))}

      {orphanResult && (
        <div className="settings-footer-note" role="status">
          {orphanResult}
        </div>
      )}

      <KeptSessionWorktrees />

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
                ? `opencode is running right now${holderText(opencode.holders)}, so this is skipped until it is closed.`
                : opencode.holdersUnknown
                  ? `Mullion couldn't tell whether opencode is running${
                      opencode.holdersUnknownReason ? ` (${opencode.holdersUnknownReason})` : ""
                    }, so this is skipped.`
                  : "It is skipped whenever opencode is running, and takes a minute or so on a large database."}
            {!opencode.compacting && opencode.lastPrune && (
              <>
                {" "}
                Last compaction ({formatRelativeAge(
                  Date.parse(opencode.lastPrune.finishedAt),
                )}):{" "}
                {opencode.lastPrune.error
                  ? `failed: ${opencode.lastPrune.error}`
                  : opencode.lastPrune.reclaimedBytes > 0
                    ? `${opencode.lastPrune.output} Freed ${formatBytes(opencode.lastPrune.reclaimedBytes)}.`
                    : opencode.lastPrune.output}
              </>
            )}
          </div>
        )}
        {worktrees?.available && removableWorktrees.length > 0 && (
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

      <Eyebrow
        title="Where the space is"
        desc="The biggest folders in your home directory. Read-only: nothing here is deleted; “cleanable” marks what the tiers above already handle."
      />
      <SpaceReport probe={probes.space} now={now} />
    </>
  );
}
