import { useState } from "react";
import { api } from "../api/index.js";
import { parseUnifiedDiff, type DiffLine } from "../diffUtils.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import {
  fileChangeDotClass,
  fileChangeLetter,
  type FileChangeSummary,
} from "../lib/sidebarStatus.js";

// SessionRow's row 4 (issue #177) — recent file changes from the structured
// hook channel (Phase 2), not the git working-tree diff GitLine shows.
// Extracted verbatim from SessionRow (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md). `expandedFilePath` moves down
// into local state here (unlike GitLine/Chips' props-only shape) because
// nothing outside this chip-row + detail pairing ever reads it — SessionRow
// itself only ever passed the already-capped `fileChanges` array in, never
// read the expand state back out.
interface SessionFileDiffProps {
  sessionId: number;
  filePath: string;
}

function SessionFileDiff({ sessionId, filePath }: SessionFileDiffProps) {
  const [diffLines, setDiffLines] = useState<DiffLine[] | null | undefined>(undefined);

  useAsyncData(
    () => api.getSessionGitFileDiff(sessionId, filePath),
    (r) => setDiffLines(r.patch ? parseUnifiedDiff(r.patch) : null),
    () => setDiffLines(null),
    [sessionId, filePath],
  );

  if (diffLines === undefined) {
    return (
      <div className="session-file-change-diff">
        <span className="session-diff-spinner">…</span>
      </div>
    );
  }

  if (diffLines === null || diffLines.length === 0) {
    return (
      <div className="session-file-change-diff">
        <span className="session-diff-empty">No changes</span>
      </div>
    );
  }

  return (
    <div className="session-file-change-diff" onClick={(e) => e.stopPropagation()}>
      {diffLines.map((line, i) => (
        <span key={i} className={`session-diff-line session-diff-${line.type}`}>
          {line.text}
        </span>
      ))}
    </div>
  );
}

export interface FileChangesProps {
  sessionId: number;
  fileChanges: FileChangeSummary[];
}

export function FileChanges({ sessionId, fileChanges }: FileChangesProps) {
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null);
  const expandedFileChange = expandedFilePath
    ? fileChanges.find((fc) => fc.path === expandedFilePath)
    : undefined;

  if (fileChanges.length === 0) return null;

  return (
    <>
      <div className="session-file-changes-line">
        {fileChanges.map((fc) => {
          const filename = fc.path.split("/").pop() || fc.path;
          return (
            <button
              key={fc.path}
              type="button"
              className="session-file-change-chip"
              title={fc.path}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedFilePath((prev) => (prev === fc.path ? null : fc.path));
              }}
            >
              <span className={`github-panel-ci-dot ${fileChangeDotClass(fc.action)}`} />
              <span className="session-file-change-letter">{fileChangeLetter(fc.action)}</span>
              <span className="session-file-change-name">{filename}</span>
            </button>
          );
        })}
      </div>
      {/* Click-to-expand detail (issue #177's explicit scope: path + action
        + occurrence count, no actual diff content — see the follow-up issue
        filed alongside this PR for real diff rendering). */}
      {expandedFileChange && (
        <>
          <div className="session-file-change-detail" onClick={(e) => e.stopPropagation()}>
            <span className="session-file-change-detail-path" title={expandedFileChange.path}>
              {expandedFileChange.path}
            </span>
            <span className="session-file-change-detail-meta">
              {fileChangeLetter(expandedFileChange.action)} · {expandedFileChange.count} change
              {expandedFileChange.count === 1 ? "" : "s"}
            </span>
          </div>
          <SessionFileDiff
            key={`${sessionId}\0${expandedFileChange.path}`}
            sessionId={sessionId}
            filePath={expandedFileChange.path}
          />
        </>
      )}
    </>
  );
}
