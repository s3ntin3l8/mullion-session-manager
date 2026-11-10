import { useEffect, useRef } from "react";
import { parseDeepLinkTaskId } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// Where a notification's task opens (#2843: the board has no drawer any
// more). Desktop shows the Tasks board and the right sidebar's Tasks view
// opens in detail mode for that task. Phone and tablet (`compact`) have no
// usable right rail — phone renders none, and tablet floats it over the
// navigator drawer the board lives in — so they open the full-screen docked
// TaskDetail panel through requestOpenTask, resolved by useOpenTaskRequest
// once the workspace has restored (a cold `/?task=<id>` start included).
function openTask(taskId: number, compact: boolean): void {
  const state = useDashboardStore.getState();
  if (compact) {
    state.requestOpenTask(taskId);
    return;
  }
  state.setViewMode("kanban");
  state.openRightSidebarTask(taskId);
}

// #2149 — a task push notification (a held workflow approval) opens that
// task. push-sw.js posts `mullion-open-task` to a live window, or opens
// `/?task=<id>` when none is open; both end up in openTask above. Needs no
// dockview/workspace gate of its own: it only touches the store.
export function useTaskNotificationOpen(compact: boolean): void {
  // Read at call time so a tier change never re-runs the URL parse below.
  const compactRef = useRef(compact);
  useEffect(() => {
    compactRef.current = compact;
  }, [compact]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const taskId = parseDeepLinkTaskId(url.search);
    if (taskId !== null) {
      // Cleared whether or not it parses to a live task, like ?session=.
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      openTask(taskId, compactRef.current);
    } else if (url.searchParams.has("task")) {
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "mullion-open-task") return;
      const id = Number(event.data.taskId);
      if (Number.isSafeInteger(id) && id > 0) openTask(id, compactRef.current);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
