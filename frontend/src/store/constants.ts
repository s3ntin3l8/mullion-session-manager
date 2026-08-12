import type { ServerInfo } from "../api.js";

// How often the live-refresh loop re-fetches sessions so status badges
// (activity/attention/exited) reflect the backend without waiting on a
// mutation. Paused while the tab is hidden (visibilitychange) — no point
// polling a backgrounded tab, and it keeps a laptop-in-a-drawer session from
// hammering the API forever.
export const LIVE_REFRESH_INTERVAL_MS = 4000;
// Bound on each session's own accumulated event list in the store (issue
// #166) — generous headroom above the backend's own ~100-per-session ring
// buffer cap (pty-manager.ts's EVENTS_MAX) since this also has to hold
// whatever a single replay batch delivers on (re)connect.
export const EVENTS_PER_SESSION_CAP = 200;
// How long the pane-tab / panel-body highlight flash lasts when a session
// is clicked in the sidebar (matches the CSS animation duration + buffer).
export const HIGHLIGHT_DURATION_MS = 1200;

// Consecutive failed session-fetches (from any caller — the live poll,
// Sidebar's own mount fetch, etc.) before the design's "whole backend down"
// banner shows. >1 so a single transient blip doesn't flash it; in
// practice only the frequent live-refresh poll realistically accumulates
// this fast, since one-shot callers would need to independently fail twice
// in a row for the same thing to happen from them alone.
export const BACKEND_UNREACHABLE_THRESHOLD = 2;

export const SIDEBAR_MIN_WIDTH = 288;
export const SIDEBAR_MAX_WIDTH = 500;

// Used to resolve taskMasterEnabled before the real env has ever loaded
// (matches the pre-existing initial state of false: settings.taskMaster's
// own default is "inherit", and this fallback's enabled is false). Once
// GET /api/server-info's taskMasterEnv lands, it's cached in store state
// (see the DashboardState field below) and every subsequent resolution
// uses the real value instead. Exported so Settings.tsx's Task Master
// section can fall back to the same values before its own env fetch
// resolves, rather than duplicating this table.
//
// These six values MUST match src/plugins/env.ts's own MULLION_TASK_*
// defaults (Hermes review, PR #480) — this is a real, if narrow, drift
// risk: a future change to one side isn't caught by anything except a
// human noticing during review. Only matters for the brief pre-load
// window (server-info's own value always wins once fetched), so a
// full cross-cutting fix (e.g. serving these from a shared source) isn't
// worth it for a display-only fallback — just keep the two in sync by hand.
export const FALLBACK_TASK_MASTER_ENV: ServerInfo["taskMasterEnv"] = {
  enabled: false,
  maxConcurrent: 2,
  budgetMinutes: 120,
  progressCommentMinutes: 15,
  skipPermissions: false,
  issueLabel: "mullion-task",
  pollIntervalSeconds: 60,
};

// How long to wait after the last updateSettings() call before firing the
// PATCH — long enough that a slider/number-field drag collapses into one
// request, short enough that a toggle click still feels instant on the
// network (well under the live-refresh poll interval).
export const SETTINGS_PATCH_DEBOUNCE_MS = 400;
