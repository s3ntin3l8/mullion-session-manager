import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { collectDroppedTree, type UploadItem } from "../lib/dropped-files.js";
import {
  activeFileDrag,
  hasFileDrag,
  readFileDrag,
  type FileDragPayload,
} from "../lib/fileDrag.js";
import { checkMove } from "../lib/fileTreeMove.js";

// An OS-file drag (as opposed to one of the app's own row drags, which carry
// custom MIME types and never "Files").
export function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

// How long a drag must rest on a closed folder before it opens.
const HOVER_EXPAND_MS = 600;

export interface DropTargetOptions {
  /** Highlight key; default is the folder itself. The tree background passes
   * its own so it doesn't light up together with the selected folder's row. */
  key?: string;
  /** Where a MOVE lands when it differs from where an upload does (the tree
   * background uploads into the selected folder but moves to the root). */
  moveDir?: string;
  /** A folder row: a drag resting on it for a moment asks `onHoverFolder`. */
  folder?: boolean;
}

// Drop wiring for a file tree, two kinds of drag onto one target:
//  - files dragged in from the OS upload into `dir`;
//  - a row dragged from a tree (this one or another; FILE_DRAG_MIME) MOVES into
//    `moveDir`, if `move.canMove` and the move rules agree.
// `dropProps(dir, opts)` goes on the element that stands for folder `dir`
// ("" = the tree root); the innermost target under the pointer wins, and
// `dropKey` says which one to highlight.
export function useTreeDropTarget(opts: {
  onUpload: (items: UploadItem[], targetDir: string) => void;
  onTruncated?: () => void;
  move?: {
    tree: { projectId: number; sessionId: number | null };
    /** Extra veto, e.g. a file with unsaved edits. */
    canMove?: (drag: FileDragPayload, toDir: string) => boolean;
    onMove: (drag: FileDragPayload, toDir: string) => void;
  };
  onHoverFolder?: (dir: string) => void;
}) {
  const { onUpload, onTruncated, move, onHoverFolder } = opts;
  const [dropKey, setDropKey] = useState<string | null>(null);
  const hover = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearHover = useCallback(() => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  }, []);
  useEffect(() => clearHover, [clearHover]);

  const legalMove = useCallback(
    (drag: FileDragPayload | null, toDir: string) =>
      drag !== null &&
      move !== undefined &&
      checkMove(drag, move.tree, toDir).ok &&
      (move.canMove?.(drag, toDir) ?? true),
    [move],
  );

  const dropProps = useCallback(
    (dir: string, o: DropTargetOptions = {}) => {
      const key = o.key ?? dir;
      const moveDir = o.moveDir ?? dir;
      return {
        onDragOver: (e: DragEvent) => {
          if (isFileDrag(e)) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            setDropKey(key);
            return;
          }
          if (!move || !hasFileDrag(e.dataTransfer)) return;
          // The drag's data is hidden until the drop, so judge it from the one
          // in flight. An illegal target swallows the event without
          // preventDefault: the cursor says "no", and no ancestor claims it.
          e.stopPropagation();
          if (!legalMove(activeFileDrag(), moveDir)) {
            setDropKey((cur) => (cur === key ? null : cur));
            clearHover();
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropKey(key);
          if (o.folder && onHoverFolder && hover.current?.key !== key) {
            clearHover();
            hover.current = {
              key,
              timer: setTimeout(() => onHoverFolder(dir), HOVER_EXPAND_MS),
            };
          }
        },
        onDragLeave: (e: DragEvent) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropKey((cur) => (cur === key ? null : cur));
          if (hover.current?.key === key) clearHover();
        },
        onDrop: (e: DragEvent) => {
          if (isFileDrag(e)) {
            e.preventDefault();
            e.stopPropagation();
            setDropKey(null);
            // Entries must be read synchronously off the event; the walk is async.
            void collectDroppedTree(e.dataTransfer).then(({ items, truncated }) => {
              if (truncated) onTruncated?.();
              onUpload(items, dir);
            });
            return;
          }
          if (!move || !hasFileDrag(e.dataTransfer)) return;
          e.stopPropagation();
          setDropKey(null);
          clearHover();
          const drag = readFileDrag(e.dataTransfer);
          if (!drag || !legalMove(drag, moveDir)) return;
          e.preventDefault();
          move.onMove(drag, moveDir);
        },
      };
    },
    [move, legalMove, clearHover, onHoverFolder, onTruncated, onUpload],
  );

  return { dropKey, dropProps };
}
