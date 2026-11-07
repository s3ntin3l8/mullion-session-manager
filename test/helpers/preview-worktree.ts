import {
  removeWorktree,
  trackPreviewWorktree,
  type PreviewWorktreeInfo,
} from "../../src/services/git-worktree.js";

/** `trackPreviewWorktree` for a local checkout. Production always passes the
 * host-routed `remove` (session-lifecycle's `previewRemover`); there is no
 * fallback any more, so a local test fixture removes through git directly. */
export function trackLocalPreviewWorktree(
  sessionId: number,
  info: Omit<PreviewWorktreeInfo, "remove">,
): PreviewWorktreeInfo {
  const tracked: PreviewWorktreeInfo = {
    ...info,
    remove: () => removeWorktree(info.worktreePath, info.parentCwd),
  };
  trackPreviewWorktree(sessionId, tracked);
  return tracked;
}
