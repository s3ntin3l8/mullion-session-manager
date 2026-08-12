// Host-level, non-resource-scoped surface: the global launcher/action
// catalog, server info + self-update, and in-process auth — none of these
// are naturally "projects/sessions/tasks/github/git/hosts/workspaces/
// settings/docker/skills", so they're grouped here as their own domain
// rather than force-fit into one of those. See this PR's write-up for the
// deviation note. Split out of the former flat frontend/src/api.ts (PR 22
// of the refactoring roadmap).
import { request } from "./client.js";
import type { Agent, ServerInfo, UpdateCheckResult, UpdateStatus, AuthStatus } from "./types.js";
import type { Launcher } from "../../../src/shared/types.js";

export function normalizeAgentId(id: string): string {
  return id.startsWith("agent:") ? id.slice(6) : id;
}

export const systemApi = {
  listGlobalActions: () => request<Launcher[]>("/api/actions"),

  listAgents: (refresh?: boolean) => request<Agent[]>(`/api/agents${refresh ? "?refresh=1" : ""}`),
  getSkipPermissionFlags: () =>
    request<Record<string, string>>("/api/agents/skip-permissions-flags"),

  getServerInfo: () => request<ServerInfo>("/api/server-info"),
  checkForUpdate: (force?: boolean) =>
    request<UpdateCheckResult>(`/api/updates/check${force ? "?force=true" : ""}`),
  getUpdateStatus: () => request<UpdateStatus>("/api/updates/status"),
  applyUpdate: (version: string, assetUrl: string, checksumUrl: string) =>
    request<UpdateStatus>("/api/updates/apply", {
      method: "POST",
      body: JSON.stringify({ version, assetUrl, checksumUrl }),
    }),

  // Never gated by src/plugins/auth.ts's own onRequest hook (see its
  // /api/auth/ prefix exemption) — a request has to be able to reach these
  // to authenticate in the first place.
  getAuthStatus: () => request<AuthStatus>("/api/auth/me"),

  login: (token: string) =>
    request<void>("/api/auth/login", { method: "POST", body: JSON.stringify({ token }) }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
};
