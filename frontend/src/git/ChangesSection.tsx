import { useState } from "react";
import type { GitFileStatus } from "../api/index.js";
import { ProjectFileDiff } from "../SourceControlSection.js";
import { useDashboardStore } from "../store/index.js";
import { FileTextIcon } from "../ui/icons.js";
import { IconButton, SidebarRow, SidebarSection, StatusChip } from "../ui/sidebar/index.js";
import type { Tone } from "../lib/statusTone.js";

const STATUS_TONE: Record<GitFileStatus["status"], Tone> = {
  A: "success",
  D: "danger",
  U: "danger",
  M: "warn",
  "?": "neutral",
};

export interface ChangesSectionProps {
  projectId: number;
  onEditFile: (path: string) => void;
}

/** The working-tree changes, one SidebarRow per file with the inline diff. */
export function ChangesSection({ projectId, onEditFile }: ChangesSectionProps) {
  const status = useDashboardStore((s) => s.gitStatuses[projectId]);
  const problem = useDashboardStore((s) => s.gitProblems[projectId]);
  const [expanded, setExpanded] = useState<{ projectId: number; path: string } | null>(null);
  const openPath = expanded?.projectId === projectId ? expanded.path : null;

  return (
    <SidebarSection
      title="Changes"
      count={status?.files.length}
      persistKey="git.changes"
      defaultOpen
    >
      {problem && status && (
        <div className="sc-row-error" role="status">
          Showing the last known status. {problem.message}
        </div>
      )}
      {!status ? (
        <div className="sc-empty">{problem ? problem.message : "Not a git repository."}</div>
      ) : status.isClean ? (
        <div className="sc-empty">Working tree clean</div>
      ) : (
        status.files.map((file) => {
          const isDirectory = file.path.endsWith("/");
          const name = file.path.split("/").filter(Boolean).pop() ?? file.path;
          return (
            <div key={file.path}>
              <SidebarRow
                lead={
                  <span
                    className={`sb-dot sb-dot--${STATUS_TONE[file.status]}`}
                    aria-hidden="true"
                  />
                }
                title={<span title={file.path}>{name}</span>}
                meta={<span className="mono">{file.path}</span>}
                trailing={<StatusChip tone={STATUS_TONE[file.status]}>{file.status}</StatusChip>}
                actions={
                  file.status !== "D" && !isDirectory ? (
                    <IconButton label={`Edit ${file.path}`} onClick={() => onEditFile(file.path)}>
                      <FileTextIcon size={13} />
                    </IconButton>
                  ) : undefined
                }
                selected={openPath === file.path}
                onClick={
                  isDirectory
                    ? undefined
                    : () =>
                        setExpanded(openPath === file.path ? null : { projectId, path: file.path })
                }
              />
              {!isDirectory && openPath === file.path && (
                <ProjectFileDiff projectId={projectId} filePath={file.path} />
              )}
            </div>
          );
        })
      )}
      {status?.hasConflicts && (
        <div className="sc-row-error" role="alert">
          This checkout has unresolved merge conflicts.
        </div>
      )}
    </SidebarSection>
  );
}
