// Multi-host registry (issue #26/#246) — registering, updating, pinging, and
// reading the config of a remote Mullion host. Split out of the former flat
// frontend/src/api.ts (PR 22 of the refactoring roadmap).
import { request } from "./client.js";
import type {
  DetectCheckoutsResult,
  Host,
  HostConfig,
  HostUpdateStatus,
  UpdateStatus,
} from "./types.js";

export const hostsApi = {
  listHosts: () => request<Host[]>("/api/hosts"),

  // baseUrl and token are optional: without a token the primary mints one and
  // returns it ONCE on this response; without a baseUrl the host stays pending
  // until its agent registers and reports its own.
  createHost: (name: string, baseUrl?: string, token?: string) =>
    request<Host & { token?: string }>("/api/hosts", {
      method: "POST",
      body: JSON.stringify({ name, baseUrl, token }),
    }),

  // A fresh token, returned once. The running agent loses access until its
  // .env carries it (see src/routes/hosts.ts).
  rotateHostToken: (id: string) =>
    request<{ token: string }>(`/api/hosts/${encodeURIComponent(id)}/rotate-token`, {
      method: "POST",
    }),

  // Issue #1725 / roadmap 8.11 — `drained` parks the host (it takes no new
  // work) or un-parks it. A flag, not an action: nothing is terminated.
  updateHost: (
    id: string,
    patch: Partial<{
      name: string;
      baseUrl: string;
      token: string;
      drained: boolean;
      role: "worker" | "burst";
    }>,
  ) =>
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

  // Issue #2090 — "Detect now": run the auto-detect sweep for this host. A no-op
  // (`enabled: false`) while the setting is off, so the caller can say so.
  detectHostCheckouts: (id: string) =>
    request<DetectCheckoutsResult>(`/api/hosts/${encodeURIComponent(id)}/detect-checkouts`, {
      method: "POST",
    }),

  getHostConfig: (id: string) => request<HostConfig>(`/api/hosts/${encodeURIComponent(id)}/config`),

  // Issue #1951 follow-up — save (or, with null, remove) a remote host's
  // project-roots override; resolves to the host's fresh config.
  setHostProjectsRoots: (id: string, roots: string[] | null) =>
    request<HostConfig>(`/api/hosts/${encodeURIComponent(id)}/config/projects-roots`, {
      method: "PUT",
      body: JSON.stringify({ roots }),
    }),

  // Issue #647 / roadmap 7.8.
  getHostUpdateStatus: (id: string) =>
    request<HostUpdateStatus>(`/api/hosts/${encodeURIComponent(id)}/update`),

  applyHostUpdate: (id: string) =>
    request<UpdateStatus>(`/api/hosts/${encodeURIComponent(id)}/update/apply`, {
      method: "POST",
    }),
};
