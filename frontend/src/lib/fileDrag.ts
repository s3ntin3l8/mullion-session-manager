// The drag payload for a file or folder dragged out of a project file tree.
// One payload, three outcomes decided by the drop target: onto another folder
// of a tree it moves, onto a terminal it inserts a path, anywhere else nothing.

export const FILE_DRAG_MIME = "application/x-mullion-file";

export interface FileDragPayload {
  projectId: number;
  /** The session whose checkout the tree is rooted at; null = the project's own. */
  sessionId: number | null;
  /** Path relative to the tree root. */
  path: string;
  kind: "file" | "dir";
  /** Absolute path of the tree root (the checkout), for an absolute reference. */
  rootCwd: string;
}

// `dataTransfer.getData` is empty during dragover (browsers hide it until the
// drop), so a tree deciding whether a hover is a legal move reads the drag in
// flight from here instead. Same window only — which is all a tree move needs.
let active: FileDragPayload | null = null;
export const activeFileDrag = (): FileDragPayload | null => active;

// Set on <body> while a row is being dragged. The right sidebar floats over
// the grid under a click-away scrim; that scrim would swallow the drop on a
// terminal beneath it, so CSS lets the pointer through it for the duration.
export const FILE_DRAGGING_CLASS = "file-dragging";
let stopWatching: (() => void) | null = null;

export function startFileDrag(dt: DataTransfer, payload: FileDragPayload): void {
  active = payload;
  document.body.classList.add(FILE_DRAGGING_CLASS);
  // dragend is not guaranteed (a source row re-rendered away mid-drag never
  // fires it), and a stuck class would leave the click-away scrim dead: so any
  // drop/dragend anywhere, or the next press, also ends it.
  stopWatching?.();
  const end = () => endFileDrag();
  const events = ["dragend", "drop", "pointerdown"] as const;
  for (const e of events) window.addEventListener(e, end, true);
  stopWatching = () => {
    for (const e of events) window.removeEventListener(e, end, true);
  };
  dt.effectAllowed = "copyMove";
  dt.setData(FILE_DRAG_MIME, JSON.stringify(payload));
  // Other drop targets (another app, a text field) get the plain path.
  dt.setData("text/plain", payload.path);
}

export function endFileDrag(): void {
  active = null;
  document.body.classList.remove(FILE_DRAGGING_CLASS);
  stopWatching?.();
  stopWatching = null;
}

export function hasFileDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(FILE_DRAG_MIME);
}

export function readFileDrag(dt: DataTransfer): FileDragPayload | null {
  try {
    const parsed = JSON.parse(dt.getData(FILE_DRAG_MIME)) as Partial<FileDragPayload>;
    if (
      typeof parsed.projectId === "number" &&
      typeof parsed.path === "string" &&
      (parsed.kind === "file" || parsed.kind === "dir") &&
      typeof parsed.rootCwd === "string" &&
      (parsed.sessionId === null || typeof parsed.sessionId === "number")
    ) {
      return parsed as FileDragPayload;
    }
  } catch {
    // not ours / malformed
  }
  return null;
}
