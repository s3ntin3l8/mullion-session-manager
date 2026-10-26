import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { DockviewApi } from "dockview-react";
import type { Task } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

export interface UseOpenTaskRequestParams {
  dockviewApi: DockviewApi | null;
  activeWorkspaceId: number | null;
  onOpenTask: (task: Task) => void;
  restoringRef: MutableRefObject<boolean>;
  restoredWorkspaceIdRef: MutableRefObject<number | null>;
}

// Issue #2020 — resolves store/slices/ui.ts's requestOpenTask "intent": a
// task chip in the right sidebar (a PR row, a branch's owning task) has no
// dockview API, so it asks the app shell to open the task's detail panel.
// The task twin of useOpenSessionRequest.ts, with the same gates, the same
// setTimeout(0) retry while a workspace restores, and the same rule that a
// request only counts as resolved once it has actually been acted on — see
// that hook's own comments for the argument. Like it, this must be called
// AFTER useWorkspacePersistence(...) in App.tsx's render body, with the SAME
// restoringRef/restoredWorkspaceIdRef objects.
//
// No tasksLoaded gate: nothing loads tasks on every layout, so waiting for
// it could hold a request forever. TaskDetail reads its task from the store
// by id, so a task the store does not hold yet (not loaded, or created since
// the last refresh) is fetched with refreshTasks() and looked up again; one
// that is still missing is dropped.
export function useOpenTaskRequest({
  dockviewApi,
  activeWorkspaceId,
  onOpenTask,
  restoringRef,
  restoredWorkspaceIdRef,
}: UseOpenTaskRequestParams): void {
  const openTaskRequest = useDashboardStore((s) => s.openTaskRequest);
  const resolvedNonceRef = useRef(0);
  const [retryTick, setRetryTick] = useState(0);
  // The refresh below outlives the effect run that started it: clearing the
  // request re-runs this effect at once, so a per-run cancel flag would drop
  // every fetched task. Only an unmount cancels it, and it opens through the
  // latest onOpenTask (which closes over the current dockview API).
  const unmountedRef = useRef(false);
  const onOpenTaskRef = useRef(onOpenTask);
  useEffect(() => {
    onOpenTaskRef.current = onOpenTask;
  }, [onOpenTask]);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!openTaskRequest || openTaskRequest.nonce === resolvedNonceRef.current) return;
    const workspaceRestored =
      activeWorkspaceId !== null && restoredWorkspaceIdRef.current === activeWorkspaceId;
    if (!dockviewApi || !workspaceRestored) return;
    if (restoringRef.current) {
      const timer = setTimeout(() => setRetryTick((t) => t + 1), 0);
      return () => clearTimeout(timer);
    }

    const { nonce, taskId } = openTaskRequest;
    const find = () => useDashboardStore.getState().tasks.find((t) => t.id === taskId);
    const timer = setTimeout(() => {
      resolvedNonceRef.current = nonce;
      useDashboardStore.getState().clearOpenTaskRequest(nonce);
      const task = find();
      if (task) {
        onOpenTask(task);
        return;
      }
      void useDashboardStore
        .getState()
        .refreshTasks()
        .then(() => {
          const fetched = find();
          if (fetched && !unmountedRef.current) onOpenTaskRef.current(fetched);
        });
    }, 0);
    return () => clearTimeout(timer);
  }, [
    openTaskRequest,
    dockviewApi,
    activeWorkspaceId,
    onOpenTask,
    retryTick,
    restoringRef,
    restoredWorkspaceIdRef,
  ]);
}
