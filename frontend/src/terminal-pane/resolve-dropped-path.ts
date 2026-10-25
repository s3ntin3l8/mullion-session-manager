import type { FileDragPayload } from "../lib/fileDrag.js";
import { isWithin, joinAbs, relativeAbs } from "../lib/posixPath.js";
import { sessionCheckoutRoot } from "../lib/sessionCheckout.js";

/** What to type into a terminal for a file dragged out of a file tree.
 *
 *  - Same project: the path relative to the terminal's own directory, and the
 *    same file in ITS checkout — a worktree session gets its worktree's copy,
 *    not the main checkout's, whichever tree the file was dragged from.
 *  - Another project (or a session with no project): the absolute path.
 *
 * `target.cwd` is the session's directory (null = it inherits the project's);
 * `target.projectCwd` the project's. Falls back to the absolute path when no
 * sensible relative one exists (the terminal's directory is outside the
 * checkout the file is in). */
export function resolveDroppedPath(
  payload: Pick<FileDragPayload, "projectId" | "path" | "rootCwd">,
  target: { projectId: number | null; cwd: string | null; projectCwd: string | null },
): string {
  const absolute = joinAbs(payload.rootCwd, payload.path);
  if (target.projectId !== payload.projectId || target.projectCwd === null) return absolute;
  const termCwd = target.cwd ?? target.projectCwd;
  // The checkout the terminal sits in: its own worktree, or the project's.
  const checkout =
    sessionCheckoutRoot({ cwd: termCwd }, { cwd: target.projectCwd }) ?? target.projectCwd;
  const sameFile = joinAbs(checkout, payload.path);
  if (!isWithin(checkout, termCwd)) return sameFile;
  const rel = relativeAbs(termCwd, sameFile);
  return rel === "" ? "." : rel;
}
