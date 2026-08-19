// App settings (read/patch + the seed default), web push subscription, and
// per-project browser-cookie profiles — all surfaced through Settings.tsx,
// which is why cookie-profile management (otherwise "browser"-shaped) lives
// here rather than with the browser pane's other endpoints (see ./browser.ts)
// — a deliberate deviation from the roadmap's suggested domain list, noted
// in this PR's write-up. Split out of the former flat frontend/src/api.ts
// (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type {
  AppSettings,
  SettingsPatch,
  PushSubscriptionPayload,
  BrowserCookieProfile,
} from "./types.js";

export const settingsApi = {
  getSettings: () => request<AppSettings>("/api/settings"),

  patchSettings: (patch: SettingsPatch) =>
    request<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // #95 — web push (pushClient.ts). Mirrors src/routes/push.ts's routes and
  // schemas exactly. getVapidPublicKey is fetched fresh each subscribe
  // (rather than cached) since it's cheap and this keeps pushClient.ts from
  // needing its own staleness story.
  getVapidPublicKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),

  // Body shape matches PushSubscription.toJSON() exactly (endpoint,
  // expirationTime, keys.p256dh/auth) — pushClient.ts passes
  // JSON.stringify(subscription) directly rather than rebuilding this by
  // hand, so this type only documents what src/routes/push.ts's
  // additionalProperties:false schema accepts.
  subscribePush: (subscription: PushSubscriptionPayload) =>
    request<void>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription),
    }),

  unsubscribePush: (endpoint: string) =>
    request<void>("/api/push/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),

  listBrowserCookieProfiles: (projectId: number) =>
    request<BrowserCookieProfile[]>(`/api/projects/${projectId}/browser-cookies`),

  importBrowserCookieProfile: (
    projectId: number,
    input: { browser: "chrome" | "firefox"; profilePath: string; label: string },
  ) =>
    request<BrowserCookieProfile>(`/api/projects/${projectId}/browser-cookies/import`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  uploadBrowserCookieProfile: (
    projectId: number,
    body: { browser: "chrome" | "firefox"; fileBase64: string; label: string },
  ) =>
    request<BrowserCookieProfile>(`/api/projects/${projectId}/browser-cookies/upload`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteBrowserCookieProfile: (projectId: number, id: number) =>
    request<void>(`/api/projects/${projectId}/browser-cookies/${id}`, { method: "DELETE" }),
};

// Mirrors src/services/settings.ts's DEFAULT_SETTINGS 1:1 — the store seeds
// its `settings` state with this synchronously at module load (before the
// GET /api/settings hydration resolves), so every consumer always has a
// sane value instead of racing an async fetch on first paint.
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: {
    fontFamily: "Geist Mono",
    fontSize: 14,
    // Mirrors settings.ts's DEFAULT_SETTINGS.
    padding: 4,
    colorScheme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    // Mirrors settings.ts's DEFAULT_SETTINGS — raised from 1000 (issue #83),
    // see that file's comment for why.
    scrollback: 5000,
    copyOnSelect: true,
    pasteOnRightClick: false,
    clipboardWrite: true,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
    },
    keyCapture: {
      ctrlR: true,
      ctrlL: true,
      ctrlK: false,
    },
    clipboardKeys: {
      ctrlV: false,
      ctrlC: false,
    },
  },
  sidebarDensity: "comfortable",
  projectRoots: [],
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
    hiddenAgents: [],
    skipPermissionsAgents: [],
  },
  notifications: {
    channels: {
      browser: true,
      sound: false,
      push: false,
    },
    soundName: "ping",
    idleThresholdSeconds: 30,
    autoFocusOnAttention: false,
    notificationMatrix: {
      exited: { notify: false, sound: false, autoFocus: false },
      api_error: { notify: true, sound: false, autoFocus: false },
      tool_failure: { notify: true, sound: false, autoFocus: false },
      awaiting_permission: { notify: true, sound: false, autoFocus: false },
      awaiting_plan: { notify: true, sound: false, autoFocus: false },
      awaiting_review_gate: { notify: true, sound: false, autoFocus: false },
      awaiting_promote: { notify: true, sound: false, autoFocus: false },
      awaiting_question: { notify: true, sound: false, autoFocus: false },
      awaiting_elicitation: { notify: true, sound: false, autoFocus: false },
      finished: { notify: false, sound: false, autoFocus: false },
      needs_input: { notify: true, sound: false, autoFocus: false },
      compacting: { notify: false, sound: false, autoFocus: false },
      subagent: { notify: false, sound: false, autoFocus: false },
      background: { notify: false, sound: false, autoFocus: false },
      working: { notify: false, sound: false, autoFocus: false },
      idle: { notify: false, sound: false, autoFocus: false },
      // No `as Record<SessionStatus, ...>` cast on this object (there used
      // to be one) — it silently defeated the exhaustiveness check the
      // outer `DEFAULT_SETTINGS: AppSettings` annotation would otherwise
      // give this literal, which is exactly how this object went missing
      // `awaiting_question` unnoticed (see #551). Letting AppSettings'
      // `notificationMatrix: Record<SessionStatus, ...>` type check this
      // literal directly means a newly-added SessionStatus with no entry
      // here is now a compile error, not a silent runtime `?? false`.
    },
  },
  dock: {
    defaultWorktreeRefresh: false,
    autoDetectDevServer: "ask",
    dockerServices: true,
  },
  sessions: {
    namePattern: "{agent} · {project}",
    confirmBeforeKill: true,
    hideEndedSessions: false,
    reconcileIntervalSeconds: 30,
    // Mirrors settings.ts's DEFAULT_SETTINGS — raised from 600 (fix:
    // status-clearing-semantics), see that file's comment for why.
    staleErrorSeconds: 1800,
    // Mirrors settings.ts's DEFAULT_SETTINGS.
    staleBusySeconds: 7200,
    gitAutoFetchIntervalSeconds: 300,
    eventPersistence: false,
    eventRetentionDays: 30,
    eventRetentionPerSession: 0,
    injectAgentGuide: true,
    injectProjectBriefing: true,
    maxChildSessionsPerParent: 5,
    autoOpenChildPanels: false,
  },
  taskMaster: {
    autoClaimPaused: false,
    enabled: "inherit",
    maxConcurrent: -1,
    budgetMinutes: -1,
    progressCommentMinutes: -1,
    skipPermissions: "inherit",
  },
};
