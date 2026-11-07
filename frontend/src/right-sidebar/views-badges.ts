// The right sidebar's per-view badge hooks: what each rail button shows
// next to its icon, and whether the view is enabled at all.
//
// They live apart from views.ts (which holds the shared TYPES) and from the
// registry (views-registry.ts) because they need the dashboard store, and
// every view component imports the types from views.ts — a hook living in
// the same file would close the cycle again (issue #2414).

import { useDashboardStore } from "../store/index.js";
import { needsYouTasks } from "../github/taskMasterSummary.js";
import { ATTENTION_ORDER, PHASE_LABEL, attentionSummary } from "../github/prPhase.js";
import type { RailBadge } from "./views.js";

export function useNoBadge(): RailBadge | null {
  return null;
}

export function useAlwaysEnabled(): boolean {
  return true;
}

export function useTaskMasterEnabled(): boolean {
  return useDashboardStore((s) => s.taskMasterEnabled);
}

// Tasks that want a human (failed, awaiting approval, a merge/release error)
// for the followed project. Archived tasks never count.
export function useTasksBadge(projectId: number | null): RailBadge | null {
  const tasks = useDashboardStore((s) => s.tasks);
  if (projectId == null) return null;
  const n = needsYouTasks(tasks.filter((t) => t.projectId === projectId)).length;
  if (n === 0) return null;
  return {
    kind: "count",
    value: n,
    title: `${n} task${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} you`,
  };
}

export function useGitBadge(projectId: number | null): RailBadge | null {
  const status = useDashboardStore((s) => (projectId != null ? s.gitStatuses[projectId] : null));
  if (!status) return null;
  if (status.hasConflicts) return { kind: "alert", title: "Unresolved merge conflicts" };
  if (status.files.length > 0) {
    return {
      kind: "count",
      value: status.files.length,
      title: `${status.files.length} changed file${status.files.length === 1 ? "" : "s"}`,
    };
  }
  return null;
}

// PRs that want the user (failing CI, requested changes, conflicts, unresolved
// conversations, a head behind its base — by phase, not just red CI) and a red default branch both
// come straight from the live store (prsByProject from the /ws/github push,
// defaultBranchCiByProject from the poller via the same refreshGitRefs
// batch), so the badge costs no extra requests.
export function useGitHubBadge(projectId: number | null): RailBadge | null {
  const prs = useDashboardStore((s) =>
    projectId != null ? s.prsByProject[projectId]?.prs : undefined,
  );
  const defaultBranchFailing = useDashboardStore((s) =>
    projectId != null ? s.defaultBranchCiByProject[projectId] === "failure" : false,
  );
  const { total, byPhase } = attentionSummary(prs ?? []);
  if (total === 0 && !defaultBranchFailing) return null;
  const reasons: string[] = [];
  for (const phase of ATTENTION_ORDER) {
    const n = byPhase[phase];
    if (n) reasons.push(`${n} PR${n === 1 ? "" : "s"}: ${PHASE_LABEL[phase].toLowerCase()}`);
  }
  if (defaultBranchFailing) reasons.push("default branch CI failing");
  return { kind: "alert", title: reasons.join(", ") };
}
