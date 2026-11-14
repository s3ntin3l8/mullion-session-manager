import { useEffect } from "react";
import { parseDeepLinkTaskId } from "../panelUtils.js";
import { useDashboardStore } from "../store/index.js";

// Where a notification's task opens (#2843: the board has no drawer any
// more). Tasks mode shows the board and the right sidebar's Tasks view opens
// in detail mode for that task (#3011: one task detail surface). The phone
// does the same (#3014): it shows that view full screen over the board, so a
// notification and a board card open the same detail.
function openTask(taskId: number): void {
  const state = useDashboardStore.getState();
  state.setViewMode("kanban");
  state.openRightSidebarTask(taskId);
}

// #2149 — a task push notification (a held workflow approval) opens that
// task. push-sw.js posts `mullion-open-task` to a live window, or opens
// `/?task=<id>` when none is open; both end up in openTask above. Needs no
// dockview/workspace gate of its own: it only touches the store.
export function useTaskNotificationOpen(): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const taskId = parseDeepLinkTaskId(url.search);
    if (taskId !== null) {
      // Cleared whether or not it parses to a live task, like ?session=.
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
      openTask(taskId);
    } else if (url.searchParams.has("task")) {
      url.searchParams.delete("task");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "mullion-open-task") return;
      const id = Number(event.data.taskId);
      if (Number.isSafeInteger(id) && id > 0) openTask(id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
