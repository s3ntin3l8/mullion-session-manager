const DOCK_PREVIEW_MARK = "/.mullion-worktrees/dock-preview-";
const DEV_WORKTREE_MARK = "/.wt/";

/** A worktree a developer made by hand under `.wt/` (not a Mullion product worktree). */
export const isDevWorktree = (path: string) => path.includes(DEV_WORKTREE_MARK);
/** A throwaway worktree a dock preview owns. */
export const isDockPreviewWorktree = (path: string) => path.includes(DOCK_PREVIEW_MARK);
