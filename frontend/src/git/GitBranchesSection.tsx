import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import type { GitBranchInfo } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { PHASE_LABEL, phaseTone } from "../github/prPhase.js";

/** Local branches with ahead/behind, last commit age, merged tag and PR phase chip. */
export function GitBranchesSection({ projectId }: { projectId: number }) {
  const storeBranches = useDashboardStore((s) => s.gitBranchesByProject[projectId]?.branches);
  // The store's batch refresh omits the per-branch `isMerged` enrichment (it
  // costs extra git spawns); fetch the detailed list once when this section
  // is opened, falling back to the store's while that loads or if it fails.
  // Stored with the project it was fetched for: this view doesn't remount on a
  // project switch, so another project's list must never be shown.
  const [detailed, setDetailed] = useState<{ projectId: number; branches: GitBranchInfo[] } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    api
      .getProjectGitBranches(projectId, true)
      .then((r) => !cancelled && setDetailed(r ? { projectId, branches: r.branches } : null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const branches = detailed?.projectId === projectId ? detailed.branches : storeBranches;
  const prs = useDashboardStore((s) => s.prsByProject[projectId]);
  if (!branches) return <div className="github-panel-empty-row">No branch data</div>;
  const prByBranch = new Map((prs?.prs ?? []).map((p) => [p.headBranch, p]));
  return (
    <div>
      {branches.map((b) => {
        const pr = prByBranch.get(b.name);
        return (
          <div key={b.name} className="github-panel-row">
            <span className="github-panel-row-title" title={b.upstream ?? undefined}>
              {b.isCurrent ? "● " : ""}
              {b.name}
            </span>
            {(b.ahead ?? 0) > 0 && <span className="gh-add">↑{b.ahead}</span>}
            {(b.behind ?? 0) > 0 && <span className="gh-del">↓{b.behind}</span>}
            {b.isMerged && <span className="gh-task-chip">merged</span>}
            {pr && (
              <span
                className={`gh-phase-pill ${pr.prPhase ? phaseTone(pr.prPhase) : "dim"}`}
                title={pr.prPhase ? PHASE_LABEL[pr.prPhase] : undefined}
              >
                #{pr.number}
              </span>
            )}
            {b.lastCommitRelative && (
              <span className="github-panel-row-number">{b.lastCommitRelative}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
