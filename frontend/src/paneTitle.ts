import type { Session } from "./api.js";

// Split out of App.tsx (same rationale as attention.ts) so these pure
// title-formatting rules stay unit-testable without pulling in App.tsx's
// dockview-react/xterm dependency graph.

// "opencode · my-project" — the running-program title (OSC-detected or the
// launch name/command) with project context appended. Title-first, unlike
// NotificationBell's project-first subtitle format, which serves a different
// (dropdown) layout and has its own "Unknown project" fallback — not the same
// helper despite the shared "· " separator.
export function formatPaneTitle(title: string, projectName: string | undefined): string {
  return projectName ? `${title} · ${projectName}` : title;
}

// Title a terminal panel gets at `addPanel` time (issue #69). Order of
// precedence:
//  1. An explicit rename (nameLocked) always wins — that's the whole point
//     of pinning.
//  2. Otherwise, seed from `session.lastTitle` (the backend's last-seen OSC
//     title, refreshed on the ~4s session poll) if present — covers
//     reopening a pane for a session that's already running a program:
//     xterm's onTitleChange won't re-fire on its own since no new OSC
//     sequence is emitted, so without this the tab would show the stale
//     launch name/command until the program next retitles itself.
//  3. Otherwise, the launch-pattern name (CommandPalette) or raw command,
//     same as before this fix — live OSC updates take it from here.
export function initialPaneTitle(session: Session, projectName: string | undefined): string {
  if (session.nameLocked && session.name) return session.name;
  if (session.lastTitle) return formatPaneTitle(session.lastTitle, projectName);
  return session.name || session.command;
}
