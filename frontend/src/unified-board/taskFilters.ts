import type { Task } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import { needsYouReason, taskBucket } from "../github/taskMasterSummary.js";
import { isAwaitingMerge } from "./awaitingMerge.js";

// The Task Master board's filter model (epic #2847, #2840). One object, three
// views of it: the filter bar, the optional facets panel and the phone sheet all
// read and write the same `TaskFilters`, so they can never disagree.
//
// Reorder safety (#610): everything here is a render-time filter over the
// store's full `tasks` list. UnifiedBoard still routes every drop through
// `absoluteDropIndex` (tasksBoard.ts), which translates an index in the
// filtered column back to the full one before `computeTaskReorder` runs. A new
// filter dimension therefore needs no reorder handling of its own, as long as
// it only ever narrows `visibleTasks` and never rewrites `tasks`.

export type QuickView = "all" | "needs-me" | "running" | "blocked" | "awaiting-merge";

export const QUICK_VIEWS: ReadonlyArray<{ id: QuickView; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-me", label: "Needs me" },
  { id: "running", label: "Running" },
  { id: "blocked", label: "Blocked" },
  { id: "awaiting-merge", label: "Awaiting merge" },
];

export function isQuickView(value: unknown): value is QuickView {
  return QUICK_VIEWS.some((v) => v.id === value);
}

/** "No epic" in the epic filter. Never a valid `repo#number` key (those always
 * contain a "#" after a repo slug), so it can share the key list with real epics. */
export const NO_EPIC = "__none__";

/** The facets panel: always shown, never shown, or shown on a wide window / many projects. */
export type FacetsSetting = "off" | "on" | "auto";

export function isFacetsSetting(value: unknown): value is FacetsSetting {
  return value === "off" || value === "on" || value === "auto";
}

/** Auto opens the panel from this viewport width... */
export const FACETS_AUTO_MIN_WIDTH = 1440;
/** ...or once there are more projects than this. */
export const FACETS_AUTO_MIN_PROJECTS = 8;

export function facetsOpen(setting: FacetsSetting, viewportWidth: number, projectCount: number) {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return viewportWidth >= FACETS_AUTO_MIN_WIDTH || projectCount > FACETS_AUTO_MIN_PROJECTS;
}

export interface TaskFilters {
  projectIds: number[];
  view: QuickView;
  /** `repo#number` keys of parent issues, plus NO_EPIC. Empty = every epic. */
  epicKeys: string[];
  /** Agent labels (see `agentLabel`). Empty = every agent. */
  agents: string[];
  text: string;
  showArchived: boolean;
}

export const NO_FILTERS: TaskFilters = {
  projectIds: [],
  view: "all",
  epicKeys: [],
  agents: [],
  text: "",
  showArchived: false,
};

export function epicKeyOf(task: Task): string | null {
  return task.parentIssueNumber !== null && task.parentIssueRepo !== null
    ? `${task.parentIssueRepo}#${task.parentIssueNumber}`
    : null;
}

/** What the card shows as the agent, else "auto" (no agent chosen yet). */
export function agentLabel(task: Task): string {
  if (task.agentCommand) return commandToBinary(task.agentCommand);
  return task.agent ?? "auto";
}

export function matchesQuickView(task: Task, view: QuickView): boolean {
  switch (view) {
    case "all":
      return true;
    case "needs-me":
      return needsYouReason(task) !== null;
    case "running":
      return taskBucket(task) === "running";
    case "blocked":
      return task.blockedState === "blocked";
    case "awaiting-merge":
      return isAwaitingMerge(task);
  }
}

/** Title, issue number and PR number. A leading "#" and surrounding space are ignored,
 * so "#123" finds issue or PR 123 (and any title containing "#123"). */
export function matchesText(task: Task, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  if (task.title.toLowerCase().includes(needle)) return true;
  const digits = needle.replace(/^#/, "");
  if (/^\d+$/.test(digits)) {
    const n = Number(digits);
    return task.issueNumber === n || task.prNumber === n;
  }
  return false;
}

/** Every filter except the quick view: the set the quick-view counts are taken over. */
export function scopeTasks(tasks: Task[], f: TaskFilters): Task[] {
  const epics = f.epicKeys.length > 0 ? new Set(f.epicKeys) : null;
  const agents = f.agents.length > 0 ? new Set(f.agents) : null;
  const projects = f.projectIds.length > 0 ? new Set(f.projectIds) : null;
  return tasks.filter((t) => {
    if (!f.showArchived && t.archivedAt !== null) return false;
    if (projects && !projects.has(t.projectId)) return false;
    if (epics && !epics.has(epicKeyOf(t) ?? NO_EPIC)) return false;
    if (agents && !agents.has(agentLabel(t))) return false;
    return matchesText(t, f.text);
  });
}

export function quickViewCounts(scoped: Task[]): Record<QuickView, number> {
  const counts: Record<QuickView, number> = {
    all: scoped.length,
    "needs-me": 0,
    running: 0,
    blocked: 0,
    "awaiting-merge": 0,
  };
  for (const t of scoped) {
    for (const v of QUICK_VIEWS) {
      if (v.id !== "all" && matchesQuickView(t, v.id)) counts[v.id] += 1;
    }
  }
  return counts;
}

export interface EpicOption {
  key: string;
  /** "#N title", or "#N" until the title loads. */
  label: string;
  count: number;
  /** Sub-issue progress, when the parent reports it. */
  done: number | null;
  total: number | null;
}

/** One option per parent issue present on the board, sorted by label. */
export function epicOptions(tasks: Task[]): EpicOption[] {
  const byKey = new Map<string, EpicOption>();
  const hasTitle = new Set<string>();
  for (const t of tasks) {
    const key = epicKeyOf(t);
    if (key === null) continue;
    const label = t.parentIssueTitle
      ? `#${t.parentIssueNumber} ${t.parentIssueTitle}`
      : `#${t.parentIssueNumber}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        label,
        count: 1,
        done: t.subIssueTotal !== null ? t.subIssueCompleted : null,
        total: t.subIssueTotal,
      });
      if (t.parentIssueTitle) hasTitle.add(key);
      continue;
    }
    existing.count += 1;
    // The parent title lands after the row itself is ingested
    // (task-watcher's fillParentIssueTitles): upgrade an option that has only
    // the "#N" placeholder rather than waiting for a fresh one.
    if (!hasTitle.has(key) && t.parentIssueTitle) {
      existing.label = label;
      hasTitle.add(key);
    }
    if (existing.total === null && t.subIssueTotal !== null) {
      existing.total = t.subIssueTotal;
      existing.done = t.subIssueCompleted;
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function noEpicCount(tasks: Task[]): number {
  return tasks.filter((t) => epicKeyOf(t) === null).length;
}

export function agentOptions(tasks: Task[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(agentLabel(t), (counts.get(agentLabel(t)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/** How many filter dimensions are active, for the phone Filter button's badge. */
export function activeFilterCount(f: TaskFilters, hideDone: boolean): number {
  return (
    (f.projectIds.length > 0 ? 1 : 0) +
    (f.view !== "all" ? 1 : 0) +
    (f.epicKeys.length > 0 ? 1 : 0) +
    (f.agents.length > 0 ? 1 : 0) +
    (f.text.trim() !== "" ? 1 : 0) +
    (f.showArchived ? 1 : 0) +
    (hideDone ? 1 : 0)
  );
}
