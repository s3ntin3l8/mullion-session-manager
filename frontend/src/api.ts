export interface Project {
  id: number;
  name: string;
  cwd: string;
  createdAt: string;
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

export interface DockControl {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  height?: number;
  env?: Record<string, string>;
}

export interface ServerInfo {
  version: string;
  nodeEnv: string;
  port: number;
  encryptionEnabled: boolean;
  sessionsDir: string;
  rateLimit: { max: number; window: string };
  projectsRoots: string;
  crsConfigDir: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Only set this when there's actually a body — sending it on bodyless
    // requests (GET, DELETE) is invalid and some fetch layers reject it outright.
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${path} failed with ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),

  createProject: (name: string, cwd: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, cwd }),
    }),

  updateProject: (id: number, patch: Partial<Pick<Project, "name" | "cwd">>) =>
    request<Project>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),

  discoverProjects: () => request<DiscoveredProject[]>("/api/projects/discover"),

  listProjectActions: (projectId: number) =>
    request<Launcher[]>(`/api/projects/${projectId}/actions`),

  listProjectDock: (projectId: number) => request<DockControl[]>(`/api/projects/${projectId}/dock`),

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
};
