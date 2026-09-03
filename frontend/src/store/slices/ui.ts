import type { StateCreator } from "zustand";
import { api, DEFAULT_SETTINGS } from "../../api/index.js";
import type { AppSettings, SettingsPatch } from "../../api/index.js";
import { deepMerge, mergePartialPatch } from "../../settingsMerge.js";
import { resolveTaskMaster } from "../../taskConfig.js";
import {
  STORAGE_KEYS,
  readBool,
  readMutedSessionIds,
  readString,
  removeItem,
  writeBool,
  writeMutedSessionIds,
  writeNumber,
  writeString,
} from "../../lib/persistedState.js";
import {
  FALLBACK_TASK_MASTER_ENV,
  HIGHLIGHT_DURATION_MS,
  SETTINGS_PATCH_DEBOUNCE_MS,
} from "../constants.js";
import {
  readStoredActiveWorkspaceId,
  readStoredHierarchicalView,
  readStoredSidebarWidth,
  readStoredViewMode,
  readThemeHint,
  resolveTheme,
} from "../helpers.js";
import type { DashboardState, Theme, UiSlice } from "../types.js";

function deriveTerminalPrefs(settings: AppSettings): UiSlice["terminalPrefs"] {
  return {
    fontSize: settings.terminal.fontSize,
    cursorStyle: settings.terminal.cursorStyle,
    scrollback: settings.terminal.scrollback,
  };
}

export const createUiSlice: StateCreator<DashboardState, [], [], UiSlice> = (set, get) => {
  // Closure-scoped (not React/store state) — accumulates across rapid
  // updateSettings() calls between debounce windows, same pattern
  // startLiveRefresh's own timer/cleanup closures use (slices/sessions.ts).
  let pendingPatch: SettingsPatch | null = null;
  let patchTimer: ReturnType<typeof setTimeout> | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

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
      showTaskSessions: next.sessions.showTaskSessions,
      // Task Master Settings UI follow-up — recomputed on every settings
      // change (hydrate AND every updateSettings patch), not just once on
      // env load, so toggling Settings -> Task Master's Enable switch takes
      // effect immediately rather than only after the next refreshTasks()
      // tick. Order-independent w.r.t. when taskMasterEnv itself loads: this
      // runs against whatever's cached so far (real value or the fallback),
      // and TasksSlice's own refreshTasks env-load path re-triggers this
      // same computation against the settings already in state at that
      // point. Cross-slice write — taskMasterEnabled belongs to TasksSlice,
      // not UiSlice, but `set`/`get` here are typed against the full
      // DashboardState (StateCreator<DashboardState, [], [], UiSlice>), so
      // this is a normal, type-checked write, not a workaround.
      taskMasterEnabled: resolveTaskMaster(
        next.taskMaster,
        get().taskMasterEnv ?? FALLBACK_TASK_MASTER_ENV,
      ).enabled,
    });
    writeString(STORAGE_KEYS.themeHint, resolveTheme(next.theme));
  }

  return {
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
    theme: readThemeHint(),
    terminalPrefs: deriveTerminalPrefs(DEFAULT_SETTINGS),
    hideEndedSessions: DEFAULT_SETTINGS.sessions.hideEndedSessions,
    showTaskSessions: DEFAULT_SETTINGS.sessions.showTaskSessions,
    // Desktop-only persistent collapse (distinct from the mobile-only
    // `sidebarOpen` overlay flag App.tsx owns locally — different semantics
    // per breakpoint: mobile is a closed-by-default overlay, desktop is an
    // open-by-default panel the user can choose to hide).
    sidebarCollapsed: readBool(STORAGE_KEYS.sidebarCollapsed, false),
    sidebarWidth: readStoredSidebarWidth(),
    viewMode: readStoredViewMode(),
    hierarchicalView: readStoredHierarchicalView(),
    kanbanOrder: {},
    splitRequest: null,
    notificationsPanelOpenRequest: 0,
    highlightedPanelId: null,
    activePanelId: null,
    activeWorkspaceId: readStoredActiveWorkspaceId(),
    dockConfigRefreshTrigger: 0,
    currentVersion: null,
    updateCheck: null,
    dismissedUpdateVersion: readString(STORAGE_KEYS.dismissedUpdateVersion, null),
    codexHookTrust: null,
    dismissedCodexHookTrustVersion: readString(STORAGE_KEYS.dismissedCodexHookTrustVersion, null),
    // #719 — per-session mute set, hydrated from localStorage so a reload
    // keeps the same mutes. A plain array (not a Set) to match
    // persistedState.ts's readMutedSessionIds/writeMutedSessionIds encoding.
    mutedSessionIds: readMutedSessionIds(),

    bumpDockConfigRefreshTrigger: () =>
      set((state) => ({ dockConfigRefreshTrigger: state.dockConfigRefreshTrigger + 1 })),

    triggerPanelHighlight: (id) => {
      set({ highlightedPanelId: id });
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        if (get().highlightedPanelId === id) {
          set({ highlightedPanelId: null });
        }
        highlightTimer = null;
      }, HIGHLIGHT_DURATION_MS);
    },

    setActivePanelId: (id) => set({ activePanelId: id }),

    setActiveWorkspaceId: (id) => {
      set({ activeWorkspaceId: id });
      if (id === null) {
        removeItem(STORAGE_KEYS.activeWorkspaceId);
      } else {
        writeNumber(STORAGE_KEYS.activeWorkspaceId, id);
      }
    },

    // Issue: selecting a workspace from Tasks (WorkspaceSwitcher.tsx, the
    // command palette) used to leave `viewMode` at "kanban" — the workspace
    // really did switch (setActiveWorkspaceId did its job), it just did so
    // invisibly behind the Tasks board's z-index 100 overlay (see App.tsx's
    // own `viewMode === "kanban"` render site), with no on-screen sign
    // anything happened. This is the user-initiated "go look at a
    // workspace" action; setActiveWorkspaceId alone stays the low-level
    // primitive.
    //
    // Deliberately NOT folded into setActiveWorkspaceId itself: two of that
    // setter's own call sites (App.tsx's first-run workspace bootstrap and
    // its stale-activeWorkspaceId recovery-on-load) are boot/repair paths,
    // not user navigation — overloading the low-level setter would silently
    // kick a user out of a persisted Tasks view on reload whenever a
    // workspace had been deleted out from under them. Keeping this as a
    // separate action is what leaves those two paths untouched.
    showWorkspace: (id) => {
      get().setActiveWorkspaceId(id);
      get().setViewMode("list");
    },

    hydrateSettings: async () => {
      const settings = await api.getSettings();
      applySettings(settings);
      set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
      // DEFAULT_SETTINGS passed explicitly (not the default `defaults = base`
      // param) — `get().settings` has already drifted from the defaults by
      // the time a second updateSettings() call lands, so deepMerge can't
      // infer a field's nullability from it alone. See deepMerge's own doc
      // comment (settingsMerge.ts) for the null <-> value transition bug
      // this fixes.
      const next = deepMerge(get().settings, patch, DEFAULT_SETTINGS);
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

    setShowTaskSessions: (value) => {
      get().updateSettings({ sessions: { showTaskSessions: value } });
    },

    setSidebarCollapsed: (value) => {
      writeBool(STORAGE_KEYS.sidebarCollapsed, value);
      set({ sidebarCollapsed: value });
    },

    setSidebarWidth: (value) => {
      writeNumber(STORAGE_KEYS.sidebarWidth, value);
      set({ sidebarWidth: value });
    },

    setViewMode: (value) => {
      writeString(STORAGE_KEYS.viewMode, value);
      set({ viewMode: value });
    },

    setHierarchicalView: (value) => {
      writeBool(STORAGE_KEYS.hierarchicalView, value);
      set({ hierarchicalView: value });
    },

    setKanbanColumnOrder: (columnId, order) => {
      set((state) => ({ kanbanOrder: { ...state.kanbanOrder, [columnId]: order } }));
    },

    requestSplit: (referencePanelId, direction) => {
      set({ splitRequest: { referencePanelId, direction } });
    },

    clearSplitRequest: () => {
      set({ splitRequest: null });
    },

    openNotificationsPanel: () => {
      set((state) => ({ notificationsPanelOpenRequest: state.notificationsPanelOpenRequest + 1 }));
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
        writeString(STORAGE_KEYS.themeHint, resolved);
      };
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },

    checkForUpdates: async () => {
      try {
        const result = await api.checkForUpdate();
        set({
          currentVersion: result.currentVersion,
          updateCheck: result,
        });
      } catch {
        // Fail silently — network/rate-limit errors shouldn't surface.
      }
    },

    dismissUpdate: () => {
      const version = get().updateCheck?.latestVersion;
      if (version) {
        writeString(STORAGE_KEYS.dismissedUpdateVersion, version);
      }
      set({ dismissedUpdateVersion: version ?? null });
    },

    checkCodexHookTrust: async () => {
      try {
        const agents = await api.listAgents();
        const codex = agents.find((a) => a.id === "agent:codex");
        set({ codexHookTrust: codex?.hookTrust ?? null });
      } catch {
        // Fail silently — same posture as checkForUpdates above; a missed
        // check just means the banner stays at its last-known state.
      }
    },

    // Dismiss-until-next-version, same convention as dismissUpdate above —
    // keyed on currentVersion rather than a hookTrust-specific token since
    // (post issue #259's stable-path fix) a pending grant is expected to
    // correlate with a version bump, not recur within one.
    dismissCodexHookTrust: () => {
      const version = get().currentVersion;
      if (version) {
        writeString(STORAGE_KEYS.dismissedCodexHookTrustVersion, version);
      }
      set({ dismissedCodexHookTrustVersion: version ?? null });
    },

    // #719 — toggle a session's mute. Read-modify-write against the current
    // array (not in place — zustand needs a new reference to re-render
    // subscribers), persist the new list, then commit to state. A session id
    // that appears twice can't happen (the toggle removes on re-click rather
    // than appending a duplicate), so `includes` stays a correct membership
    // test for callers.
    toggleSessionMute: (sessionId) => {
      const current = get().mutedSessionIds;
      const next = current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId];
      writeMutedSessionIds(next);
      set({ mutedSessionIds: next });
    },
  };
};
