import { useSyncExternalStore } from "react";

// Files that currently hold unsaved edits in an editor panel, across every
// open panel. A file tree in another panel (the sidebar's) uses it to refuse
// renaming, moving or deleting a file out from under a draft.
const dirty = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (projectId: number, sessionId: number | undefined, path: string) =>
  `${projectId}\0${sessionId ?? ""}\0${path}`;

export function setFileDirty(
  projectId: number,
  sessionId: number | undefined,
  path: string,
  isDirty: boolean,
): void {
  const key = keyOf(projectId, sessionId, path);
  if (isDirty === dirty.has(key)) return;
  if (isDirty) dirty.add(key);
  else dirty.delete(key);
  version++;
  for (const l of listeners) l();
}

/** Whether `path` — or, for a folder, any file under it — has unsaved edits. */
export function hasDirtyFileUnder(
  projectId: number,
  sessionId: number | undefined,
  path: string,
): boolean {
  const exact = keyOf(projectId, sessionId, path);
  const under = `${exact}/`;
  for (const key of dirty) if (key === exact || key.startsWith(under)) return true;
  return false;
}

/** Re-renders the caller whenever the dirty set changes. */
export function useDirtyFilesVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}
