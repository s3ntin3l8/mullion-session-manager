import { useCallback, useState, type DragEvent } from "react";
import { collectDroppedTree, type UploadItem } from "../lib/dropped-files.js";

// An OS-file drag (as opposed to one of the app's own row drags, which carry
// custom MIME types and never "Files").
export function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

// Drop-to-upload wiring for a file tree. `dropProps(dir)` goes on the element
// that represents folder `dir` ("" = the tree root); the innermost target
// under the pointer wins (a folder row stops the event from also reaching the
// tree). `dropKey` says which target to highlight: by default a target's key
// is its folder, but the tree root (which uploads into the selected folder)
// passes its own key so it doesn't light up together with that folder's row.
export function useUploadDropTarget(
  onItems: (items: UploadItem[], targetDir: string) => void,
  onTruncated?: () => void,
) {
  const [dropKey, setDropKey] = useState<string | null>(null);

  const dropProps = useCallback(
    (dir: string, key: string = dir) => ({
      onDragOver: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDropKey(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropKey((cur) => (cur === key ? null : cur));
      },
      onDrop: (e: DragEvent) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropKey(null);
        // Entries must be read synchronously off the event; the walk is async.
        void collectDroppedTree(e.dataTransfer).then(({ items, truncated }) => {
          if (truncated) onTruncated?.();
          onItems(items, dir);
        });
      },
    }),
    [onItems, onTruncated],
  );

  return { dropKey, dropProps };
}
