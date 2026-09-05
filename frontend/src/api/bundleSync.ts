// Bundle sync status/re-sync/remove (issues #944/#945) — the frontend half
// of S4's (#941) host-local, manifest-driven sync of Mullion's own
// skill/agent bundle into each CLI's global discovery directory. Its own
// small domain module (not folded into skills.ts, which is project-scoped
// skill toggling, or system.ts's grab-bag) — three endpoints under their own
// `/api/bundle-sync/*` prefix, matching this directory's one-module-per-
// resource convention.
import { request } from "./client.js";
import type { BundleSyncStatus, BundleSyncResyncResult, BundleSyncRemoveResult } from "./types.js";

export const bundleSyncApi = {
  getBundleSyncStatus: () => request<BundleSyncStatus>("/api/bundle-sync/status"),

  // 409 ({ error: "disabled" }) when sessions.injectMullionBundle is off —
  // the panel already hides/disables this action in that state, but the
  // caller still gets a typed ApiError back to handle defensively.
  resyncBundle: () =>
    request<BundleSyncResyncResult>("/api/bundle-sync/resync", { method: "POST" }),

  // Also flips sessions.injectMullionBundle to false server-side (hence
  // `settingDisabled: true` in the response) — callers must reflect that in
  // any local copy of the setting (see BundleSyncPanel.tsx).
  removeBundleContent: () =>
    request<BundleSyncRemoveResult>("/api/bundle-sync/remove", { method: "POST" }),
};
