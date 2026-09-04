// Host-level, non-resource-scoped surface: the global launcher/action
// catalog, server info + self-update, and in-process auth — none of these
// are naturally "projects/sessions/tasks/github/git/hosts/workspaces/
// settings/docker/skills", so they're grouped here as their own domain
// rather than force-fit into one of those. See this PR's write-up for the
// deviation note. Split out of the former flat frontend/src/api.ts (PR 22
// of the refactoring roadmap).
import { request, setGlobalRateLimitMax } from "./client.js";
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

  // Issue #1006 — every call also seeds client.ts's global 429-breaker
  // discriminator with the server's actual rateLimit.max (operator-
  // configurable via RATE_LIMIT_MAX), so a later 429 elsewhere can tell a
  // shared-bucket hit from a route-scoped one. Seeded here (not at one call
  // site) so it's live before ANY of this function's six call sites' own
  // first 429 could occur. Residual gap: if THIS request is itself the one
  // that 429s from the global bucket, the seed never lands for it — the
  // per-key breaker still covers that single retry, just not the wider
  // gate, until a later successful call gets through.
  //
  // Deliberately NOT `async () => { const info = await request(...); ...;
  // return info; }` — wrapping the request in an extra `await` returns a
  // NEW promise that resolves one microtask tick later than `request()`'s
  // own, which BrowserPanel.test.tsx's "re-requests a preview when Reload
  // is clicked" pins as observable: its project-bound preview effect races
  // an in-flight `await api.getServerInfo()` against that same effect's own
  // cleanup (`cancelled = true`) when `savedUrls` updates mid-flight, and
  // the extra tick was enough to flip which one wins, silently dropping a
  // preview-creation call. Attaching the seed as a second subscriber on the
  // SAME promise `request()` returns keeps that promise's resolution timing
  // untouched for every caller.
  getServerInfo: () => {
    const info = request<ServerInfo>("/api/server-info");
    info.then((data) => setGlobalRateLimitMax(data.rateLimit.max)).catch(() => {});
    return info;
  },
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

  listOpenCodeModels: () => request<string[]>("/api/opencode/models"),
};
