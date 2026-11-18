import type { Session } from "./api/index.js";
import {
  selectSessionTitleContexts,
  sessionTitle,
  sessionTitleIsAgentTitle,
} from "./lib/sessionDisplay.js";
import type { SessionTitleContext } from "./lib/sessionDisplay.js";
import { useDashboardStore } from "./store/index.js";

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

// A terminal tab's title (issues #69, #3292): the session's one title order
// (`sessionTitle`, #3285) — the user's name, the task title, the agent's
// terminal title (`lastTitle`; for a live update the caller passes the OSC
// title in it), the worktree branch, the numbered launch name. Only a title
// from the agent's own terminal step gets the " · project" suffix, as before;
// a name, a task title, a branch or a launch name stands alone.
export function paneTabTitle(
  session: Session,
  projectName: string | undefined,
  ctx?: SessionTitleContext,
): string {
  const title = sessionTitle(session, ctx);
  return sessionTitleIsAgentTitle(session, ctx) ? formatPaneTitle(title, projectName) : title;
}

// Title a terminal panel gets at `addPanel` time. `lastTitle` seeds it for a
// session that is already running a program (xterm's onTitleChange will not
// re-fire on its own); live OSC updates take it from there. `ctx` defaults to
// the store's task link and number for the session.
export function initialPaneTitle(
  session: Session,
  projectName: string | undefined,
  ctx?: SessionTitleContext,
): string {
  const resolved = ctx ?? selectSessionTitleContexts(useDashboardStore.getState()).get(session.id);
  return paneTabTitle(session, projectName, resolved);
}

// The pane-tab/sidebar branch sub-label (issue #96) — "main" or "main *"
// once a project's git status is known to be dirty, matching the
// `git status`/prompt convention of a trailing `*` for uncommitted changes.
// `null` (no branch known — not a repo, or not fetched yet) renders nothing,
// so callers should skip the sub-label entirely rather than showing this.
export function formatBranchLabel(branch: string | null, isDirty: boolean): string | null {
  if (!branch) return null;
  return isDirty ? `${branch} *` : branch;
}
