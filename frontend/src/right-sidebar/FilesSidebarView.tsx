import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/index.js";
import type { ProjectDirEntry } from "../api/index.js";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  RefreshIcon,
} from "../ui/icons.js";
import { SidebarToolbar } from "./SidebarToolbar.js";
import { EmptyStateNote } from "../ui/EmptyState.js";
import type { RightSidebarViewProps } from "./views.js";

// Same set the backend's quick-open search skips (SEARCH_SKIP_DIRS in
// services/project-files.ts): listing them is just noise in a compact tree.
const HIDDEN_DIRS = new Set([".git", "node_modules", ".mullion-worktrees"]);

interface DirState {
  entries: ProjectDirEntry[];
  truncated: boolean;
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

// A lazily loaded project file tree for the right sidebar. A click on a file
// opens it in an editor-only panel; New file / New folder create inside the
// last folder clicked. Rename and delete stay in the full file-editor panel.
export function FilesSidebarView({ projectId, actions }: RightSidebarViewProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
  // The folder New file / New folder create in: the last folder clicked.
  const [selectedDir, setSelectedDir] = useState("");
  const [creating, setCreating] = useState(false);
  const [newEntry, setNewEntry] = useState<{ kind: "file" | "dir"; name: string } | null>(null);
  // The project this view is currently showing — a listing that resolves
  // after the followed project changed belongs to the old project and must
  // not land in the new one's tree.
  const activeProject = useRef(projectId);

  const loadDir = useCallback(
    async (dirPath: string) => {
      try {
        const listing = await api.listProjectFiles(projectId, dirPath);
        if (activeProject.current !== projectId) return;
        setDirs((prev) => ({
          ...prev,
          [dirPath]: { entries: listing.entries, truncated: listing.truncated },
        }));
        setError(null);
      } catch (err) {
        if (activeProject.current !== projectId) return;
        setError(err instanceof ApiError ? err.message : "Couldn't list files");
      }
    },
    [projectId],
  );

  // Start over whenever the followed project changes.
  useEffect(() => {
    activeProject.current = projectId;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDirs({});
    setExpanded(new Set([""]));
    setSelectedDir("");
    setNewEntry(null);
    setCreating(false);
    void loadDir("");
  }, [projectId, loadDir]);

  const toggleDir = (dirPath: string) => {
    const open = expanded.has(dirPath);
    setSelectedDir(dirPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
    if (!open && !dirs[dirPath]) void loadDir(dirPath);
  };

  const refresh = () => {
    // Re-list everything that is currently open.
    for (const dirPath of expanded) void loadDir(dirPath);
  };

  const startCreate = (kind: "file" | "dir") => {
    // Make sure the target folder is visible so the new entry shows up there.
    if (!expanded.has(selectedDir)) toggleDir(selectedDir);
    setNewEntry({ kind, name: "" });
  };

  const commitCreate = async () => {
    if (!newEntry || creating) return;
    const name = newEntry.name.trim();
    if (!name) return setNewEntry(null);
    if (name.includes("/")) {
      setError("A name can't contain '/'");
      return;
    }
    const target = joinPath(selectedDir, name);
    const forProject = projectId;
    setCreating(true);
    try {
      if (newEntry.kind === "file") {
        await api.writeProjectFile(projectId, target, "", { create: true });
      } else {
        await api.mkdirProjectDir(projectId, target);
      }
      // The followed project changed mid-request: the new tree owns the view.
      if (activeProject.current !== forProject) return;
      setNewEntry(null);
      setError(null);
      await loadDir(selectedDir);
      if (newEntry.kind === "file") actions.onOpenFile(projectId, target);
    } catch (err) {
      if (activeProject.current !== forProject) return;
      setError(err instanceof ApiError ? err.message : "Couldn't create it");
    } finally {
      setCreating(false);
    }
  };

  const renderDir = (dirPath: string, depth: number): ReactNode => {
    const dir = dirs[dirPath];
    if (!dir) return null;
    const indent = { paddingLeft: 6 + depth * 14 };
    return (
      <>
        {dir.entries
          .filter((e) => !(e.kind === "dir" && HIDDEN_DIRS.has(e.name)))
          .map((entry) => {
            const entryPath = joinPath(dirPath, entry.name);
            const isDir =
              entry.kind === "dir" || (entry.kind === "symlink" && entry.targetKind === "dir");
            const unopenable = entry.kind === "symlink" && entry.targetKind === "outside";
            if (isDir) {
              const open = expanded.has(entryPath);
              return (
                <div key={entryPath}>
                  <button
                    type="button"
                    className={`agent-rules-panel-row file-editor-row${entryPath === selectedDir ? " selected" : ""}`}
                    style={indent}
                    aria-expanded={open}
                    onClick={() => toggleDir(entryPath)}
                  >
                    {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    <FolderIcon size={13} />
                    <span className="agent-rules-panel-row-name">{entry.name}</span>
                  </button>
                  {open && renderDir(entryPath, depth + 1)}
                </div>
              );
            }
            return (
              <button
                key={entryPath}
                type="button"
                className={`agent-rules-panel-row file-editor-row${unopenable ? " file-editor-row-muted" : ""}`}
                style={indent}
                disabled={unopenable}
                title={unopenable ? "Symlink to outside the project — can't be opened" : undefined}
                onClick={() => {
                  setSelectedDir(dirPath);
                  actions.onOpenFile(projectId, entryPath);
                }}
              >
                <FileTextIcon size={13} />
                <span className="agent-rules-panel-row-name">{entry.name}</span>
                {entry.kind === "symlink" && (
                  <span className="agent-rules-panel-row-meta">link</span>
                )}
              </button>
            );
          })}
        {dir.truncated && (
          <div className="agent-rules-panel-row-meta" style={indent}>
            …list truncated
          </div>
        )}
      </>
    );
  };

  return (
    <div className="files-sidebar-view">
      <SidebarToolbar
        actions={[
          { key: "refresh", label: "Refresh", icon: RefreshIcon, onClick: refresh },
          {
            key: "new-file",
            label: `New file in ${selectedDir || "project root"}`,
            icon: FilePlusIcon,
            onClick: () => startCreate("file"),
          },
          {
            key: "new-folder",
            label: `New folder in ${selectedDir || "project root"}`,
            icon: FolderPlusIcon,
            onClick: () => startCreate("dir"),
          },
          {
            key: "open-editor",
            label: "Open file browser panel",
            icon: ExternalLinkIcon,
            onClick: () => actions.onOpenFileEditor(projectId),
          },
        ]}
      />
      {newEntry && (
        <input
          className="file-editor-new-input"
          autoFocus
          placeholder={`New ${newEntry.kind === "file" ? "file" : "folder"} in ${selectedDir || "/"}`}
          value={newEntry.name}
          onChange={(e) => setNewEntry({ ...newEntry, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitCreate();
            else if (e.key === "Escape") setNewEntry(null);
          }}
          onBlur={() => {
            if (!newEntry.name.trim()) setNewEntry(null);
          }}
        />
      )}
      {error && <EmptyStateNote>{error}</EmptyStateNote>}
      {renderDir("", 0)}
    </div>
  );
}
