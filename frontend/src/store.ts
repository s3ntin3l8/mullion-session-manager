import { create } from "zustand";
import { api } from "./api.js";
import type { Group, Project, Session, Workspace } from "./api.js";
import type { PositionUpdate, ReorderUpdate } from "./reorder.js";

// Which workspace was last active survives a reload via localStorage (not
// the DB — it's a per-browser UI preference, not shared server state).
const ACTIVE_WORKSPACE_STORAGE_KEY = "crs.activeWorkspaceId";
const THEME_STORAGE_KEY = "crs.theme";
// How often the live-refresh loop re-fetches sessions so status badges
// (activity/attention/exited) reflect the backend without waiting on a
// mutation. Paused while the tab is hidden (visibilitychange) — no point
// polling a backgrounded tab, and it keeps a laptop-in-a-drawer session from
// hammering the API forever.
export const LIVE_REFRESH_INTERVAL_MS = 4000;
// Consecutive failed session-fetches (from any caller — the live poll,
// Sidebar's own mount fetch, etc.) before the design's "whole backend down"
// banner shows. >1 so a single transient blip doesn't flash it; in
// practice only the frequent live-refresh poll realistically accumulates
// this fast, since one-shot callers would need to independently fail twice
// in a row for the same thing to happen from them alone.
const BACKEND_UNREACHABLE_THRESHOLD = 2;
// Module-scoped (not component state) — refreshSessions() is called from
// many places (the live poll, Sidebar's mount effect, onSessionEnded
// flows), and all of them should share one counter/recovery signal rather
// than each tracking its own.
let consecutiveSessionFetchFailures = 0;
const TERMINAL_PREFS_KEY = "crs.terminalPrefs";
const HIDE_ENDED_SESSIONS_KEY = "crs.hideEndedSessions";
const NOTIFICATIONS_ENABLED_KEY = "crs.notificationsEnabled";
// Desktop-only persistent collapse (distinct from the mobile-only
// `sidebarOpen` overlay flag App.tsx owns locally — different semantics per
// breakpoint: mobile is a closed-by-default overlay, desktop is an
// open-by-default panel the user can choose to hide).
const SIDEBAR_COLLAPSED_KEY = "crs.sidebarCollapsed";

function readStoredActiveWorkspaceId(): number | null {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

export type Theme = "dark" | "light";

function readStoredTheme(): Theme {
  return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

// Client-only preferences (Settings -> Appearance/Terminal/Sessions/
// Notifications tabs) — none of these need a backend endpoint, they're
// purely local rendering/behavior prefs, same philosophy as `theme` above.
export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  scrollback: number;
}

const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 14,
  cursorStyle: "block",
  scrollback: 1000,
};

function readStoredTerminalPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(TERMINAL_PREFS_KEY);
    if (!raw) return DEFAULT_TERMINAL_PREFS;
    return { ...DEFAULT_TERMINAL_PREFS, ...(JSON.parse(raw) as Partial<TerminalPrefs>) };
  } catch {
    return DEFAULT_TERMINAL_PREFS;
  }
}

// A pane's split-right/split-down action (PaneHeaderActions.tsx, a dockview
// `rightHeaderActionsComponent`) can't receive custom props from App.tsx —
// dockview owns that component's render — so it signals intent through the
// store instead (same reason PaneTab.tsx already reads/writes the store
// directly). App.tsx reacts to a new `splitRequest` by opening the command
// palette scoped to the reference panel's project; the palette's own launch
// handler reads it back to decide whether to add the new panel via a normal
// open-or-focus or as a real split (`position: {referencePanel, direction}`).
// Cleared on launch or on palette close, whichever comes first.
export interface SplitRequest {
  referencePanelId: string;
  direction: "right" | "below";
}

interface DashboardState {
  projects: Project[];
  sessions: Session[];
  workspaces: Workspace[];
  groups: Group[];
  theme: Theme;
  terminalPrefs: TerminalPrefs;
  hideEndedSessions: boolean;
  notificationsEnabled: boolean;
  sidebarCollapsed: boolean;
  // Design's "whole backend down" state (States doc section 04) — flips
  // false after BACKEND_UNREACHABLE_THRESHOLD consecutive session-fetch
  // failures, true again the moment one succeeds. See
  // consecutiveSessionFetchFailures above for why this lives outside any
  // one specific call site.
  backendReachable: boolean;
  splitRequest: SplitRequest | null;
  // May reference a workspace that no longer exists (deleted in another
  // tab, or a stale localStorage value) — App.tsx is responsible for
  // falling back to first-available/create-default when that happens.
  activeWorkspaceId: number | null;
  refreshProjects: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  createProject: (name: string, cwd: string) => Promise<Project>;
  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "cwd">>) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  createSession: (
    projectId: number,
    command: string,
    opts?: { name?: string; cwd?: string; kind?: "terminal" | "dock" },
  ) => Promise<Session>;
  renameSession: (id: number, name: string) => Promise<void>;
  deleteSession: (id: number) => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  renameWorkspace: (id: number, name: string) => Promise<void>;
  deleteWorkspace: (id: number) => Promise<void>;
  setWorkspaceGroup: (id: number, groupId: number | null, position?: number) => Promise<void>;
  // Batched drag-and-drop commit (Phase 4d) — one PATCH per row that
  // actually changed (see reorder.ts's computeReorder), applied
  // optimistically to local state before the PATCHes resolve so a dropped
  // row doesn't visually snap back to its pre-drop order for the
  // round-trip duration, then a single refresh once every PATCH settles.
  // Deliberately NOT implemented by looping setWorkspaceGroup — that would
  // refetch once per row instead of once total.
  reorderWorkspaces: (updates: ReorderUpdate[]) => Promise<void>;
  reorderGroups: (updates: PositionUpdate[]) => Promise<void>;
  // Fire-and-forget from App.tsx's debounced autosave — deliberately does
  // not refresh the workspaces list afterward (called frequently; the
  // store's own layout copy isn't read by anything that needs it fresh).
  saveWorkspaceLayout: (id: number, layout: Record<string, unknown>) => Promise<void>;
  setActiveWorkspaceId: (id: number | null) => void;
  createGroup: (name: string, color?: string) => Promise<Group>;
  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) => Promise<void>;
  deleteGroup: (id: number) => Promise<void>;
  toggleTheme: () => void;
  setTerminalPrefs: (patch: Partial<TerminalPrefs>) => void;
  setHideEndedSessions: (value: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  requestSplit: (referencePanelId: string, direction: "right" | "below") => void;
  clearSplitRequest: () => void;
  // Starts the ~4s session-status poll (paused while the tab is hidden) and
  // returns a cleanup function — called once from App.tsx's mount effect.
  // Kept as a store action (rather than plain App.tsx setInterval) so any
  // consumer of `sessions` gets the same live-refresh guarantee.
  startLiveRefresh: () => () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  projects: [],
  sessions: [],
  workspaces: [],
  groups: [],
  theme: readStoredTheme(),
  terminalPrefs: readStoredTerminalPrefs(),
  hideEndedSessions: localStorage.getItem(HIDE_ENDED_SESSIONS_KEY) === "1",
  notificationsEnabled: localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === "1",
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
  splitRequest: null,
  backendReachable: true,
  activeWorkspaceId: readStoredActiveWorkspaceId(),

  refreshProjects: async () => {
    set({ projects: await api.listProjects() });
  },

  refreshSessions: async () => {
    try {
      const sessions = await api.listSessions();
      set({ sessions });
      if (consecutiveSessionFetchFailures > 0 || !get().backendReachable) {
        consecutiveSessionFetchFailures = 0;
        set({ backendReachable: true });
      }
    } catch (err) {
      consecutiveSessionFetchFailures += 1;
      if (consecutiveSessionFetchFailures >= BACKEND_UNREACHABLE_THRESHOLD) {
        set({ backendReachable: false });
      }
      throw err;
    }
  },

  createProject: async (name, cwd) => {
    const project = await api.createProject(name, cwd);
    await get().refreshProjects();
    return project;
  },

  updateProject: async (id, patch) => {
    await api.updateProject(id, patch);
    await get().refreshProjects();
  },

  deleteProject: async (id) => {
    await api.deleteProject(id);
    await Promise.all([get().refreshProjects(), get().refreshSessions()]);
  },

  createSession: async (projectId, command, opts) => {
    const session = await api.createSession(projectId, command, opts);
    await get().refreshSessions();
    return session;
  },

  renameSession: async (id, name) => {
    await api.renameSession(id, name);
    await get().refreshSessions();
  },

  deleteSession: async (id) => {
    await api.deleteSession(id);
    await get().refreshSessions();
  },

  refreshWorkspaces: async () => {
    set({ workspaces: await api.listWorkspaces() });
  },

  createWorkspace: async (name) => {
    const workspace = await api.createWorkspace(name);
    await get().refreshWorkspaces();
    return workspace;
  },

  renameWorkspace: async (id, name) => {
    await api.renameWorkspace(id, name);
    await get().refreshWorkspaces();
  },

  deleteWorkspace: async (id) => {
    await api.deleteWorkspace(id);
    await get().refreshWorkspaces();
  },

  setWorkspaceGroup: async (id, groupId, position) => {
    await api.setWorkspaceGroup(id, groupId, position);
    await get().refreshWorkspaces();
  },

  reorderWorkspaces: async (updates) => {
    if (updates.length === 0) return;
    set((state) => ({
      workspaces: state.workspaces.map((w) => {
        const u = updates.find((x) => x.id === w.id);
        return u ? { ...w, groupId: u.groupId, position: u.position } : w;
      }),
    }));
    await Promise.all(updates.map((u) => api.setWorkspaceGroup(u.id, u.groupId, u.position)));
    await get().refreshWorkspaces();
  },

  reorderGroups: async (updates) => {
    if (updates.length === 0) return;
    set((state) => ({
      groups: state.groups.map((g) => {
        const u = updates.find((x) => x.id === g.id);
        return u ? { ...g, position: u.position } : g;
      }),
    }));
    await Promise.all(updates.map((u) => api.updateGroup(u.id, { position: u.position })));
    await get().refreshGroups();
  },

  saveWorkspaceLayout: async (id, layout) => {
    await api.saveWorkspaceLayout(id, layout);
  },

  setActiveWorkspaceId: (id) => {
    set({ activeWorkspaceId: id });
    if (id === null) {
      localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    } else {
      localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, String(id));
    }
  },

  refreshGroups: async () => {
    set({ groups: await api.listGroups() });
  },

  createGroup: async (name, color) => {
    const group = await api.createGroup(name, color);
    await get().refreshGroups();
    return group;
  },

  updateGroup: async (id, patch) => {
    await api.updateGroup(id, patch);
    await get().refreshGroups();
  },

  deleteGroup: async (id) => {
    await api.deleteGroup(id);
    // A group's member workspaces get groupId set null server-side (ON
    // DELETE SET NULL) — refresh both so they reappear ungrouped instead of
    // looking like they vanished with the group.
    await Promise.all([get().refreshGroups(), get().refreshWorkspaces()]);
  },

  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    set({ theme: next });
  },

  setTerminalPrefs: (patch) => {
    const next = { ...get().terminalPrefs, ...patch };
    localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(next));
    set({ terminalPrefs: next });
  },

  setHideEndedSessions: (value) => {
    localStorage.setItem(HIDE_ENDED_SESSIONS_KEY, value ? "1" : "0");
    set({ hideEndedSessions: value });
  },

  setNotificationsEnabled: (value) => {
    localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, value ? "1" : "0");
    set({ notificationsEnabled: value });
  },

  setSidebarCollapsed: (value) => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
    set({ sidebarCollapsed: value });
  },

  requestSplit: (referencePanelId, direction) => {
    set({ splitRequest: { referencePanelId, direction } });
  },

  clearSplitRequest: () => {
    set({ splitRequest: null });
  },

  startLiveRefresh: () => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void get().refreshSessions();
    };

    const start = () => {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, LIVE_REFRESH_INTERVAL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  },
}));
