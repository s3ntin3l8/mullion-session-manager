import { useCallback } from "react";
import { api, ApiError } from "../api/index.js";
import { baseName, parentOf } from "../lib/fileTreeMove.js";

export type MutationResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, name: string, intoDir: string | null, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === "conflict") {
      return intoDir === null
        ? `${name} already exists`
        : `${name} already exists in ${intoDir === "" ? "the project root" : intoDir}`;
    }
    if (err.code === "not_empty") return `${name} isn't empty — only empty folders can be deleted`;
    return err.message;
  }
  return fallback;
}

// The file-tree edits both trees (the sidebar's and the panel's) share:
// rename, move and delete against one root (the project, or a session's
// checkout). They report an outcome instead of throwing, so each tree keeps
// its own error surface; what to re-list afterwards is `onChanged`'s call.
export function useFileTreeMutations(opts: {
  projectId: number;
  sessionId?: number;
  /** Folders whose listing changed (each already re-listable). */
  onChanged: (dirs: string[]) => void;
}) {
  const { projectId, sessionId, onChanged } = opts;

  const rename = useCallback(
    async (from: string, newName: string): Promise<MutationResult<{ to: string }>> => {
      const name = newName.trim();
      if (!name || name === baseName(from)) return { ok: false, error: "" };
      if (name.includes("/")) return { ok: false, error: "Enter a name, not a path." };
      const parent = parentOf(from);
      const to = parent === "" ? name : `${parent}/${name}`;
      try {
        await api.renameProjectPath(projectId, from, to, sessionId);
      } catch (err) {
        return { ok: false, error: describe(err, name, parent, "Failed to rename") };
      }
      onChanged([parent]);
      return { ok: true, to };
    },
    [projectId, sessionId, onChanged],
  );

  // Moves `from` into folder `toDir` ("" = root) keeping its name.
  const move = useCallback(
    async (from: string, toDir: string): Promise<MutationResult<{ to: string }>> => {
      const name = baseName(from);
      const to = toDir === "" ? name : `${toDir}/${name}`;
      try {
        await api.renameProjectPath(projectId, from, to, sessionId);
      } catch (err) {
        return { ok: false, error: describe(err, name, toDir, "Failed to move") };
      }
      onChanged([...new Set([parentOf(from), toDir])]);
      return { ok: true, to };
    },
    [projectId, sessionId, onChanged],
  );

  const remove = useCallback(
    async (path: string): Promise<MutationResult> => {
      try {
        await api.deleteProjectPath(projectId, path, sessionId);
      } catch (err) {
        return { ok: false, error: describe(err, baseName(path), null, "Failed to delete") };
      }
      onChanged([parentOf(path)]);
      return { ok: true };
    },
    [projectId, sessionId, onChanged],
  );

  return { rename, move, remove };
}
