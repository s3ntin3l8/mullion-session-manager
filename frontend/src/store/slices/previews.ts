import type { StateCreator } from "zustand";
import { api } from "../../api/index.js";
import type { DashboardState, PreviewsSlice } from "../types.js";

// Issues #2016/#2018 — the registered previews (GET /api/previews), so the
// Mullion links index can show which branches and PRs already have one, and
// the intent that opens one in the dock's browser pane from anywhere (a
// standalone GitHub panel has no direct access to App.tsx's panel opener).
//
// Not polled on a timer: listing derives each checkout preview's branch with
// a host round trip, so it refreshes when a Git/GitHub view mounts (at most
// once per PREVIEWS_MIN_INTERVAL_MS) and right after a preview is started.
const PREVIEWS_MIN_INTERVAL_MS = 15_000;

let inflight: Promise<void> | null = null;
let lastFetchedAt = 0;

/** Test hook: forget the throttle between tests. */
export function resetPreviewsThrottleForTests(): void {
  inflight = null;
  lastFetchedAt = 0;
}

export const createPreviewsSlice: StateCreator<DashboardState, [], [], PreviewsSlice> = (set) => ({
  previews: [],
  refreshPreviews: (force = false) => {
    if (inflight) return inflight;
    if (!force && Date.now() - lastFetchedAt < PREVIEWS_MIN_INTERVAL_MS) return Promise.resolve();
    inflight = (async () => {
      try {
        const info = await api.getServerInfo();
        // With previews off the route isn't registered at all.
        if (!info.previewsEnabled) return;
        set({ previews: await api.listPreviews() });
      } catch {
        // A failed list only means no preview badges; actions still work.
      } finally {
        lastFetchedAt = Date.now();
        inflight = null;
      }
    })();
    return inflight;
  },
  openPreviewRequest: null,
  requestOpenPreview: (preview) =>
    set((state) => ({
      openPreviewRequest: { ...preview, nonce: (state.openPreviewRequest?.nonce ?? 0) + 1 },
    })),
  clearOpenPreviewRequest: (nonce) =>
    set((state) =>
      state.openPreviewRequest?.nonce === nonce ? { openPreviewRequest: null } : state,
    ),
});
