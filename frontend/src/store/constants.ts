import type { ServerInfo } from "../api/index.js";

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

// Issue #673 — the fixed window slices/events.ts's status-bearing /ws/events
// frames are throttled onto before triggering a refreshSessions() call: fire
// once immediately, then suppress further refreshes until this many ms have
// passed, firing exactly one more if anything arrived during the window
// (leading + trailing, NOT a pure trailing debounce — see that slice's own
// comment for why sustained traffic mustn't be able to starve the trailing
// call the way slices/tasks.ts's/slices/github.ts's 250ms debounce could).
// LIVE_REFRESH_INTERVAL_MS above stays the fallback for whenever this push
// channel is disconnected or reconnecting.
export const EVENTS_REFRESH_THROTTLE_MS = 400;

// Consecutive failed session-fetches (from any caller — the live poll,
// Sidebar's own mount fetch, the /ws/events-triggered refresh added for
// issue #673, etc.) before the design's "whole backend down" banner shows.
// >1 so a single transient blip doesn't flash it. The live-refresh poll is
// no longer the only frequent caller (issue #673 added a second, throttled
// to EVENTS_REFRESH_THROTTLE_MS above) — a GET failing while the WS push is
// still up and running is itself a meaningful signal, so counting it here
// rather than exempting it is intentional, not an oversight.
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
