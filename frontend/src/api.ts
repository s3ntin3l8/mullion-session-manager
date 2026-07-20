// Mirrors src/routes/auth.ts's GET /api/auth/me response. `methods` reports
// each in-process auth mechanism independently (not a single mode string)
// since issue #19's shared token and issue #30's OIDC login are additive —
// both can be configured at once, and AuthGate.tsx renders whichever
// controls apply. Both false means in-process auth isn't configured at all
// — AuthGate renders the dashboard unconditionally, the same behavior as
// before this feature existed. `user` is only present once authenticated
// via OIDC (a token-only session has no identity to report).
export interface AuthStatus {
  methods: { token: boolean; oidc: boolean };
  authenticated: boolean;
  user?: { sub: string; email?: string; name?: string; groups?: string[] };
}

export interface Project {
  id: number;
  name: string;
  cwd: string;
  // The host this project's files (and therefore its sessions) live on —
  // "local" for this same process, or a registered remote host's id (issue
  // #26). Every session under a project inherits its host.
  hostId: string;
  // Where this project's dev server listens (issue #28) — a bare port
  // ("5173") or a full URL. The authoritative, manually-set fallback the
  // preview proxy resolves against; null when unconfigured.
  devServerUrl: string | null;
  // Derived, not persisted (issue #28 phase 7) — a port the backend spotted
  // in a running dock session's own startup banner (Vite/Next/CRA/Astro all
  // print one), offered as a suggestion only. Never overrides devServerUrl;
  // null whenever nothing was detected (no dock session, no banner yet, or
  // a remote-hosted project — see dev-server-detect.ts).
  detectedDevServerPort: string | null;
  createdAt: string;
}

// Mirrors src/services/host-registry.ts's HostSummary 1:1 — never carries a
// token, just whether one is set (hasToken), same "no secrets over the API"
// rule AppSettings/ServerInfo above already follow.
export interface Host {
  id: string;
  name: string;
  baseUrl: string | null;
  isLocal: boolean;
  hasToken: boolean;
  createdAt: string;
}

export const LOCAL_HOST_ID = "local";

// Mirrors src/services/github-integration.ts's GitHubIntegrationSummary 1:1
// — never carries the token itself, same "hasToken-only" rule as Host above
// (there `hasToken`, here `connected`).
export interface GitHubIntegration {
  connected: boolean;
  tokenType: "pat" | "oauth" | null;
  login: string | null;
  scopes: string[] | null;
  connectedAt: string | null;
  deviceFlowAvailable: boolean;
}

// Mirrors src/services/github-device-flow.ts's DeviceFlowSummary 1:1 — never
// carries the device_code, only what the user needs to see (the
// user_code/verification_uri) and the current status.
export type DeviceFlowState = "pending" | "connected" | "expired" | "denied" | "error";

export interface DeviceFlowStatus {
  status: DeviceFlowState;
  userCode: string;
  verificationUri: string;
  errorMessage?: string;
}

export interface Session {
  id: number;
  projectId: number;
  name: string | null;
  command: string;
  cwd: string | null;
  // "dock" sessions are spawned from a project's dock controls (persistent
  // monitors) rather than a one-shot launcher/manual "+ Session" — kept out
  // of the normal per-project session list, rendered in the Dock region.
  kind: "terminal" | "dock";
  // "exited" = the program ended on its own (caught by the backend's
  // reconciler), distinct from "killed" (explicit user action).
  status: "active" | "killed" | "exited";
  createdAt: string;
  lastAttachedAt: string | null;
  alive: boolean;
  subscriberCount: number;
  // Live-only fields (in-memory PtyManager state, same philosophy as
  // alive/subscriberCount above — reset to idle/no-signal defaults for a
  // session this process hasn't tracked since its own last restart).
  activity: "working" | "idle";
  lastActivityAt: number | null;
  attention: boolean;
  attentionAt: number | null;
  lastTitle: string | null;
}

export interface Workspace {
  id: number;
  name: string;
  // Opaque dockview api.toJSON() blob — this client never inspects its
  // shape either, just round-trips it through App.tsx's fromJSON()/toJSON().
  layout: Record<string, unknown> | null;
  groupId: number | null;
  position: number;
  createdAt: string;
}

export interface Group {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  collapsed: boolean;
  position: number;
  createdAt: string;
}

export type LauncherKind = "shell" | "agent" | "npm-script" | "task" | "custom";

export interface Launcher {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  icon?: string;
  kind: LauncherKind;
}

export interface Agent {
  id: string;
  title: string;
  command: string;
  kind: "shell" | "agent";
  available: boolean;
  path: string | null;
}

export interface DiscoveredProject {
  name: string;
  cwd: string;
  isGitRepo: boolean;
  isRegistered: boolean;
}

// Mirrors src/services/github.ts's GitHubRepoStatus 1:1 (issue #27).
// GET /api/projects/:id/github returns 204 (no body) for every
// "not applicable" case (no github.com remote, no account connected, a
// GitHub API error) — callers treat that identically to `null`, never as
// an error to surface.
export interface GitHubIssueOrPr {
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
}

// Issue #27 phase 5 — the default branch's latest Actions run per workflow.
export interface GitHubActionsRun {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
}

export type GitHubCiStatus = "success" | "failure" | "in_progress" | null;

export interface GitHubStatus {
  repo: { owner: string; repo: string; htmlUrl: string };
  openIssues: number;
  openPRs: number;
  pulls: GitHubIssueOrPr[];
  issues: GitHubIssueOrPr[];
  actionsRuns: GitHubActionsRun[];
  ciStatus: GitHubCiStatus;
}

export interface DockControl {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
}

// Mirrors src/services/preview-registry.ts's PreviewSummary 1:1 (issue #28).
// `slug` is the "preview-<slug>" subdomain label the browser pane's iframe
// resolves against (see server-info's previewBaseHost below) — opaque and
// random, never a decodable target.
export interface Preview {
  slug: string;
  kind: "project" | "external";
  projectId: number | null;
  externalUrl: string | null;
  createdAt: string;
}

export interface ServerInfo {
  version: string;
  role: "primary" | "agent";
  nodeEnv: string;
  port: number;
  encryptionEnabled: boolean;
  sessionsDir: string;
  dbPath: string;
  uptimeSeconds: number;
  rateLimit: { max: number; window: string };
  projectsRoots: string;
  crsConfigDir: string;
  // Issue #28 — whether the subdomain preview proxy is configured at all
  // (PREVIEW_BASE_HOST set server-side), and if so the base host a browser
  // pane builds its iframe src from: `preview-<slug>.${previewBaseHost}`.
  previewsEnabled: boolean;
  previewBaseHost: string;
}

// Mirrors src/services/update-checker.ts's UpdateCheckResult.
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  assetUrl: string | null;
  checksumUrl: string | null;
  // Whether POST /api/updates/apply would even work — false on a dev
  // checkout (TESSERA_HOME unset), true on a versioned-release install.
  applyAvailable: boolean;
}

// Phases self-update.sh writes to $TESSERA_HOME/.update-status.json as it
// runs (see src/routes/updates.ts) — "unavailable" is server-side-only
// (TESSERA_HOME unset), "idle" means TESSERA_HOME is set but no update has
// run yet.
export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "downloading"
  | "installing"
  | "verifying"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  updatedAt?: number;
  error?: string;
}

// Mirrors src/services/settings.ts's AppSettings 1:1 — duplicated rather
// than shared across the workspace boundary (frontend/ is its own npm
// workspace with its own tsconfig), same pattern as Project/Session/etc.
// above already being independent copies of the backend's row shapes.
export type Theme = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";
export type SidebarDensity = "comfortable" | "compact";
export type SoundName = "ping" | "chime" | "blip";

export interface AppSettings {
  theme: Theme;
  terminal: {
    fontFamily: string;
    fontSize: number;
    colorScheme: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    pasteOnRightClick: boolean;
    reconnect: {
      enabled: boolean;
      maxAttempts: number;
    };
    keyCapture: {
      ctrlR: boolean;
      ctrlL: boolean;
      ctrlK: boolean;
    };
  };
  sidebarDensity: SidebarDensity;
  projectRoots: string[];
  launchers: {
    defaultShell: string;
    defaultAgent: string;
  };
  notifications: {
    attentionAlerts: boolean;
    channels: {
      browser: boolean;
      sound: boolean;
    };
    soundName: SoundName;
    idleThresholdSeconds: number;
    exitedAlerts: boolean;
  };
  sessions: {
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    reconcileIntervalSeconds: number;
  };
}

// A recursive partial — every level of AppSettings is independently
// patchable (e.g. `{ terminal: { fontSize: 18 } }` without also sending
// `terminal.cursorStyle`), matching the backend's deep-merge PATCH. Arrays
// (projectRoots) are a leaf, not recursed into — the backend replaces them
// outright rather than merging element-wise.
type DeepPartial<T> =
  T extends Array<unknown> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type SettingsPatch = DeepPartial<AppSettings>;

// Mirrors src/services/settings.ts's DEFAULT_SETTINGS 1:1 — the store seeds
// its `settings` state with this synchronously at module load (before the
// GET /api/settings hydration resolves), so every consumer always has a
// sane value instead of racing an async fetch on first paint.
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: {
    fontFamily: "Geist Mono",
    fontSize: 14,
    colorScheme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 1000,
    copyOnSelect: true,
    pasteOnRightClick: false,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
    },
    keyCapture: {
      ctrlR: true,
      ctrlL: true,
      ctrlK: false,
    },
  },
  sidebarDensity: "comfortable",
  projectRoots: [],
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
  },
  notifications: {
    attentionAlerts: false,
    channels: {
      browser: true,
      sound: false,
    },
    soundName: "ping",
    idleThresholdSeconds: 30,
    exitedAlerts: false,
  },
  sessions: {
    namePattern: "{agent} · {project}",
    confirmBeforeKill: true,
    hideEndedSessions: false,
    reconcileIntervalSeconds: 30,
  },
};

// Carries the HTTP status code alongside the backend's message so a caller
// can branch on the actual response (e.g. Settings -> Hosts' cascade-delete
// prompt checking `statusCode === 409`) instead of substring-matching
// error text, which silently breaks the moment the backend's wording changes.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Same-origin only (never sent cross-origin) — required for the
    // optional in-process auth session cookie (issue #19,
    // src/plugins/auth.ts) to ride along; a no-op when TESSERA_AUTH_TOKEN is
    // unset, since there's no cookie to send either way.
    credentials: "same-origin",
    // Only set this when there's actually a body — sending it on bodyless
    // requests (GET, DELETE) is invalid and some fetch layers reject it outright.
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || `${path} failed with ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),

  createProject: (name: string, cwd: string, hostId?: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(hostId ? { name, cwd, hostId } : { name, cwd }),
    }),

  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "cwd" | "devServerUrl">>) =>
    request<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  discoverProjects: (hostId?: string) =>
    request<DiscoveredProject[]>(
      `/api/projects/discover${hostId ? `?hostId=${encodeURIComponent(hostId)}` : ""}`,
    ),

  listProjectActions: (projectId: number) =>
    request<Launcher[]>(`/api/projects/${projectId}/actions`),

  listProjectDock: (projectId: number) => request<DockControl[]>(`/api/projects/${projectId}/dock`),

  // undefined for the 204 "not applicable" response (see GitHubStatus above)
  // — request() already returns undefined for a 204 body, this just gives
  // that case an honest return type instead of asserting GitHubStatus.
  getProjectGitHub: (projectId: number) =>
    request<GitHubStatus | undefined>(`/api/projects/${projectId}/github`),

  listSessions: (opts?: { projectId?: number; kind?: "terminal" | "dock" }) => {
    const params = new URLSearchParams();
    if (opts?.projectId !== undefined) params.set("projectId", String(opts.projectId));
    if (opts?.kind !== undefined) params.set("kind", opts.kind);
    const qs = params.toString();
    return request<Session[]>(`/api/sessions${qs ? `?${qs}` : ""}`);
  },

  createSession: (
    projectId: number,
    command: string,
    opts?: { name?: string; cwd?: string; kind?: "terminal" | "dock" },
  ) =>
    request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, command, ...opts }),
    }),

  renameSession: (id: number, name: string) =>
    request<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteSession: (id: number) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),

  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),

  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  renameWorkspace: (id: number, name: string) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  saveWorkspaceLayout: (id: number, layout: Record<string, unknown>) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ layout }),
    }),

  setWorkspaceGroup: (id: number, groupId: number | null, position?: number) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ groupId, ...(position !== undefined ? { position } : {}) }),
    }),

  deleteWorkspace: (id: number) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),

  listGroups: () => request<Group[]>("/api/groups"),

  createGroup: (name: string, color?: string) =>
    request<Group>("/api/groups", {
      method: "POST",
      body: JSON.stringify(color !== undefined ? { name, color } : { name }),
    }),

  updateGroup: (
    id: number,
    patch: Partial<Pick<Group, "name" | "icon" | "color" | "collapsed" | "position">>,
  ) =>
    request<Group>(`/api/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteGroup: (id: number) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),

  listGlobalActions: () => request<Launcher[]>("/api/actions"),

  listAgents: (refresh?: boolean) => request<Agent[]>(`/api/agents${refresh ? "?refresh=1" : ""}`),

  getServerInfo: () => request<ServerInfo>("/api/server-info"),
  checkForUpdate: (force?: boolean) =>
    request<UpdateCheckResult>(`/api/updates/check${force ? "?force=true" : ""}`),
  getUpdateStatus: () => request<UpdateStatus>("/api/updates/status"),
  applyUpdate: (version: string, assetUrl: string, checksumUrl: string) =>
    request<UpdateStatus>("/api/updates/apply", {
      method: "POST",
      body: JSON.stringify({ version, assetUrl, checksumUrl }),
    }),

  getSettings: () => request<AppSettings>("/api/settings"),

  patchSettings: (patch: SettingsPatch) =>
    request<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listHosts: () => request<Host[]>("/api/hosts"),

  createHost: (name: string, baseUrl: string, token: string) =>
    request<Host>("/api/hosts", {
      method: "POST",
      body: JSON.stringify({ name, baseUrl, token }),
    }),

  updateHost: (id: string, patch: Partial<{ name: string; baseUrl: string; token: string }>) =>
    request<Host>(`/api/hosts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // `?cascade=true` best-effort terminates every live session under this
  // host's projects and deletes them along with it — see
  // src/routes/hosts.ts's DELETE handler. Without it, a host that still
  // owns projects 409s (surfaced to the caller as a thrown Error whose
  // message names the project count, per request()'s body.message handling
  // above).
  deleteHost: (id: string, opts?: { cascade?: boolean }) =>
    request<void>(`/api/hosts/${encodeURIComponent(id)}${opts?.cascade ? "?cascade=true" : ""}`, {
      method: "DELETE",
    }),

  pingHost: (id: string) =>
    request<{ online: boolean }>(`/api/hosts/${encodeURIComponent(id)}/ping`, { method: "POST" }),

  getGitHubIntegration: () => request<GitHubIntegration>("/api/integrations/github"),

  setGitHubToken: (token: string) =>
    request<GitHubIntegration>("/api/integrations/github/token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  disconnectGitHub: () => request<void>("/api/integrations/github", { method: "DELETE" }),

  startGitHubDeviceFlow: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/start", { method: "POST" }),

  getGitHubDeviceFlowStatus: () =>
    request<DeviceFlowStatus>("/api/integrations/github/device/status"),

  // Idempotent by projectId — reopening the same project's browser pane
  // reuses its existing preview row/slug rather than minting a new one (see
  // src/services/preview-registry.ts).
  createProjectPreview: (projectId: number) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "project", projectId }),
    }),

  createExternalPreview: (url: string) =>
    request<Preview>("/api/previews", {
      method: "POST",
      body: JSON.stringify({ kind: "external", url }),
    }),

  getPreview: (slug: string) => request<Preview>(`/api/previews/${encodeURIComponent(slug)}`),

  deletePreview: (slug: string) =>
    request<void>(`/api/previews/${encodeURIComponent(slug)}`, { method: "DELETE" }),

  // Never gated by src/plugins/auth.ts's own onRequest hook (see its
  // /api/auth/ prefix exemption) — a request has to be able to reach these
  // to authenticate in the first place.
  getAuthStatus: () => request<AuthStatus>("/api/auth/me"),

  login: (token: string) =>
    request<void>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
};
