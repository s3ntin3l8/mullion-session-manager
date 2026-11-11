import type { MouseEvent } from "react";
import type { Task } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { taskRepoSlug } from "../taskStatusModel.js";

/** A plain left click: modifier keys and other buttons keep the link's real href (a new tab). */
export function isPlainClick(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * The Mullion project that tracks `repo` (an `owner/name` slug), or null when none is known.
 * A project has no repo field of its own, so the repo is matched through the tasks loaded for
 * it (each task's issue URL names its repo). `fallback` is the asking task: when its own repo
 * is the one asked about, its project is the answer even before any other task is loaded.
 */
export function projectIdForRepo(
  tasks: readonly Task[],
  repo: string,
  fallback?: Pick<Task, "projectId" | "htmlUrl">,
): number | null {
  if (fallback && taskRepoSlug(fallback) === repo) return fallback.projectId;
  return tasks.find((t) => taskRepoSlug(t) === repo)?.projectId ?? null;
}

/** The project an epic issue opens in, for a task whose parent it is; null → stay external. */
export function epicProjectId(tasks: readonly Task[], task: Task): number | null {
  if (task.parentIssueRepo === null || task.parentIssueNumber === null) return null;
  return projectIdForRepo(tasks, task.parentIssueRepo, task);
}

/** Open the task's epic issue in the right sidebar's GitHub tab, when its project is known. */
export function openEpicInSidebar(tasks: readonly Task[], task: Task): boolean {
  const projectId = epicProjectId(tasks, task);
  if (projectId === null || task.parentIssueNumber === null) return false;
  useDashboardStore.getState().openRightSidebarIssue(projectId, task.parentIssueNumber);
  return true;
}
