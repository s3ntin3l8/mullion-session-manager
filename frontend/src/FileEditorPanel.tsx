import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api/index.js";
import type { ProjectDirEntry, ProjectFileContent } from "./api/index.js";
import { CodeEditor } from "./components/CodeEditor.js";
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon, FolderIcon } from "./ui/icons.js";
import { EmptyStateNote } from "./ui/EmptyState.js";
import { useDashboardStore } from "./store/index.js";

export interface FileEditorPanelParams {
  projectId: number;
  /** Project-relative file to open on mount. */
  path?: string;
  /** Roots the editor at this session's cwd (e.g. its worktree) instead of
   * the project's. */
  sessionId?: number;
}

interface DirState {
  entries: ProjectDirEntry[];
  truncated: boolean;
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function parentDir(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// A dockview panel for editing plain-text project files (a gitignored .env,
// a config, ...): a lazily-loaded file tree on the left, a CodeMirror editor
// on the right. Reads/writes go through routes/project-files.ts, which
// contains every path to the project root and serves remote-hosted projects
// via their own host. The tree lists a directory only when it's expanded
// (dotfiles and gitignored files included — that's the point), and an edit
// is guarded two ways: rows for other files are disabled while the draft is
// dirty (same posture as AgentRulesPanel), and a save sends the mtime the
// file was loaded with so a concurrent on-disk change surfaces as a conflict
// instead of being silently overwritten.
function FileEditorBody({
  params,
  onDirtyChange,
}: {
  params: FileEditorPanelParams;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { projectId, sessionId } = params;
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [rootError, setRootError] = useState<string | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [file, setFile] = useState<ProjectFileContent | null>(null);
  const [draft, setDraft] = useState("");
  // A file we can't show as text (too large / binary) or failed to open.
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const openSeq = useRef(0);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const dirty = file !== null && draft !== file.content;
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const loadDir = useCallback(
    async (dirPath: string): Promise<boolean> => {
      try {
        const listing = await api.listProjectFiles(projectId, dirPath, sessionId);
        setDirs((prev) => ({
          ...prev,
          [dirPath]: { entries: listing.entries, truncated: listing.truncated },
        }));
        return true;
      } catch (err) {
        const message = errorMessage(err, "Couldn't list files");
        if (dirPath === "") setRootError(message);
        else setTreeError(message);
        return false;
      }
    },
    [projectId, sessionId],
  );

  const openFile = useCallback(
    async (filePath: string) => {
      const seq = ++openSeq.current;
      setActionError(null);
      setConflict(false);
      try {
        const loaded = await api.readProjectFile(projectId, filePath, sessionId);
        if (seq !== openSeq.current) return;
        setFile(loaded);
        setDraft(loaded.content);
        setFileNote(null);
        setTreeOpen(false);
      } catch (err) {
        if (seq !== openSeq.current) return;
        const code = err instanceof ApiError ? err.code : undefined;
        setFile(null);
        setDraft("");
        setFileNote(
          code === "too_large"
            ? `${filePath} is over the 1 MiB edit limit — too large to edit here.`
            : code === "binary"
              ? `${filePath} isn't a UTF-8 text file — it can't be edited here.`
              : errorMessage(err, `Couldn't open ${filePath}`),
        );
        setTreeOpen(false);
      }
    },
    [projectId, sessionId],
  );

  // Initial load: the root listing, plus `params.path` if given (with its
  // parent directories expanded so the tree shows where it lives).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await loadDir("");
      if (!ok || cancelled || !params.path) return;
      const parts = parentDir(params.path).split("/").filter(Boolean);
      const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      for (const dir of ancestors) {
        if (cancelled) return;
        await loadDir(dir);
      }
      if (cancelled) return;
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      // Never replace an unsaved draft because the panel was re-targeted.
      if (!dirtyRef.current) await openFile(params.path);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDir, openFile, params.path]);

  const toggleDir = useCallback(
    async (dirPath: string) => {
      setTreeError(null);
      if (expanded.has(dirPath)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
        return;
      }
      if (!dirs[dirPath]) {
        if (!(await loadDir(dirPath))) return;
      }
      setExpanded((prev) => new Set(prev).add(dirPath));
    },
    [expanded, dirs, loadDir],
  );

  const handleSave = useCallback(
    async (overwrite = false) => {
      if (!file) return;
      const saved = draftRef.current;
      setSaving(true);
      setActionError(null);
      try {
        const res = await api.writeProjectFile(
          projectId,
          file.path,
          saved,
          overwrite ? {} : { expectedMtimeMs: file.mtimeMs },
          sessionId,
        );
        setFile((prev) =>
          prev ? { ...prev, content: saved, size: res.size, mtimeMs: res.mtimeMs } : prev,
        );
        setConflict(false);
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") setConflict(true);
        else setActionError(errorMessage(err, "Failed to save"));
      } finally {
        setSaving(false);
      }
    },
    [file, projectId, sessionId],
  );

  const handleSaveClick = useCallback(() => void handleSave(false), [handleSave]);

  const handleDiscard = useCallback(() => {
    if (!file) return;
    setDraft(file.content);
    setActionError(null);
    setConflict(false);
  }, [file]);

  const handleReload = useCallback(() => {
    if (file) void openFile(file.path);
  }, [file, openFile]);

  const handleCreate = useCallback(async () => {
    const name = (newFileName ?? "").trim();
    if (!name) return;
    // A bare name only: the backend never creates parent directories, and the
    // tree only refreshes the immediate parent, so a nested path would land
    // on disk without showing up.
    if (name.includes("/")) {
      setTreeError("Enter a file name, not a path — new files are created in the current folder.");
      return;
    }
    const dir = file ? parentDir(file.path) : "";
    const target = joinPath(dir, name);
    setActionError(null);
    try {
      await api.writeProjectFile(projectId, target, "", { create: true }, sessionId);
      setNewFileName(null);
      await loadDir(parentDir(target));
      await openFile(target);
    } catch (err) {
      setActionError(errorMessage(err, "Failed to create file"));
    }
  }, [newFileName, file, projectId, sessionId, loadDir, openFile]);

  const renderDir = (dirPath: string, depth: number): ReactNode => {
    const dir = dirs[dirPath];
    if (!dir) return null;
    return (
      <>
        {dir.entries.map((entry) => {
          const entryPath = joinPath(dirPath, entry.name);
          const isDir =
            entry.kind === "dir" || (entry.kind === "symlink" && entry.targetKind === "dir");
          const unopenable = entry.kind === "symlink" && entry.targetKind === "outside";
          const indent = { paddingLeft: 6 + depth * 14 };
          if (isDir) {
            const isOpen = expanded.has(entryPath);
            return (
              <div key={entryPath}>
                <button
                  className="agent-rules-panel-row file-editor-row"
                  style={indent}
                  onClick={() => void toggleDir(entryPath)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                  <FolderIcon size={13} />
                  <span className="agent-rules-panel-row-name">{entry.name}</span>
                </button>
                {isOpen && renderDir(entryPath, depth + 1)}
              </div>
            );
          }
          const blocked = dirty && entryPath !== file?.path;
          return (
            <button
              key={entryPath}
              className={`agent-rules-panel-row file-editor-row${entryPath === file?.path ? " selected" : ""}${unopenable ? " file-editor-row-muted" : ""}`}
              style={indent}
              onClick={() => void openFile(entryPath)}
              disabled={unopenable || blocked}
              title={
                unopenable
                  ? "Symlink to outside the project — can't be edited"
                  : blocked
                    ? "Save or discard your changes first"
                    : undefined
              }
            >
              <FileTextIcon size={13} />
              <span className="agent-rules-panel-row-name">{entry.name}</span>
              {entry.kind === "symlink" && <span className="agent-rules-panel-row-meta">link</span>}
            </button>
          );
        })}
        {dir.truncated && (
          <div className="agent-rules-panel-row-meta" style={{ paddingLeft: 6 + depth * 14 }}>
            …list truncated
          </div>
        )}
      </>
    );
  };

  if (!dirs[""]) {
    if (rootError) {
      return (
        <EmptyStateNote>
          <div>{rootError}</div>
          <button
            className="git-panel-fetch-btn"
            onClick={() => {
              setRootError(null);
              void loadDir("");
            }}
          >
            Retry
          </button>
        </EmptyStateNote>
      );
    }
    return <EmptyStateNote>Loading…</EmptyStateNote>;
  }

  return (
    <div className={`agent-rules-panel file-editor-panel${treeOpen ? " tree-open" : ""}`}>
      <div className="agent-rules-panel-list file-editor-tree cmux-scroll">
        <div className="file-editor-tree-actions">
          <button
            className="git-panel-fetch-btn"
            onClick={() => {
              setTreeError(null);
              void Promise.all([...expanded].map((d) => loadDir(d)));
            }}
          >
            Refresh
          </button>
          <button
            className="git-panel-fetch-btn"
            onClick={() => setNewFileName("")}
            disabled={dirty}
            title={dirty ? "Save or discard your changes first" : undefined}
          >
            New file
          </button>
        </div>
        {newFileName !== null && (
          <div className="file-editor-new">
            <input
              className="file-editor-new-input"
              autoFocus
              value={newFileName}
              placeholder={`name in ${file ? parentDir(file.path) || "project root" : "project root"}`}
              aria-label="New file name"
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
                if (e.key === "Escape") setNewFileName(null);
              }}
            />
          </div>
        )}
        {treeError && <div className="agent-rules-panel-notice error">{treeError}</div>}
        {renderDir("", 0)}
      </div>

      <div className="agent-rules-panel-editor file-editor-main">
        <button
          className="git-panel-fetch-btn file-editor-tree-toggle"
          onClick={() => setTreeOpen((v) => !v)}
        >
          Files
        </button>
        {!file ? (
          <EmptyStateNote>
            <FileTextIcon size={20} />
            <div>{fileNote ?? "Select a file to view or edit it."}</div>
          </EmptyStateNote>
        ) : (
          <>
            <div className="agent-rules-panel-editor-header">
              <div className="agent-rules-panel-editor-title">
                <FileTextIcon size={14} />
                {file.path}
                {file.symlinkTarget && (
                  <span className="agent-rules-panel-row-meta">→ {file.symlinkTarget}</span>
                )}
                {dirty && (
                  <span className="agent-rules-panel-row-meta" aria-label="Unsaved changes">
                    ●
                  </span>
                )}
              </div>
              <div className="agent-rules-panel-editor-actions">
                {dirty && (
                  <button className="git-panel-fetch-btn" onClick={handleDiscard} disabled={saving}>
                    Discard
                  </button>
                )}
                <button
                  className="git-panel-fetch-btn"
                  onClick={handleSaveClick}
                  disabled={!dirty || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            {conflict && (
              <div className="agent-rules-panel-notice warning">
                {file.path} changed on disk since you opened it.{" "}
                <button className="git-panel-fetch-btn" onClick={handleReload}>
                  Reload from disk
                </button>{" "}
                <button className="git-panel-fetch-btn" onClick={() => void handleSave(true)}>
                  Overwrite
                </button>
              </div>
            )}
            {actionError && <div className="agent-rules-panel-notice error">{actionError}</div>}
            <CodeEditor
              key={file.path}
              value={draft}
              onChange={setDraft}
              fileName={file.path}
              onSave={handleSaveClick}
              ariaLabel={`Editing ${file.path}`}
            />
          </>
        )}
      </div>
    </div>
  );
}

// The panel proper: a root picker (the project, or one of its sessions that
// runs in a different directory — typically a git worktree, whose gitignored
// .env is its own) above the editor body. Switching root remounts the body
// (via `key`) so the tree, open file and draft never leak across roots, and
// the picker is disabled while the body reports unsaved edits.
export function FileEditorPanel({ params }: { params: FileEditorPanelParams }) {
  const [sessionId, setSessionId] = useState<number | undefined>(params.sessionId);
  const [dirty, setDirty] = useState(false);
  const projectCwd = useDashboardStore(
    (s) => s.projects.find((p) => p.id === params.projectId)?.cwd,
  );
  const allSessions = useDashboardStore((s) => s.sessions);

  // A re-target from outside (git row "Edit", a terminal path link) names a
  // session; follow it, but only when the param itself CHANGED (a manual
  // picker choice must survive later renders) and never over unsaved edits.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const lastParamSession = useRef(params.sessionId);
  useEffect(() => {
    if (params.sessionId === lastParamSession.current) return;
    lastParamSession.current = params.sessionId;
    if (!dirtyRef.current) setSessionId(params.sessionId);
  }, [params.sessionId]);

  const roots = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ sessionId: number; label: string }> = [];
    for (const s of allSessions) {
      if (s.projectId !== params.projectId || s.status !== "active" || !s.cwd) continue;
      if (s.cwd === projectCwd || seen.has(s.cwd)) continue;
      seen.add(s.cwd);
      list.push({ sessionId: s.id, label: s.cwd.split("/").filter(Boolean).pop() ?? s.cwd });
    }
    return list;
  }, [allSessions, params.projectId, projectCwd]);

  return (
    <div className="file-editor-shell">
      {(roots.length > 0 || sessionId !== undefined) && (
        <div className="file-editor-rootbar">
          <label>
            <span className="agent-rules-panel-row-meta">Root</span>{" "}
            <select
              className="file-editor-root-select"
              value={sessionId ?? ""}
              disabled={dirty}
              title={dirty ? "Save or discard your changes first" : undefined}
              onChange={(e) =>
                setSessionId(e.target.value === "" ? undefined : Number(e.target.value))
              }
            >
              <option value="">Project</option>
              {roots.map((r) => (
                <option key={r.sessionId} value={r.sessionId}>
                  Worktree: {r.label}
                </option>
              ))}
              {sessionId !== undefined && !roots.some((r) => r.sessionId === sessionId) && (
                <option value={sessionId}>Session {sessionId}</option>
              )}
            </select>
          </label>
        </div>
      )}
      <FileEditorBody
        key={sessionId ?? "project"}
        params={{ ...params, sessionId }}
        onDirtyChange={setDirty}
      />
    </div>
  );
}
