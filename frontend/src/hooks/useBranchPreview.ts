import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/index.js";
import type { Preview } from "../api/index.js";
import { describeError } from "../lib/describeError.js";
import { useDashboardStore } from "../store/index.js";

/*
 * "Preview this branch / PR" (issues #2016/#2018), shared by the branch row,
 * branch detail, PR row and PR detail.
 *
 * An existing checkout preview (the links index's `entry.preview`, no
 * `upstreamPort`) just opens while the project has a dev server to serve it —
 * a PR whose head is the checked-out branch included — and so does the
 * current branch with a configured dev server. Without one, a checkout row
 * would only proxy to a 503, so a branch preview is started. Anything else asks
 * the backend for the branch preview: that call is idempotent and returns a
 * live one unchanged, but also restarts one whose dock session has died, so
 * it is made even when the links index already knows the preview. A PR's
 * start always goes through its own route, which also refuses a fork's head.
 * Every path lands in the dock's browser pane through the store intent, so the
 * GitHub view works the same wherever it is shown.
 */

export type BranchPreviewTarget =
  | { kind: "branch"; branch: string; isCurrent?: boolean }
  | { kind: "pr"; number: number; branch: string };

const REFUSALS: Record<string, string> = {
  no_preview_control:
    "No dock control serves branch previews — mark one in Dock config (it must listen on $PORT)",
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

// #3588 — how often a start in flight asks whether it is installing.
const INSTALL_POLL_MS = 1500;
export { INSTALLING_LABEL } from "../lib/setupHint.js";

export function targetKey(target: BranchPreviewTarget): string {
  return target.kind === "pr" ? `pr:${target.number}` : `branch:${target.branch}`;
}

export function useBranchPreview(projectId: number) {
  // Keys of the previews being started, so a row can disable its button.
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // #3588 — the starts whose dev server is waiting for the project's setup
  // recipe on the server ("Installing dependencies…"), polled only while a
  // start is in flight.
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const pollsRef = useRef(new Set<ReturnType<typeof setInterval>>());
  useEffect(() => {
    const polls = pollsRef.current;
    return () => {
      for (const timer of polls) clearInterval(timer);
      polls.clear();
    };
  }, []);
  const hasDevServer = useDashboardStore(
    (s) => !!s.projects.find((p) => p.id === projectId)?.devServerUrl,
  );

  const open = useCallback(
    async (target: BranchPreviewTarget, existing: Preview | null | undefined) => {
      const { requestOpenPreview, refreshPreviews, reportError } = useDashboardStore.getState();
      if (existing && existing.upstreamPort == null && hasDevServer) {
        requestOpenPreview({ projectId, slug: existing.slug, branch: target.branch });
        return;
      }
      const key = targetKey(target);
      setStarting((prev) => new Set(prev).add(key));
      const mark = (on: boolean) =>
        setInstalling((prev) => {
          if (prev.has(key) === on) return prev;
          const next = new Set(prev);
          if (on) next.add(key);
          else next.delete(key);
          return next;
        });
      let done = false;
      const poll = setInterval(() => {
        api
          .listDockSetups(projectId)
          // A poll answering after the start returned must not turn it back on.
          .then((runs) => !done && mark(runs.some((r) => r.branch === target.branch)))
          .catch(() => {
            // Only the label is lost; the start goes on.
          });
      }, INSTALL_POLL_MS);
      pollsRef.current.add(poll);
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
        done = true;
        clearInterval(poll);
        pollsRef.current.delete(poll);
        mark(false);
        setStarting((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [projectId, hasDevServer],
  );

  return { open, starting, installing };
}
