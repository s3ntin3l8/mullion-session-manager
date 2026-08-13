import { useState } from "react";
import { api } from "../api/index.js";
import { useAsyncData } from "./useAsyncData.js";

// CommandPalette.tsx's worktree base-ref picker and PromoteDialog.tsx's own
// base-ref picker independently fetch + shape the exact same
// `GET /api/projects/:id/git-branches` response: local branch names +
// remote-tracking branch names concatenated into one list, plus whichever
// local branch is current. Verified NOT byte-identical, though — two real
// differences preserved here via options rather than silently dropped:
//  - CommandPalette only fetches once its worktree toggle is switched on
//    (`enabled` below); PromoteDialog fetches unconditionally on mount.
//  - CommandPalette surfaces a user-visible error message on failure;
//    PromoteDialog's pre-extraction effect had no `.catch` at all (an
//    unhandled rejection). This hook always tracks `error` internally
//    (harmless — PromoteDialog just doesn't read it), which as a side
//    effect quietly fixes that unhandled rejection rather than
//    reproducing it; worth calling out since it's a real, if trivial,
//    behavior change from what PromoteDialog had before.
//
// Built on useAsyncData rather than duplicating its cancelled-guard/ref
// machinery.
export interface UseGitBranchesResult {
  /** Local branch names followed by remote-tracking branch names (e.g.
   * "origin/main") — the flat list both pickers render. `[]` while
   * loading, not yet enabled, or the 204 "not applicable" response. */
  branches: string[];
  /** The local branch git currently has checked out, or `null` (loading,
   * disabled, not applicable, or genuinely detached/unknown). */
  currentBranch: string | null;
  /** Set on a thrown/rejected fetch; `null` otherwise. Neither call site
   * needs to distinguish 204 from "still loading" from this hook's return
   * shape alone — both already treat an empty `branches` array as "nothing
   * to show yet" either way. */
  error: string | null;
}

export interface UseGitBranchesOptions {
  /** Whether to fetch at all — `false` short-circuits before the request
   * and leaves `branches`/`currentBranch` at their empty defaults.
   * Defaults to `true`. */
  enabled?: boolean;
  /** Called once per successful (non-204) load, with the same computed
   * `branches`/`currentBranch` this hook itself now holds — for a caller
   * that seeds its own base-ref selection off the result, same as both
   * pre-extraction call sites' `setBaseRef((prev) => prev || current ||
   * local[0] || "")` line. Takes the freshly computed values directly
   * (not this hook's own possibly-stale return value) to avoid a stale
   * closure. */
  onLoaded?: (result: { branches: string[]; currentBranch: string | null }) => void;
}

export function useGitBranches(
  projectId: number | null,
  options: UseGitBranchesOptions = {},
): UseGitBranchesResult {
  const { enabled = true, onLoaded } = options;

  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useAsyncData(
    () => {
      if (projectId === null) return Promise.resolve(undefined);
      return api.getProjectGitBranches(projectId);
    },
    (result) => {
      // 204 "not applicable" — same silent no-op both pre-extraction call
      // sites had (neither cleared `branches`/set an error for this case).
      if (!result) return;
      setError(null);
      const local = result.branches.map((b) => b.name);
      const combined = [...local, ...result.remoteBranches];
      const current = result.branches.find((b) => b.isCurrent)?.name ?? null;
      setBranches(combined);
      setCurrentBranch(current);
      onLoaded?.({ branches: combined, currentBranch: current });
    },
    (err: unknown) => {
      console.debug("[useGitBranches] getProjectGitBranches failed", err);
      setError(err instanceof Error ? err.message : "Failed to load branches — try again.");
    },
    [projectId],
    { enabled: enabled && projectId !== null },
  );

  return { branches, currentBranch, error };
}
