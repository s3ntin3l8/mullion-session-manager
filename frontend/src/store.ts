import { create } from "zustand";
import { api, DEFAULT_SETTINGS } from "./api.js";
import type {
  AppSettings,
  Group,
  Project,
  Session,
  SettingsPatch,
  Theme as ThemePreference,
  Workspace,
} from "./api.js";
import type { PositionUpdate, ReorderUpdate } from "./reorder.js";
import { deepMerge, mergePartialPatch } from "./settingsMerge.js";
import { isUnreadAttention } from "./attention.js";

// Which workspace was last active survives a reload via localStorage (not
// the DB — it's a per-browser UI preference, not shared server state).
const ACTIVE_WORKSPACE_STORAGE_KEY = "crs.activeWorkspaceId";
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
// Desktop-only persistent collapse (distinct from the mobile-only
// `sidebarOpen` overlay flag App.tsx owns locally — different semantics per
// breakpoint: mobile is a closed-by-default overlay, desktop is an
// open-by-default panel the user can choose to hide).
const SIDEBAR_COLLAPSED_KEY = "crs.sidebarCollapsed";
// Per-browser "read" state for the notification bell (NotificationBell.tsx) —
// there is no backend acknowledge/mark-read concept (attention is sticky
// in-memory PtyManager state, see src/services/pty-manager.ts), so this is
// purely a local UI overlay: sessionId -> the `attentionAt` value that was
// acknowledged. Keyed on the timestamp rather than a plain acknowledged-ids
// Set so a session that rings again *after* being acknowledged (a fresh,
// larger `attentionAt` from the backend) naturally re-surfaces as unread
// without any explicit "un-acknowledge" step.
const ACKED_ATTENTION_KEY = "crs.acknowledgedAttention";
// A thin first-paint mirror of the *resolved* theme only — settings.theme
// itself (dark/light/system) is server-persisted (see hydrateSettings
// below), but waiting on that fetch before the very first render would
// flash the wrong theme. This one key is written every time the resolved
// theme changes and read once, synchronously, at module load.
const THEME_HINT_KEY = "crs.themeHint";

function readStoredActiveWorkspaceId(): number | null {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function readStoredAckedAttention(): Record<number, number> {
  try {
    const raw = localStorage.getItem(ACKED_ATTENTION_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<number, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (Number.isInteger(id) && typeof value === "number") result[id] = value;
    }
    return result;
  } catch {
    return {};
  }
}

// Re-exported for existing consumers that import it alongside the store
// (NotificationBell.tsx) — the actual definition lives in attention.ts so it
// stays importable in the frontend's node-environment vitest tests without
// pulling in this module's localStorage-touching creation side effects.
export { isUnreadAttention };

// The *resolved* theme — what's actually painted (dockview class, root
// `.light` class, xterm palette). Distinct from `AppSettings["theme"]`
// (imported above as `ThemePreference`), which additionally allows
// `"system"` — this is always one of the two concrete values that
// preference resolves to. Exported under the pre-existing name so
// cliLogos.ts's `import type { Theme } from "./store.js"` (and any other
// consumer expecting only "dark" | "light") keeps working unchanged.
export type Theme = "dark" | "light";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : true;
}

function resolveTheme(pref: ThemePreference): Theme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

function readThemeHint(): Theme {
  return localStorage.getItem(THEME_HINT_KEY) === "light" ? "light" : "dark";
}

// Back-compat alias other files already import from store.ts.
export interface TerminalPrefs {
  fontSize: number;
  cursorStyle: AppSettings["terminal"]["cursorStyle"];
  scrollback: number;
}

function deriveTerminalPrefs(settings: AppSettings): TerminalPrefs {
  return {
    fontSize: settings.terminal.fontSize,
    cursorStyle: settings.terminal.cursorStyle,
    scrollback: settings.terminal.scrollback,
  };
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
  // The full server-persisted preferences blob (Settings modal's "Everything
  // wired now" rework — see .claude/plans/i-want-to-rework-delegated-bonbon.md).
  // Seeded with DEFAULT_SETTINGS synchronously at store creation so every
  // consumer has a sane value immediately; hydrateSettings() overwrites it
  // with the server's copy once GET /api/settings resolves.
  settings: AppSettings;
  settingsLoaded: boolean;
  // Derived read-only slices of `settings`, kept as real state fields (not
  // getters) so existing `useDashboardStore((s) => s.theme)`-style reactive
  // selectors across the app keep working unchanged.
  theme: Theme;
  terminalPrefs: TerminalPrefs;
  hideEndedSessions: boolean;
  notificationsEnabled: boolean;
  sidebarCollapsed: boolean;
  // Per-browser notification-bell read state — see ACKED_ATTENTION_KEY above.
  acknowledgedAttention: Record<number, number>;
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
  // Fetches GET /api/settings once (App.tsx's mount effect, alongside
  // startLiveRefresh) and merges it into `settings` + the derived fields
  // above. Safe to call more than once — always just re-syncs from the
  // server's current copy.
  hydrateSettings: () => Promise<void>;
  // The one write path for every preference: deep-merges `patch` into local
  // `settings` optimistically (so the UI reflects it immediately), then
  // fires a debounced PATCH /api/settings so a slider/number-field drag
  // sends one request instead of one per tick. toggleTheme/setTerminalPrefs/
  // etc. below are thin wrappers over this for call sites that predate the
  // unified settings object.
  updateSettings: (patch: SettingsPatch) => void;
  // Cycles dark<->light (never lands on "system") — the Toolbar/legacy quick
  // toggle. The Settings modal's Theme segmented control (Dark/Light/System)
  // calls updateSettings({ theme: ... }) directly instead.
  toggleTheme: () => void;
  setTerminalPrefs: (patch: Partial<TerminalPrefs>) => void;
  setHideEndedSessions: (value: boolean) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setSidebarCollapsed: (value: boolean) => void;
  // NotificationBell.tsx's row click / "Mark all as read" — see
  // isUnreadAttention above for the read/unread rule these maintain.
  acknowledgeAttention: (sessionId: number) => void;
  acknowledgeAllAttention: () => void;
  requestSplit: (referencePanelId: string, direction: "right" | "below") => void;
  clearSplitRequest: () => void;
  // Starts the ~4s session-status poll (paused while the tab is hidden) and
  // returns a cleanup function — called once from App.tsx's mount effect.
  // Kept as a store action (rather than plain App.tsx setInterval) so any
  // consumer of `sessions` gets the same live-refresh guarantee.
  startLiveRefresh: () => () => void;
  // Re-resolves `theme` whenever the OS-level color-scheme preference
  // changes, but only while settings.theme === "system" — a no-op the rest
  // of the time. Returns a cleanup function; called once from App.tsx
  // alongside startLiveRefresh.
  startThemeWatch: () => () => void;
}

// How long to wait after the last updateSettings() call before firing the
// PATCH — long enough that a slider/number-field drag collapses into one
// request, short enough that a toggle click still feels instant on the
// network (well under the live-refresh poll interval).
const SETTINGS_PATCH_DEBOUNCE_MS = 400;

export const useDashboardStore = create<DashboardState>((set, get) => {
  // Closure-scoped (not React/store state) — accumulates across rapid
  // updateSettings() calls between debounce windows, same pattern
  // startLiveRefresh()'s own timer/cleanup closures already use below.
  let pendingPatch: SettingsPatch | null = null;
  let patchTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPendingPatch() {
    if (!pendingPatch) return;
    const patch = pendingPatch;
    pendingPatch = null;
    patchTimer = null;
    // Fire-and-forget: the optimistic local state is already correct: a
    // failure here just means the next hydrateSettings()/reload sees the
    // pre-patch server value, which is an acceptable degrade for a
    // preferences PATCH (no user-facing error surface for this exists yet).
    void api.patchSettings(patch).catch((err) => {
      console.error("Failed to persist settings", err);
    });
  }

  function applySettings(next: AppSettings) {
    set({
      settings: next,
      theme: resolveTheme(next.theme),
      terminalPrefs: deriveTerminalPrefs(next),
      hideEndedSessions: next.sessions.hideEndedSessions,
      notificationsEnabled: next.notifications.attentionAlerts,
    });
    localStorage.setItem(THEME_HINT_KEY, resolveTheme(next.theme));
  }

  return {
    projects: [],
    sessions: [],
    workspaces: [],
    groups: [],
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    theme: readThemeHint(),
    terminalPrefs: deriveTerminalPrefs(DEFAULT_SETTINGS),
    hideEndedSessions: DEFAULT_SETTINGS.sessions.hideEndedSessions,
    notificationsEnabled: DEFAULT_SETTINGS.notifications.attentionAlerts,
    sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
    acknowledgedAttention: readStoredAckedAttention(),
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

    hydrateSettings: async () => {
      const settings = await api.getSettings();
      applySettings(settings);
      set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
      const next = deepMerge(get().settings, patch);
      applySettings(next);

      pendingPatch = pendingPatch ? mergePartialPatch(pendingPatch, patch) : patch;
      if (patchTimer) clearTimeout(patchTimer);
      patchTimer = setTimeout(flushPendingPatch, SETTINGS_PATCH_DEBOUNCE_MS);
    },

    toggleTheme: () => {
      const next: Theme = get().theme === "dark" ? "light" : "dark";
      get().updateSettings({ theme: next });
    },

    setTerminalPrefs: (patch) => {
      get().updateSettings({ terminal: patch });
    },

    setHideEndedSessions: (value) => {
      get().updateSettings({ sessions: { hideEndedSessions: value } });
    },

    setNotificationsEnabled: (value) => {
      get().updateSettings({ notifications: { attentionAlerts: value } });
    },

    setSidebarCollapsed: (value) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
      set({ sidebarCollapsed: value });
    },

    acknowledgeAttention: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId);
      const next = {
        ...get().acknowledgedAttention,
        [sessionId]: session?.attentionAt ?? Date.now(),
      };
      localStorage.setItem(ACKED_ATTENTION_KEY, JSON.stringify(next));
      set({ acknowledgedAttention: next });
    },

    acknowledgeAllAttention: () => {
      const next = { ...get().acknowledgedAttention };
      for (const session of get().sessions) {
        if (isUnreadAttention(session, next)) next[session.id] = session.attentionAt ?? Date.now();
      }
      localStorage.setItem(ACKED_ATTENTION_KEY, JSON.stringify(next));
      set({ acknowledgedAttention: next });
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

    startThemeWatch: () => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        if (get().settings.theme !== "system") return;
        const resolved = resolveTheme("system");
        set({ theme: resolved });
        localStorage.setItem(THEME_HINT_KEY, resolved);
      };
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
  };
});
