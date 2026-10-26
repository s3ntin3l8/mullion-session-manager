// Reading files out of a drag-and-drop DataTransfer — shared by the terminal's
// "drop to attach" and the file browser's "drop to upload".

/** Files from a drop, minus folders (which the browser exposes as an empty
 * pseudo-file an upload would just fail on). Walks `items` (kind === "file")
 * rather than index-matching it against `files` — a drag from another app can
 * carry string items too, which would shift the indexes. Falls back to
 * `files` where `items` is unavailable. */
export function droppedFiles(dt: DataTransfer): { files: File[]; skipped: number } {
  if (!dt.items || dt.items.length === 0) return { files: Array.from(dt.files), skipped: 0 };
  const out: File[] = [];
  let skipped = 0;
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    // Without webkitGetAsEntry, a folder is indistinguishable from a file
    // except by its zero size and empty type — and an empty file is not worth
    // uploading anyway.
    const entry = item.webkitGetAsEntry?.();
    if (entry ? entry.isDirectory : file.size === 0 && file.type === "") {
      skipped++;
      continue;
    }
    out.push(file);
  }
  return { files: out, skipped };
}

/** A file to upload and where it goes, relative to the drop/target folder
 * (`a.txt`, or `photos/2024/a.txt` for a file inside a dropped folder). */
export interface UploadItem {
  file: File;
  relativePath: string;
}

// A runaway tree (a dropped node_modules) must not hang the tab or flood the
// server; the remainder is reported, not silently dropped.
export const MAX_DROPPED_ENTRIES = 5000;

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; keep asking until empty.
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Files AND folders from a drop, folders walked recursively. The entries must
 * be taken from `dt.items` synchronously (they are invalidated once the drop
 * handler yields), so call this straight from the event handler. */
export function collectDroppedTree(
  dt: DataTransfer,
): Promise<{ items: UploadItem[]; truncated: boolean }> {
  const roots: FileSystemEntry[] = [];
  const plain: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) plain.push(file);
    }
  }
  if (roots.length === 0 && plain.length === 0) {
    // No `items` (old browser / synthetic event): the flat list.
    for (const file of Array.from(dt.files)) plain.push(file);
  }
  return (async () => {
    const items: UploadItem[] = plain.map((file) => ({ file, relativePath: file.name }));
    let truncated = false;
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (items.length >= MAX_DROPPED_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isFile) {
        const file = await fileOf(entry as FileSystemFileEntry);
        items.push({ file, relativePath: `${prefix}${entry.name}` });
        return;
      }
      if (!entry.isDirectory) return;
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) await walk(child, `${prefix}${entry.name}/`);
    };
    for (const root of roots) await walk(root, "");
    return { items, truncated };
  })();
}

/** Items for an `<input type=file webkitdirectory>` selection, which carries
 * each file's path inside the chosen folder on `webkitRelativePath`. */
export function itemsFromInput(files: FileList | File[]): UploadItem[] {
  return Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}
