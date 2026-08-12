// Multi-host registry (issue #26/#246) — registering, updating, pinging, and
// reading the config of a remote Mullion host. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type { Host, HostConfig, HostUpdateStatus, UpdateStatus } from "./types.js";

export const hostsApi = {
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
  // message names the project count, per ./client.ts's request() own
  // body.message handling).
  deleteHost: (id: string, opts?: { cascade?: boolean }) =>
    request<void>(`/api/hosts/${encodeURIComponent(id)}${opts?.cascade ? "?cascade=true" : ""}`, {
      method: "DELETE",
    }),

  pingHost: (id: string) =>
    request<{ online: boolean }>(`/api/hosts/${encodeURIComponent(id)}/ping`, { method: "POST" }),

  getHostConfig: (id: string) => request<HostConfig>(`/api/hosts/${encodeURIComponent(id)}/config`),

  // Issue #647 / roadmap 7.8.
  getHostUpdateStatus: (id: string) =>
    request<HostUpdateStatus>(`/api/hosts/${encodeURIComponent(id)}/update`),

  applyHostUpdate: (id: string) =>
    request<UpdateStatus>(`/api/hosts/${encodeURIComponent(id)}/update/apply`, {
      method: "POST",
    }),
};
