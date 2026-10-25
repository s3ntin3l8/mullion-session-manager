import type { FileDragPayload } from "./fileDrag.js";

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export type MoveCheck = { ok: true; to: string } | { ok: false; reason: string };

/** Whether dragging `drag` onto folder `targetDir` ("" = the tree root) of the
 * tree rooted at (`projectId`, `sessionId`) is a legal move, and where it ends
 * up. Only moves within ONE checkout: a drag from another project's or another
 * worktree's tree is refused (that would be a copy between repositories). */
export function checkMove(
  drag: Pick<FileDragPayload, "projectId" | "sessionId" | "path">,
  tree: { projectId: number; sessionId: number | null },
  targetDir: string,
): MoveCheck {
  if (drag.projectId !== tree.projectId || drag.sessionId !== tree.sessionId) {
    return { ok: false, reason: "That file belongs to a different checkout" };
  }
  if (drag.path === "") return { ok: false, reason: "The project root can't be moved" };
  if (targetDir === drag.path || targetDir.startsWith(`${drag.path}/`)) {
    return { ok: false, reason: "A folder can't be moved into itself" };
  }
  if (parentOf(drag.path) === targetDir) {
    return { ok: false, reason: "It is already in that folder" };
  }
  return { ok: true, to: joinRel(targetDir, baseName(drag.path)) };
}
