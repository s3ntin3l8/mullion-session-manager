// "This file or folder is gone from `path`" — renamed, moved or deleted from a
// file tree. Whoever owns the editor panels (usePanelOpener) closes the ones
// that were open on it. A channel rather than a prop so the right sidebar's tree
// and the file-browser panel's tree report it the same way, without either
// reaching for dockview.
export interface FilePathGone {
  projectId: number;
  sessionId: number | undefined;
  path: string;
}

const listeners = new Set<(e: FilePathGone) => void>();

export function emitFilePathGone(e: FilePathGone): void {
  for (const l of listeners) l(e);
}

export function subscribeFilePathGone(l: (e: FilePathGone) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
