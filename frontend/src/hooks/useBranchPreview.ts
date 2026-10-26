import { useCallback, useState } from "react";
import { api, ApiError } from "../api/index.js";
import type { Preview } from "../api/index.js";
import { describeError } from "../lib/describeError.js";
import { useDashboardStore } from "../store/index.js";

/*
 * "Preview this branch / PR" (issues #2016/#2018), shared by the branch row,
 * branch detail, PR row and PR detail.
 *
 * An existing checkout preview (the links index's `entry.preview`, no
 * `upstreamPort`) just opens, and so does the current branch with a
 * configured dev server — the checkout already serves it. Anything else asks
 * the backend for the branch preview: that call is idempotent and returns a
 * live one unchanged, but also restarts one whose dock session has died, so
 * it is made even when the links index already knows the preview. A PR
 * always goes through its own route, which also refuses a fork's head.
 * Every path lands in the dock's browser pane through the store intent, so a
 * standalone GitHub panel works the same as the sidebar.
 */

export type PreviewTarget =
  | { kind: "branch"; branch: string; isCurrent?: boolean }
  | { kind: "pr"; number: number; branch: string };

const REFUSALS: Record<string, string> = {
  no_preview_control:
    "No dock control serves branch previews — mark one in Dock config (it must listen on $PORT)",
  remote_unsupported: "Branch previews aren't available yet for a project on a remote host",
  fork_unsupported: "Previewing a pull request from a fork isn't supported yet",
  unknown_branch: "That branch isn't here or on origin",
  worktree_busy: "Another session is already running in this branch's preview worktree",
};

export function previewErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && REFUSALS[err.code]) return REFUSALS[err.code];
    if (err.statusCode === 404 && !err.code) {
      return "Previews are not enabled on this server (PREVIEW_BASE_HOST)";
    }
  }
  return describeError(err, "Could not start the preview");
}

export function targetKey(target: PreviewTarget): string {
  return target.kind === "pr" ? `pr:${target.number}` : `branch:${target.branch}`;
}

export function useBranchPreview(projectId: number) {
  // Keys of the previews being started, so a row can disable its button.
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const hasDevServer = useDashboardStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.devServerUrl,
  );

  const open = useCallback(
    async (target: PreviewTarget, existing: Preview | null | undefined) => {
      const { requestOpenPreview, refreshPreviews, reportError } = useDashboardStore.getState();
      if (target.kind === "branch" && existing && existing.upstreamPort == null) {
        requestOpenPreview({ projectId, slug: existing.slug, branch: target.branch });
        return;
      }
      const key = targetKey(target);
      setStarting((prev) => new Set(prev).add(key));
      try {
        const preview =
          target.kind === "pr"
            ? await api.createPrPreview(projectId, target.number)
            : target.isCurrent && hasDevServer
              ? await api.createProjectPreview(projectId)
              : await api.createBranchPreview(projectId, target.branch);
        void refreshPreviews(true);
        requestOpenPreview({ projectId, slug: preview.slug, branch: target.branch });
      } catch (err) {
        reportError(
          `Could not preview ${target.kind === "pr" ? `#${target.number}` : target.branch}`,
          previewErrorMessage(err),
        );
      } finally {
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [projectId, hasDevServer],
  );

  return { open, starting };
}
