import { useCallback, useEffect, useRef } from "react";
import { itemsFromInput, type UploadItem } from "../lib/dropped-files.js";
import { useProjectUploads } from "./useProjectUploads.js";

// The upload half of a project file tree, shared by the right sidebar's tree and
// the file-browser panel's: the picker inputs, where a pick lands, uploads with
// progress, what to re-list afterwards, and the "this name is already listed"
// hint. A tree supplies how it expands/lists a folder; everything else here is
// the same in both, so it lives once.
export function useTreeUploads(opts: {
  projectId: number;
  sessionId?: number;
  /** The folders the tree has loaded, for the already-listed hint. */
  dirs: Record<string, { entries: { name: string }[] }>;
  /** The folders currently open. */
  expanded: Set<string>;
  /** Where a toolbar upload goes: the folder last clicked. */
  selectedDir: string;
  /** Opens `dir` in the tree and (re)lists it. */
  expandDir: (dir: string) => void;
  loadDir: (dir: string) => unknown;
  onTruncated: () => void;
}) {
  const { projectId, sessionId, selectedDir } = opts;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Set by "upload here" on a folder row: the next pick goes there, not to the
  // selected folder.
  const pickTargetRef = useRef<string | null>(null);

  // Latest tree state for callbacks that outlive a render (an upload finishing).
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const afterUpload = useCallback(
    (targetDir: string, root: { projectId: number; sessionId?: number }) => {
      const { projectId, sessionId, expandDir, loadDir, expanded } = latest.current;
      // The batch started in a root the tree is no longer showing: its folder
      // paths mean nothing here.
      if (root.projectId !== projectId || root.sessionId !== sessionId) return;
      // Show where the files went, and re-list every open folder (a folder
      // upload may have created subfolders).
      expandDir(targetDir);
      for (const dir of expanded) if (dir !== targetDir) void loadDir(dir);
    },
    [],
  );

  // Names already listed in a folder the tree has loaded: an upload onto one is
  // refused without sending its body (the server still decides).
  const existsHint = useCallback((path: string) => {
    const slash = path.lastIndexOf("/");
    const entries = latest.current.dirs[slash < 0 ? "" : path.slice(0, slash)]?.entries;
    return entries?.some((e) => e.name === path.slice(slash + 1)) ?? false;
  }, []);

  const uploads = useProjectUploads({ projectId, sessionId, onUploaded: afterUpload, existsHint });
  const startUpload = uploads.upload;

  const onUpload = useCallback(
    (items: UploadItem[], dir: string) => void startUpload(items, dir),
    [startUpload],
  );

  const pickFiles = (files: FileList | null, input: HTMLInputElement) => {
    const target = pickTargetRef.current ?? selectedDir;
    pickTargetRef.current = null;
    if (files && files.length > 0) void startUpload(itemsFromInput(files), target);
    input.value = ""; // the same selection can be picked again
  };

  /** Opens a picker whose files go into `dir`. */
  const pickUploadIn = (dir: string, input: HTMLInputElement | null) => {
    pickTargetRef.current = dir;
    input?.click();
  };

  return {
    uploads,
    onUpload,
    onTruncated: opts.onTruncated,
    fileInputRef,
    folderInputRef,
    pickFiles,
    pickUploadIn,
  };
}
