import type { DashboardState, SidebarBack, SidebarHistoryEntry } from "./types.js";

export function sameSidebarTarget(a: SidebarBack, b: SidebarBack): boolean {
  if (a.kind === "task") return b.kind === "task" && a.taskId === b.taskId;
  return (
    b.kind === a.kind && "projectId" in b && a.projectId === b.projectId && a.number === b.number
  );
}

const SIDEBAR_HISTORY_CAP = 20;

// Where the right sidebar is showing a detail right now (a task, a PR or an
// issue), or null on a list / another view. A navigation that does not name its
// own origin records this one, so Back returns to it.
export function currentSidebarLocation(s: DashboardState): SidebarBack | null {
  if (!s.rightSidebarOpen) return null;
  if (s.rightSidebarView === "tasks") {
    return s.selectedTaskId !== null ? { kind: "task", taskId: s.selectedTaskId } : null;
  }
  if (s.rightSidebarView !== "github") return null;
  // The drill-in maps are keyed per project and shared with dock-panel GitHub hosts, but the
  // sidebar shows one project: the one it follows (every project when none is published yet).
  const shown = (id: string) => s.followedProjectId === null || Number(id) === s.followedProjectId;
  for (const [id, number] of Object.entries(s.githubOpenPrByProject)) {
    if (number != null && shown(id)) return { kind: "pr", projectId: Number(id), number };
  }
  for (const [id, number] of Object.entries(s.githubOpenIssueByProject)) {
    if (number != null && shown(id)) return { kind: "issue", projectId: Number(id), number };
  }
  return null;
}

// (A Back passes `null` and skips this: it is popping, not navigating onward.)
// Drop trailing entries that were not recorded for the detail being left: an entry says how to
// go Back from its `to`, so when the sidebar is showing something else (a panel list → detail
// click, a dock-panel navigation) the entry is stale and must not reroute a later Back.
export function pruneSidebarHistory(
  history: SidebarHistoryEntry[],
  current: SidebarBack | null,
): SidebarHistoryEntry[] {
  let end = history.length;
  while (end > 0 && !(current && sameSidebarTarget(history[end - 1].to, current))) end -= 1;
  return end === history.length ? history : history.slice(0, end);
}

export function pushSidebarHistory(
  history: SidebarHistoryEntry[],
  to: SidebarBack,
  back: SidebarBack | null,
): SidebarHistoryEntry[] {
  if (!back || sameSidebarTarget(back, to)) return history;
  return [...history, { to, back }].slice(-SIDEBAR_HISTORY_CAP);
}
