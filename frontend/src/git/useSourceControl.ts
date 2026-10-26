import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/index.js";
import type { CloneHealth, GitBranchesResult, RepairOutcome, RepairPlan } from "../api/types.js";
import { describeError } from "../lib/describeError.js";
import { useDashboardStore } from "../store/index.js";

export type BranchDataState =
  | { kind: "loading" }
  /** Durably nothing to show: not a repo, or a host that answers 204. */
  | { kind: "none" }
  /** A request failure. On a remote project that is the host being unreachable. */
  | { kind: "error"; message: string }
  | { kind: "ready"; data: GitBranchesResult };

/**
 * Branches (with the merge-state enrichment) and worktrees for the Source
 * Control view. The store's 60s refs poll fills in until the detailed read
 * lands; a failed read is reported, never rendered as an empty list.
 */
export function useBranchData(projectId: number): BranchDataState & { reload: () => void } {
  const refreshTrigger = useDashboardStore((s) => s.gitRefreshTrigger);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ projectId: number; state: BranchDataState } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getProjectGitBranches(projectId, true)
      .then((r) => {
        if (!cancelled) {
          setResult({
            projectId,
            state: r ? { kind: "ready", data: r } : { kind: "none" },
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            projectId,
            state: { kind: "error", message: describeError(err, "Could not load branches.") },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshTrigger, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  // Another project's answer must never render here after a switch.
  const state: BranchDataState =
    result?.projectId === projectId ? result.state : { kind: "loading" };
  return { ...state, reload };
}

/** What a mutation needs to do afterwards: re-read refs everywhere. */
export function refreshGitEverywhere(projectId: number): void {
  void useDashboardStore.getState().refreshGitRefs([projectId]);
  useDashboardStore.getState().bumpGitRefreshTrigger();
}

export interface CloneHealthState {
  checking: boolean;
  health: CloneHealth | null;
  healthError: string | null;
  repairPlan: RepairPlan | null;
  repairOutcome: RepairOutcome | null;
  repairError: string | null;
  repairing: boolean;
  /** One line: what the repair WOULD do. */
  planText: string;
  /** One line: what the repair DID. */
  outcomeText: string;
  check: () => Promise<void>;
  repair: () => Promise<void>;
}

/**
 * The clone health check and the confirmed repair, ported from GitPanel
 * (#1851, #1896). The check is read-only; the plan is read on a damaged
 * result so the user sees what the repair would do BEFORE arming it.
 */
export function useCloneHealth(projectId: number, onRepaired: () => void): CloneHealthState {
  const checkProjectGitHealth = useDashboardStore((s) => s.checkProjectGitHealth);
  const planProjectGitRepair = useDashboardStore((s) => s.planProjectGitRepair);
  const repairProjectGitRepair = useDashboardStore((s) => s.repairProjectGitRepair);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<CloneHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [repairPlan, setRepairPlan] = useState<RepairPlan | null>(null);
  const [repairOutcome, setRepairOutcome] = useState<RepairOutcome | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);

  // A project switch drops the previous project's verdict.
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId);
    setHealth(null);
    setHealthError(null);
    setRepairPlan(null);
    setRepairOutcome(null);
    setRepairError(null);
  }

  const check = useCallback(async () => {
    setChecking(true);
    setHealth(null);
    setHealthError(null);
    setRepairPlan(null);
    setRepairOutcome(null);
    setRepairError(null);
    try {
      const result = await checkProjectGitHealth(projectId);
      setHealth(result);
      if (!result.healthy && result.gitDir !== null && !result.timedOut) {
        try {
          setRepairPlan(await planProjectGitRepair(projectId));
        } catch (err) {
          setRepairError(describeError(err, "the repair plan could not be computed"));
        }
      }
    } catch (err) {
      setHealthError(describeError(err, "the health check failed"));
    } finally {
      setChecking(false);
    }
  }, [projectId, checkProjectGitHealth, planProjectGitRepair]);

  const repair = useCallback(async () => {
    setRepairing(true);
    setRepairError(null);
    try {
      const outcome = await repairProjectGitRepair(projectId);
      setRepairOutcome(outcome);
      setRepairPlan(null);
      // The outcome replaces the pre-repair banner.
      setHealth(null);
      onRepaired();
    } catch (err) {
      setRepairError(describeError(err, "the repair failed"));
    } finally {
      setRepairing(false);
    }
  }, [projectId, repairProjectGitRepair, onRepaired]);

  const planText = useMemo(() => {
    if (!repairPlan) return "";
    const parts: string[] = [];
    parts.push(
      repairPlan.actionable
        ? `quarantine ${repairPlan.quarantine.length} damaged object(s)`
        : "quarantine nothing — there is no damaged object to move aside, so the fetch is what helps this clone",
    );
    if (repairPlan.willFetch) parts.push("fetch from origin");
    if (repairPlan.indexesToRebuild.length > 0) {
      parts.push(`rebuild ${repairPlan.indexesToRebuild.length} index(es)`);
    }
    if (repairPlan.indexesToSkip.length > 0) {
      parts.push(
        `leave ${repairPlan.indexesToSkip.length} index(es) alone (the staged content is not in the working tree)`,
      );
    }
    return parts.join(", ");
  }, [repairPlan]);

  const outcomeText = useMemo(() => {
    if (!repairOutcome) return "";
    const parts: string[] = [];
    if (repairOutcome.quarantined.length > 0) {
      parts.push(
        `${repairOutcome.quarantined.length} damaged object(s) moved into ${repairOutcome.quarantine}`,
      );
    }
    if (repairOutcome.refsRestored) parts.push("refs restored from origin");
    if (repairOutcome.indexesRebuilt.length > 0) {
      parts.push(`${repairOutcome.indexesRebuilt.length} index(es) rebuilt`);
    }
    if (repairOutcome.recovered.length > 0) {
      parts.push(`${repairOutcome.recovered.length} object(s) read fine again`);
    }
    if (repairOutcome.unrecovered.length > 0) {
      parts.push(
        `${repairOutcome.unrecovered.length} object(s) could not be recovered — restore them from the remote`,
      );
    }
    return parts.join("; ");
  }, [repairOutcome]);

  return {
    checking,
    health,
    healthError,
    repairPlan,
    repairOutcome,
    repairError,
    repairing,
    planText,
    outcomeText,
    check,
    repair,
  };
}

/** Clone-health dot for the header: unknown until a check has run. */
export function healthDot(h: CloneHealthState): "success" | "warn" | "danger" | undefined {
  if (h.healthError) return "warn";
  if (h.repairOutcome) return h.repairOutcome.whole ? "success" : "danger";
  if (!h.health) return undefined;
  if (h.health.healthy) return "success";
  if (h.health.gitDir === null || h.health.timedOut) return "warn";
  return "danger";
}
