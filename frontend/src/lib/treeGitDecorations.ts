import type { GitFileStatus, GitFileStatusCode } from "../../../src/shared/types.js";

export type GitDecorationKind =
  "modified" | "added" | "untracked" | "deleted" | "conflict" | "dir" | "dir-conflict";

export interface GitDecoration {
  /** The file's own status, or "dir"/"dir-conflict" for a folder with changes
   * (a merge conflict) somewhere below. */
  kind: GitDecorationKind;
  /** One character for the badge (colour alone is not a signal). */
  letter: string;
  label: string;
}

const BY_CODE: Record<GitFileStatusCode, GitDecoration> = {
  M: { kind: "modified", letter: "M", label: "Modified" },
  A: { kind: "added", letter: "A", label: "Added" },
  "?": { kind: "untracked", letter: "U", label: "Untracked" },
  D: { kind: "deleted", letter: "D", label: "Deleted" },
  U: { kind: "conflict", letter: "!", label: "Merge conflict" },
};
const DIR_WITH_CHANGES: GitDecoration = {
  kind: "dir",
  letter: "•",
  label: "Contains changes",
};
const DIR_WITH_CONFLICT: GitDecoration = {
  kind: "dir-conflict",
  letter: "!",
  label: "Contains a merge conflict",
};

/** A lookup from the working-tree status of a repo (the same list the Git panel
 * shows) to what a file tree row should wear: the file's own status, and for a
 * folder a marker that something under it changed — so a collapsed folder still
 * says where the work is. Paths are relative to the tree root, which is the
 * repository root for a project (or a worktree). A conflict below a folder
 * outranks plain changes. */
export function buildGitDecorations(
  files: readonly GitFileStatus[] | null | undefined,
): (path: string, isDir: boolean) => GitDecoration | null {
  const own = new Map<string, GitDecoration>();
  const dirs = new Map<string, GitDecoration>();
  for (const file of files ?? []) {
    const deco = BY_CODE[file.status];
    if (!deco) continue;
    own.set(file.path, deco);
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (file.status === "U") dirs.set(dir, DIR_WITH_CONFLICT);
      else if (!dirs.has(dir)) dirs.set(dir, DIR_WITH_CHANGES);
    }
  }
  return (path, isDir) => (isDir ? (dirs.get(path) ?? null) : (own.get(path) ?? null));
}
