import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useFileTreeMutations } from "../hooks/useFileTreeMutations.js";
import { useTreeUploads } from "../hooks/useTreeUploads.js";
import { useTreeDropTarget } from "../hooks/useTreeDropTarget.js";
import { hasDirtyFileUnder, useDirtyFilesVersion } from "../lib/dirtyFiles.js";
import { endFileDrag, startFileDrag, type FileDragPayload } from "../lib/fileDrag.js";
import { emitFilePathGone } from "../lib/filePathEvents.js";
import { baseName, joinRel } from "../lib/fileTreeMove.js";
import { joinAbs } from "../lib/posixPath.js";
import { useDashboardStore } from "../store/index.js";
import { KebabMenu, type KebabMenuItem } from "../ui/KebabMenu.js";
import { TreeUploadInputs } from "../ui/TreeUploadInputs.js";
import { UploadStatus } from "../ui/UploadStatus.js";
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
  FolderUpIcon,
  RefreshIcon,
  UploadIcon,
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

// Highlight key for the tree-wide drop target (uploads into the selected folder).
const ROOT_DROP_KEY = "\0root";

const BLOCKED_TITLE = "Save or discard your changes first";

// A lazily loaded file tree for the right sidebar. It follows the focused
// session: for a session in its own git worktree the tree is that worktree's
// (what the agent is editing), otherwise the project's. A click on a file opens
// it in an editor-only panel; every row has a ⋯ menu (also on right-click) for
// open / download / copy path / rename / delete, rows drag onto a folder to move
// them or onto a terminal to reference them, and files dropped in from the OS
// upload.
export function FilesSidebarView({
  projectId,
  checkoutSessionId = null,
  actions,
}: RightSidebarViewProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
  // The folder New file / New folder / Upload act on: the last folder clicked.
  const [selectedDir, setSelectedDir] = useState("");
  const [creating, setCreating] = useState(false);
  const [newEntry, setNewEntry] = useState<{ kind: "file" | "dir"; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  // The row whose ⋯ menu a right-click is opening: its actions are shown even
  // though the pointer isn't hovering them.
  const [menuRow, setMenuRow] = useState<string | null>(null);

  // Which checkout the tree shows: the followed session's worktree, unless the
  // user flipped to the project root or the backend refused the worktree.
  const [showProjectRoot, setShowProjectRoot] = useState(false);
  const [rootRefused, setRootRefused] = useState(false);
  const [lastCheckout, setLastCheckout] = useState(checkoutSessionId);
  if (checkoutSessionId !== lastCheckout) {
    // Following a different session: forget the last one's override.
    setLastCheckout(checkoutSessionId);
    setShowProjectRoot(false);
    setRootRefused(false);
  }
  const sessionId =
    !showProjectRoot && !rootRefused && checkoutSessionId !== null ? checkoutSessionId : undefined;
  const rootKey = `${projectId}:${sessionId ?? ""}`;
  const projectCwd = useDashboardStore((s) => s.projects.find((p) => p.id === projectId)?.cwd);
  const sessionCwd = useDashboardStore((s) =>
    sessionId === undefined ? undefined : s.sessions.find((x) => x.id === sessionId)?.cwd,
  );
  const rootCwd = (sessionId === undefined ? projectCwd : sessionCwd) ?? null;
  // A listing that resolves after the followed project/checkout changed
  // belongs to the old one and must not land in the new one's tree.
  const activeRoot = useRef(rootKey);
  useDirtyFilesVersion(); // re-render when a file gains/loses unsaved edits
  const blocked = (path: string) => hasDirtyFileUnder(projectId, sessionId, path);

  const loadDir = useCallback(
    async (dirPath: string) => {
      try {
        const listing = await api.listProjectFiles(projectId, dirPath, sessionId);
        if (activeRoot.current !== rootKey) return;
        setDirs((prev) => ({
          ...prev,
          [dirPath]: { entries: listing.entries, truncated: listing.truncated },
        }));
        setError(null);
      } catch (err) {
        if (activeRoot.current !== rootKey) return;
        // The backend won't root the tree at that session (its directory moved
        // outside the project, or it can't be verified): fall back to the
        // project's own checkout rather than showing a dead tree.
        if (dirPath === "" && sessionId !== undefined && err instanceof ApiError) {
          setRootRefused(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Couldn't list files");
      }
    },
    [projectId, sessionId, rootKey],
  );

  // Start over whenever the followed project or checkout changes.
  useEffect(() => {
    activeRoot.current = rootKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDirs({});
    setExpanded(new Set([""]));
    setSelectedDir("");
    setNewEntry(null);
    setRenaming(null);
    setCreating(false);
    void loadDir("");
  }, [rootKey, loadDir]);

  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  });

  const expandDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => new Set(prev).add(dirPath));
      void loadDir(dirPath);
    },
    [loadDir],
  );

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

  // Folders whose contents changed: re-list the open ones, and drop the cached
  // listing of a closed one so expanding it later doesn't show stale rows.
  const relist = useCallback(
    (changed: string[]) => {
      for (const dirPath of changed) {
        if (dirPath === "" || expandedRef.current.has(dirPath)) void loadDir(dirPath);
        else
          setDirs((prev) => {
            const { [dirPath]: _gone, ...rest } = prev;
            return rest;
          });
      }
    },
    [loadDir],
  );

  // A file or folder (and everything under it) is gone from `path`: drop its
  // cached listings, and close the editor panels that were open on it.
  const forgetPath = useCallback(
    (path: string) => {
      const under = (k: string) => k === path || k.startsWith(`${path}/`);
      setDirs((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !under(k))));
      setExpanded((prev) => new Set([...prev].filter((k) => !under(k))));
      setSelectedDir((cur) => (under(cur) ? "" : cur));
      emitFilePathGone({ projectId, sessionId, path });
    },
    [projectId, sessionId],
  );

  const mutations = useFileTreeMutations({ projectId, sessionId, onChanged: relist });

  const tree = useTreeUploads({
    projectId,
    sessionId,
    dirs,
    expanded,
    selectedDir,
    expandDir,
    loadDir,
    onTruncated: () =>
      setError("That folder is too large to upload in one go — some files were left out"),
  });

  const moveInto = useCallback(
    async (drag: FileDragPayload, toDir: string) => {
      setError(null);
      const res = await mutations.move(drag.path, toDir);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      forgetPath(drag.path);
      expandDir(toDir);
    },
    [mutations, forgetPath, expandDir],
  );
  const { dropKey, dropProps } = useTreeDropTarget({
    onUpload: tree.onUpload,
    onTruncated: tree.onTruncated,
    move: {
      tree: { projectId, sessionId: sessionId ?? null },
      canMove: (drag) => !blocked(drag.path),
      onMove: (drag, toDir) => void moveInto(drag, toDir),
    },
    // A drag resting on a closed folder opens it so the target can be reached.
    onHoverFolder: (dir) => {
      if (!expandedRef.current.has(dir)) expandDir(dir);
    },
  });

  const startCreate = (kind: "file" | "dir", inDir = selectedDir) => {
    // Make sure the target folder is visible so the new entry shows up there.
    setSelectedDir(inDir);
    if (!expanded.has(inDir)) expandDir(inDir);
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
    const target = joinRel(selectedDir, name);
    const forRoot = rootKey;
    setCreating(true);
    try {
      if (newEntry.kind === "file") {
        await api.writeProjectFile(projectId, target, "", { create: true }, sessionId);
      } else {
        await api.mkdirProjectDir(projectId, target, sessionId);
      }
      // The followed project changed mid-request: the new tree owns the view.
      if (activeRoot.current !== forRoot) return;
      setNewEntry(null);
      setError(null);
      await loadDir(selectedDir);
      if (newEntry.kind === "file") actions.onOpenFile(projectId, target, sessionId);
    } catch (err) {
      if (activeRoot.current !== forRoot) return;
      setError(err instanceof ApiError ? err.message : "Couldn't create it");
    } finally {
      setCreating(false);
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path, value } = renaming;
    setRenaming(null);
    setError(null);
    const res = await mutations.rename(path, value);
    if (res.ok) forgetPath(path);
    else if (res.error) setError(res.error);
  };

  const commitDelete = async (path: string) => {
    setError(null);
    const res = await mutations.remove(path);
    if (res.ok) forgetPath(path);
    else setError(res.error);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useDashboardStore.getState().pushToast({ message: "Path copied", kind: "success" });
    } catch {
      setError("Couldn't copy to the clipboard");
    }
  };

  const download = (path: string) => {
    const a = document.createElement("a");
    a.href = api.projectFileDownloadUrl(projectId, path, sessionId);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const rowMenu = (entryPath: string, name: string, isDir: boolean): KebabMenuItem[] => {
    const copyItems: KebabMenuItem[] = [
      { key: "copy-rel", label: "Copy relative path", onClick: () => void copy(entryPath) },
      {
        key: "copy-abs",
        label: "Copy absolute path",
        disabled: rootCwd === null,
        onClick: () => rootCwd !== null && void copy(joinAbs(rootCwd, entryPath)),
      },
    ];
    const editItems: KebabMenuItem[] = [
      {
        key: "rename",
        label: "Rename",
        disabled: blocked(entryPath),
        title: blocked(entryPath) ? BLOCKED_TITLE : undefined,
        // The name input takes focus; the menu must not hand it back to its trigger.
        opensOverlay: true,
        onClick: () => setRenaming({ path: entryPath, value: name }),
      },
      {
        key: "delete",
        label: "Delete",
        armLabel: isDir ? "Click again to delete (empty folders only)" : "Click again to delete",
        confirm: true,
        danger: true,
        disabled: blocked(entryPath),
        title: blocked(entryPath) ? BLOCKED_TITLE : undefined,
        onClick: () => void commitDelete(entryPath),
      },
    ];
    if (isDir) {
      return [
        {
          key: "upload-files",
          label: "Upload files here",
          onClick: () => tree.pickUploadIn(entryPath, tree.fileInputRef.current),
        },
        {
          key: "upload-folder",
          label: "Upload a folder here",
          onClick: () => tree.pickUploadIn(entryPath, tree.folderInputRef.current),
        },
        {
          key: "new-file",
          label: "New file here",
          opensOverlay: true,
          onClick: () => startCreate("file", entryPath),
        },
        {
          key: "new-folder",
          label: "New folder here",
          opensOverlay: true,
          onClick: () => startCreate("dir", entryPath),
        },
        ...copyItems,
        ...editItems,
      ];
    }
    return [
      {
        key: "open",
        label: "Open",
        onClick: () => actions.onOpenFile(projectId, entryPath, sessionId),
      },
      { key: "download", label: "Download", onClick: () => download(entryPath) },
      ...copyItems,
      ...editItems,
    ];
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
            const entryPath = joinRel(dirPath, entry.name);
            const isDir =
              entry.kind === "dir" || (entry.kind === "symlink" && entry.targetKind === "dir");
            const unopenable = entry.kind === "symlink" && entry.targetKind === "outside";
            const open = isDir && expanded.has(entryPath);
            const isRenaming = renaming?.path === entryPath;
            const hot = dropKey === entryPath;
            const rowProps = isDir ? dropProps(entryPath, { folder: true }) : dropProps(dirPath);
            const mainRow = isRenaming ? (
              <input
                className="file-editor-new-input"
                style={indent}
                autoFocus
                value={renaming.value}
                aria-label={`Rename ${entry.name}`}
                onChange={(e) => setRenaming({ path: entryPath, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming((r) => (r?.path === entryPath ? null : r))}
              />
            ) : isDir ? (
              <button
                type="button"
                className={`agent-rules-panel-row file-editor-row${entryPath === selectedDir ? " selected" : ""}${hot ? " file-drop-target" : ""}`}
                style={indent}
                aria-expanded={open}
                onClick={() => toggleDir(entryPath)}
              >
                {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                <FolderIcon size={13} />
                <span className="agent-rules-panel-row-name">{entry.name}</span>
              </button>
            ) : (
              <button
                type="button"
                className={`agent-rules-panel-row file-editor-row${unopenable ? " file-editor-row-muted" : ""}`}
                style={indent}
                disabled={unopenable}
                title={unopenable ? "Symlink to outside the project — can't be opened" : undefined}
                onClick={() => {
                  setSelectedDir(dirPath);
                  actions.onOpenFile(projectId, entryPath, sessionId);
                }}
              >
                <FileTextIcon size={13} />
                <span className="agent-rules-panel-row-name">{entry.name}</span>
                {entry.kind === "symlink" && (
                  <span className="agent-rules-panel-row-meta">link</span>
                )}
              </button>
            );
            return (
              <div key={entryPath}>
                <div
                  className={`file-editor-rowwrap${menuRow === entryPath ? " menu-open" : ""}`}
                  // The drag source is the row wrapper, not the button inside it:
                  // Firefox won't drag a <button>.
                  draggable={!isRenaming && !unopenable && rootCwd !== null}
                  onDragStart={(e) =>
                    rootCwd !== null &&
                    startFileDrag(e.dataTransfer, {
                      projectId,
                      sessionId: sessionId ?? null,
                      path: entryPath,
                      kind: isDir ? "dir" : "file",
                      rootCwd,
                    })
                  }
                  onDragEnd={endFileDrag}
                  onContextMenu={(e) => {
                    if (isRenaming || unopenable) return;
                    e.preventDefault();
                    // Open the row's own ⋯ menu: reveal its actions, then click it.
                    const wrap = e.currentTarget;
                    setMenuRow(entryPath);
                    requestAnimationFrame(() =>
                      wrap.querySelector<HTMLButtonElement>(".kebab-trigger-btn")?.click(),
                    );
                  }}
                  onMouseLeave={() => setMenuRow((cur) => (cur === entryPath ? null : cur))}
                  {...rowProps}
                >
                  {mainRow}
                  {!isRenaming && !unopenable && (
                    <span className="file-editor-row-actions">
                      <KebabMenu
                        title={`Actions for ${entry.name}`}
                        items={rowMenu(entryPath, entry.name, isDir)}
                      />
                    </span>
                  )}
                </div>
                {open && renderDir(entryPath, depth + 1)}
              </div>
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

  const rootLabel = rootCwd !== null && sessionId !== undefined ? baseName(rootCwd) : null;

  return (
    <div
      className={`files-sidebar-view${dropKey === ROOT_DROP_KEY ? " file-drop-target" : ""}`}
      // The background: uploads go into the selected folder, a dragged row
      // moves to the project root.
      {...dropProps(selectedDir, { key: ROOT_DROP_KEY, moveDir: "" })}
    >
      <TreeUploadInputs
        fileRef={tree.fileInputRef}
        folderRef={tree.folderInputRef}
        onPick={tree.pickFiles}
      />
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
            key: "upload-files",
            label: `Upload files to ${selectedDir || "project root"}`,
            icon: UploadIcon,
            onClick: () => tree.pickUploadIn(selectedDir, tree.fileInputRef.current),
          },
          {
            key: "upload-folder",
            label: `Upload a folder to ${selectedDir || "project root"}`,
            icon: FolderUpIcon,
            onClick: () => tree.pickUploadIn(selectedDir, tree.folderInputRef.current),
          },
          {
            key: "open-editor",
            label: "Open file browser panel",
            icon: ExternalLinkIcon,
            onClick: () => actions.onOpenFileEditor(projectId),
          },
        ]}
      />
      {checkoutSessionId !== null && (
        <div className="files-root-chip">
          <span className="files-root-chip-label" title={rootCwd ?? undefined}>
            {rootRefused
              ? "Project root (this worktree can't be browsed here)"
              : rootLabel !== null
                ? `Worktree: ${rootLabel}`
                : "Project root"}
          </span>
          {!rootRefused && (
            <button
              type="button"
              className="git-panel-fetch-btn"
              onClick={() => setShowProjectRoot((v) => !v)}
            >
              {showProjectRoot ? "Show worktree" : "Show project root"}
            </button>
          )}
        </div>
      )}
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
      <UploadStatus
        progress={tree.uploads.progress}
        errors={tree.uploads.errors}
        onCancel={tree.uploads.cancel}
        onDismiss={tree.uploads.dismissErrors}
      />
      {error && <EmptyStateNote>{error}</EmptyStateNote>}
      {renderDir("", 0)}
    </div>
  );
}
