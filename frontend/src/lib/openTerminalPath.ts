import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";
import { openExternalFilePanel, openFileEditorPanel } from "../panelUtils.js";
import type { LayoutContext } from "./layoutTier.js";

/**
 * Ctrl/Cmd-click (a tap on touch) on a path a session's terminal printed ->
 * the project's file editor, rooted at that session's cwd (an agent prints
 * paths relative to where it runs, which for a worktree session is the
 * worktree). Shared by the grid's terminal (panels/registry.tsx) and the
 * fold's right half (fold/RightHalfPane.tsx, #3034), which sits outside the
 * grid and so opens the editor in it: on the halves, that is the left half.
 * Reads the store at call time, so a caller's callback need not re-create on
 * every session change.
 */
export function openTerminalPath(
  api: DockviewApi,
  sessionId: number,
  layout: LayoutContext,
  rawPath: string,
  line?: number,
): void {
  const { sessions, projects } = useDashboardStore.getState();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session && projects.find((p) => p.id === session.projectId);
  if (!session || !project) return;
  const root = (session.cwd ?? project.cwd).replace(/\/+$/, "");
  let rel = rawPath;
  // `~/x`, or an absolute path outside this session's root: not a project
  // file — open the read-only external viewer, whose backend allowlist
  // (Settings -> Readable paths) decides whether it's actually openable.
  if (rel.startsWith("~/") || (rel.startsWith("/") && !rel.startsWith(`${root}/`))) {
    openExternalFilePanel(api, project.id, projects, layout, { path: rel, line });
    return;
  }
  if (rel.startsWith("/")) rel = rel.slice(root.length + 1);
  rel = rel.replace(/^(\.\/)+/, "");
  if (rel === "" || rel.startsWith("../")) return;
  openFileEditorPanel(api, project.id, projects, layout, {
    path: rel,
    sessionId: session.cwd && session.cwd !== project.cwd ? session.id : undefined,
    line,
  });
}
