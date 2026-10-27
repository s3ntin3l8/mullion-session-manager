import type { Measured, SpaceEntry, SpaceReportStatus } from "../../api/index.js";
import { hasMeasuredData } from "../measured.js";
import { formatBytes } from "../../formatBytes.js";
import { formatDuration } from "../../formatDuration.js";
import { ErrorText } from "../../ui/ErrorText.js";

/** The path as the user knows it: `~/.cache/uv`, not `/home/me/.cache/uv`. */
function displayPath(entryPath: string, root: string): string {
  return entryPath === root
    ? "~"
    : entryPath.startsWith(`${root}/`)
      ? `~/${entryPath.slice(root.length + 1)}`
      : entryPath;
}

function SpaceRow({ entry, root, total }: { entry: SpaceEntry; root: string; total: number }) {
  const share = total > 0 ? Math.min(100, (entry.bytes / total) * 100) : 0;
  const head = (
    <>
      <span className="space-row-name" title={entry.path}>
        {displayPath(entry.path, root)}
        {entry.coveredBy && <span className="space-chip">cleanable: {entry.coveredBy}</span>}
      </span>
      <span className="space-row-size">{formatBytes(entry.bytes)}</span>
      <span className="space-row-bar" aria-hidden="true">
        <span style={{ width: `${share.toFixed(1)}%` }} />
      </span>
    </>
  );
  if (!entry.children || entry.children.length === 0) {
    return <div className="space-row">{head}</div>;
  }
  return (
    <details className="space-group">
      <summary className="space-row">{head}</summary>
      <div className="space-children">
        {entry.children.map((child) => (
          <SpaceRow key={child.path} entry={child} root={root} total={total} />
        ))}
      </div>
    </details>
  );
}

/**
 * "Where the space is": the biggest things under the home directory. Read-only:
 * nothing here can be deleted, and the chips only say which of them the cleanup
 * tiers above already handle.
 */
export function SpaceReport({
  probe,
  now,
}: {
  probe: Measured<SpaceReportStatus> | null;
  now: number;
}) {
  if (!hasMeasuredData(probe)) {
    if (probe?.state === "error")
      return <ErrorText>{probe.error ?? "Could not measure"}</ErrorText>;
    const since = probe?.startedAt ? now - Date.parse(probe.startedAt) : null;
    return (
      <div className="settings-readonly-value">
        Measuring…{since !== null ? ` ${formatDuration(since)}` : ""}
      </div>
    );
  }
  if (!probe.available) {
    return <ErrorText>{probe.error ?? "Could not measure disk usage"}</ErrorText>;
  }
  const refreshing = probe.state === "measuring";
  return (
    <div className="space-report" aria-busy={refreshing}>
      {refreshing && (
        <div className="settings-footer-note">
          Updating
          {probe.startedAt ? ` (${formatDuration(now - Date.parse(probe.startedAt))})` : ""}… the
          figures below are from the last measurement.
        </div>
      )}
      {probe.truncated && (
        <div className="settings-footer-note">
          This is a very large folder tree, so the scan stopped early: every figure below is at
          least that much.
        </div>
      )}
      {probe.state === "error" && <ErrorText>Could not refresh: {probe.error}</ErrorText>}
      {probe.entries.map((entry) => (
        <SpaceRow
          key={entry.path}
          entry={entry}
          root={probe.root}
          total={probe.filesystemUsedBytes}
        />
      ))}
      {probe.outsideBytes > 0 && (
        <div className="space-row space-outside">
          <span className="space-row-name">
            Outside your home folder
            {probe.unreadableEntries > 0
              ? ` or not readable (${String(probe.unreadableEntries)} folders)`
              : ""}
          </span>
          <span className="space-row-size">{formatBytes(probe.outsideBytes)}</span>
          <span className="space-row-bar" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(100, (probe.outsideBytes / probe.filesystemUsedBytes) * 100).toFixed(1)}%`,
              }}
            />
          </span>
        </div>
      )}
    </div>
  );
}
