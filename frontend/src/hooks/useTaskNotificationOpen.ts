import { useEffect } from "react";
import { parseDeepLinkTaskId } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

function openTaskDrawer(taskId: number): void {
  const state = useDashboardStore.getState();
  // The pending id is consumed by UnifiedBoard when it mounts; showing the
  // Tasks view is what mounts it (the desktop overlay, or the phone/tablet
  // navigator via usePhoneTasksNavigator).
  state.setPendingOpenTaskId(taskId);
  state.setViewMode("kanban");
}

// #2149 — a task push notification (a held workflow approval) opens that
// task's drawer. push-sw.js posts `mullion-open-task` to a live window, or
// opens `/?task=<id>` when none is open; both end up as a pending id plus the
// Tasks view. Needs no dockview/workspace gate: it only touches the store.
export function useTaskNotificationOpen(): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const taskId = parseDeepLinkTaskId(url.search);
    if (taskId !== null) {
      // Cleared whether or not it parses to a live task, like ?session=.
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      openTaskDrawer(taskId);
    } else if (url.searchParams.has("task")) {
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "mullion-open-task") return;
      const id = Number(event.data.taskId);
      if (Number.isSafeInteger(id) && id > 0) openTaskDrawer(id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
