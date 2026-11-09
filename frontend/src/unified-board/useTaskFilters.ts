import { useCallback, useEffect, useMemo, useState } from "react";
import type { Task } from "../api/index.js";
import {
  STORAGE_KEYS,
  readBool,
  readJSON,
  readString,
  removeItem,
  writeBool,
  writeJSON,
  writeString,
} from "../lib/persistedState.js";
import { isAwaitingMerge } from "./awaitingMerge.js";
import {
  NO_EPIC,
  agentOptions,
  epicOptions,
  isFacetsSetting,
  isQuickView,
  noEpicCount,
  quickViewCounts,
  scopeTasks,
  matchesQuickView,
} from "./taskFilters.js";
import type { FacetsSetting, QuickView, TaskFilters } from "./taskFilters.js";

const MAX_RECENT_PROJECTS = 5;

function stringArray(raw: unknown): string[] | null {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : null;
}

interface Initial {
  view: QuickView;
  epicKeys: string[];
  /** The legacy (pre-#2840) keys were the source of `view` or `epicKeys`. */
  migrated: boolean;
}

// The old board kept "Blocked only", "Awaiting merge" and the "Phase" select as
// three separate keys. They are now one quick view and the epic filter. Read the
// new keys first; fall back to the legacy ones only when a new key is unset, so a
// user with any saved filter sees the equivalent state after upgrading.
function readInitial(): Initial {
  const storedView = readString(STORAGE_KEYS.taskQuickView, "");
  let view: QuickView = isQuickView(storedView) ? storedView : "all";
  let migrated = false;
  if (!isQuickView(storedView)) {
    if (readBool(STORAGE_KEYS.taskAwaitingMergeOnly, false)) {
      view = "awaiting-merge";
      migrated = true;
    } else if (readBool(STORAGE_KEYS.taskBlockedOnlyFilter, false)) {
      view = "blocked";
      migrated = true;
    }
  }
  let epicKeys = stringArray(readJSON<unknown>(STORAGE_KEYS.taskEpicFilter, null));
  if (epicKeys === null) {
    const legacy = readString(STORAGE_KEYS.taskParentFilter, "");
    epicKeys = legacy === "" ? [] : [legacy];
    if (legacy !== "") migrated = true;
  }
  return { view, epicKeys, migrated };
}

/**
 * The board's filter state: every filter dimension, persisted where the old board
 * persisted it, plus the derived lists the bar, the facets panel and the board need.
 * `visibleTasks` is what the columns render; `tasks` itself must stay the store's
 * full list (see taskFilters.ts on reorder safety).
 */
export function useTaskFilters(tasks: Task[], projects: Array<{ id: number }>) {
  // Read once; the migration's writes happen in the effect below, not in render.
  const [initial] = useState(readInitial);
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>(() => {
    const raw = readJSON<unknown>(STORAGE_KEYS.taskProjectFilter, []);
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  });
  const [recentProjectIds, setRecentProjectIds] = useState<number[]>(() => {
    const raw = readJSON<unknown>(STORAGE_KEYS.taskRecentProjects, []);
    return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === "number") : [];
  });
  const [view, setViewState] = useState<QuickView>(initial.view);
  const [selectedEpicKeys, setSelectedEpicKeys] = useState<string[]>(initial.epicKeys);
  const [selectedAgents, setSelectedAgents] = useState<string[]>(
    () => stringArray(readJSON<unknown>(STORAGE_KEYS.taskAgentFilter, [])) ?? [],
  );
  const [text, setText] = useState("");
  const [hideDone, setHideDone] = useState(() => readBool(STORAGE_KEYS.taskHideDone, false));
  const [showArchived, setShowArchived] = useState(() =>
    readBool(STORAGE_KEYS.taskShowArchived, false),
  );
  const [facets, setFacetsState] = useState<FacetsSetting>(() => {
    const raw = readString(STORAGE_KEYS.taskFacets, "");
    return isFacetsSetting(raw) ? raw : "off";
  });

  // One-time migration of the legacy keys: write the new ones, drop the old ones.
  useEffect(() => {
    if (!initial.migrated) return;
    writeString(STORAGE_KEYS.taskQuickView, initial.view);
    writeJSON(STORAGE_KEYS.taskEpicFilter, initial.epicKeys);
    removeItem(STORAGE_KEYS.taskBlockedOnlyFilter);
    removeItem(STORAGE_KEYS.taskAwaitingMergeOnly);
    removeItem(STORAGE_KEYS.taskParentFilter);
  }, [initial]);
  useEffect(() => {
    writeBool(STORAGE_KEYS.taskHideDone, hideDone);
  }, [hideDone]);
  useEffect(() => {
    writeBool(STORAGE_KEYS.taskShowArchived, showArchived);
  }, [showArchived]);

  // Ids and keys of things that have since vanished (a deleted project, an epic whose
  // last child was re-parented) are dropped here rather than left to blank the board
  // with no visible way back. Derived, never written back: a project that reappears
  // keeps its saved selection.
  const knownProjectIds = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const activeProjectIds = useMemo(
    () => selectedProjectIds.filter((id) => knownProjectIds.has(id)),
    [selectedProjectIds, knownProjectIds],
  );
  const epicOpts = useMemo(() => epicOptions(tasks), [tasks]);
  const noEpic = useMemo(() => noEpicCount(tasks), [tasks]);
  const activeEpicKeys = useMemo(
    () =>
      selectedEpicKeys.filter(
        (k) => (k === NO_EPIC && noEpic > 0) || epicOpts.some((o) => o.key === k),
      ),
    [selectedEpicKeys, epicOpts, noEpic],
  );
  const agentOpts = useMemo(() => agentOptions(tasks), [tasks]);
  const activeAgents = useMemo(
    () => selectedAgents.filter((a) => agentOpts.some((o) => o.value === a)),
    [selectedAgents, agentOpts],
  );

  const filters: TaskFilters = useMemo(
    () => ({
      projectIds: activeProjectIds,
      view,
      epicKeys: activeEpicKeys,
      agents: activeAgents,
      text,
      showArchived,
    }),
    [activeProjectIds, view, activeEpicKeys, activeAgents, text, showArchived],
  );

  const scoped = useMemo(() => scopeTasks(tasks, filters), [tasks, filters]);
  const counts = useMemo(() => quickViewCounts(scoped), [scoped]);
  const visibleTasks = useMemo(
    () => (view === "all" ? scoped : scoped.filter((t) => matchesQuickView(t, view))),
    [scoped, view],
  );
  // Per-project counts for the picker and the facets panel: every filter except the
  // project one, so a project's number is what selecting it would add.
  const projectCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of scopeTasks(tasks, { ...filters, projectIds: [] })) {
      counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
    }
    return counts;
  }, [tasks, filters]);
  // Done tasks Clear done would drop that still have an open PR (in the project filter),
  // surfaced in its confirmation.
  const awaitingMergeCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          isAwaitingMerge(t) &&
          (activeProjectIds.length === 0 || activeProjectIds.includes(t.projectId)),
      ).length,
    [tasks, activeProjectIds],
  );

  const setView = useCallback((next: QuickView) => {
    setViewState(next);
    writeString(STORAGE_KEYS.taskQuickView, next);
  }, []);
  const setProjectIds = useCallback((ids: number[]) => {
    setSelectedProjectIds(ids);
    writeJSON(STORAGE_KEYS.taskProjectFilter, ids);
  }, []);
  const toggleProject = useCallback(
    (id: number) => {
      const next = activeProjectIds.includes(id)
        ? activeProjectIds.filter((p) => p !== id)
        : [...activeProjectIds, id];
      setProjectIds(next);
      if (next.includes(id)) {
        const recent = [id, ...recentProjectIds.filter((p) => p !== id)].slice(
          0,
          MAX_RECENT_PROJECTS,
        );
        setRecentProjectIds(recent);
        writeJSON(STORAGE_KEYS.taskRecentProjects, recent);
      }
    },
    [activeProjectIds, recentProjectIds, setProjectIds],
  );
  const toggleEpic = useCallback(
    (key: string) => {
      const next = activeEpicKeys.includes(key)
        ? activeEpicKeys.filter((k) => k !== key)
        : [...activeEpicKeys, key];
      setSelectedEpicKeys(next);
      writeJSON(STORAGE_KEYS.taskEpicFilter, next);
    },
    [activeEpicKeys],
  );
  const toggleAgent = useCallback(
    (value: string) => {
      const next = activeAgents.includes(value)
        ? activeAgents.filter((a) => a !== value)
        : [...activeAgents, value];
      setSelectedAgents(next);
      writeJSON(STORAGE_KEYS.taskAgentFilter, next);
    },
    [activeAgents],
  );
  const setFacets = useCallback((next: FacetsSetting) => {
    setFacetsState(next);
    writeString(STORAGE_KEYS.taskFacets, next);
  }, []);
  // Everything that narrows the board, but not the display settings (hide done, archived,
  // facets), which are preferences rather than filters.
  const clearFilters = useCallback(() => {
    setProjectIds([]);
    setViewState("all");
    writeString(STORAGE_KEYS.taskQuickView, "all");
    setSelectedEpicKeys([]);
    writeJSON(STORAGE_KEYS.taskEpicFilter, []);
    setSelectedAgents([]);
    writeJSON(STORAGE_KEYS.taskAgentFilter, []);
    setText("");
  }, [setProjectIds]);

  return {
    filters,
    visibleTasks,
    scoped,
    counts,
    projectCounts,
    awaitingMergeCount,
    epicOpts,
    noEpic,
    agentOpts,
    recentProjectIds,
    hideDone,
    // Hiding Done would hide exactly what the Awaiting merge view asks for.
    effectiveHideDone: hideDone && view !== "awaiting-merge",
    facets,
    setView,
    setProjectIds,
    toggleProject,
    toggleEpic,
    toggleAgent,
    setText,
    toggleHideDone: () => setHideDone((v) => !v),
    toggleShowArchived: () => setShowArchived((v) => !v),
    setFacets,
    clearFilters,
  };
}

export type TaskFilterApi = ReturnType<typeof useTaskFilters>;
