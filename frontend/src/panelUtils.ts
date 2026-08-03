import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  Position,
  SerializedDockview,
} from "dockview";
import type { Task, Workspace } from "./api.js";
import { positionToDirection } from "dockview";
import type { Session } from "./api.js";
import { initialPaneTitle } from "./paneTitle.js";

// Mirrors App.tsx's own MOBILE_BREAKPOINT_QUERY (kept private there) —
// openTimelinePanel below is called from PaneTab.tsx's overflow menu, which
// has no access to App.tsx's live `isMobile` React state (it isn't threaded
// through dockview's tab `params`, which must stay JSON-serializable for
// workspace layout persistence — a callback/boolean prop can't survive
// that). A live matchMedia() check at call time is just as correct as a
// stale-by-one-render boolean would be, without new plumbing.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 699px)";

// A workspace's `layout` is an opaque dockview blob — this walks it
// generically looking for any `sessionId` value, without assuming dockview's
// exact panel-tree shape.
export function extractSessionIds(layout: Record<string, unknown> | null): Set<number> {
  const ids = new Set<number>();
  if (!layout) return ids;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key === "sessionId" && typeof val === "number") ids.add(val);
        // Phase 6 (6.5/#218) — SessionTimeline's params carry `sessionIds`
        // (plural, an array) since its own prop was widened to support a
        // task's multiple sessions (worker + optional review). Matched here
        // too so a workspace's timeline panel still counts toward
        // findSessionWorkspace/cross-workspace lookups.
        else if (key === "sessionIds" && Array.isArray(val)) {
          for (const v of val) if (typeof v === "number") ids.add(v);
        } else visit(val);
      }
    }
  };
  visit(layout);
  return ids;
}

export function findSessionWorkspace(sessionId: number, workspaces: Workspace[]): number | null {
  for (const ws of workspaces) {
    if (extractSessionIds(ws.layout).has(sessionId)) return ws.id;
  }
  return null;
}

// Resolves which project a dockview `activePanelId` string belongs to —
// there's no other "currently selected project" concept in the sidebar
// (issue #433's Source Control section). Mirrors BrowserPanel.tsx's own
// `activeSessionId` regex for the session-scoped panel ids (session/
// timeline/browserPane), plus the project-scoped ones (git/github/
// agent-rules) that App.tsx opens with a bare `-<projectId>` suffix.
export function resolveActiveProjectId(
  activePanelId: string | null,
  sessions: Session[],
): number | null {
  if (!activePanelId) return null;
  const projectMatch = activePanelId.match(/^(?:git|github|agent-rules)-(\d+)$/);
  if (projectMatch) return parseInt(projectMatch[1], 10);
  const sessionMatch = activePanelId.match(/^(?:session|timeline|browserPane)-(\d+)$/);
  if (sessionMatch) {
    const sessionId = parseInt(sessionMatch[1], 10);
    return sessions.find((s) => s.id === sessionId)?.projectId ?? null;
  }
  return null;
}

export interface DropTarget {
  group: DockviewGroupPanel | undefined;
  location: "tab" | "header_space" | "content" | "edge";
  position: Position;
}

// A panel opened from the sidebar/launcher should only ever *peek* (float)
// when there's already a tiled layout to peek across — the first panel in an
// empty workspace should dock full-screen instead (issue #121). Floating
// groups report `location.type === "floating"`; everything actually placed in
// the grid (including edge/split groups) reports "grid". Checking live
// `panel.api.location` rather than a cached count keeps this correct as
// panels are closed/docked/floated during the session.
export function hasTiledPanels(api: DockviewApi): boolean {
  return api.panels.some((p) => p.api.location.type === "grid");
}

// #98 item 4's auto-focus-on-attention effect (App.tsx) — which panel ids
// should be brought into view for a live-refresh poll tick, given the set
// of session ids that already had `attention` the *previous* tick (so this
// only fires on the transition, not every tick attention stays true — same
// shape as the existing seenAttentionRef/seenExitedRef notification
// effects). Pulled out as its own pure function (rather than inlined in the
// effect, like those two are) so the transition logic itself — independent
// of the separate Settings gate and the dockviewApi.getPanel/setActive
// calls, both of which need a live DockviewApi to test — has a unit test
// that doesn't need to mount App.tsx's dockview tree. Panel ids are
// deterministic (`session-${id}`, matching openSessionPanel above).
export function attentionTransitionPanelIds(
  sessions: Pick<Session, "id" | "attention">[],
  previouslyAttention: ReadonlySet<number>,
): string[] {
  return sessions
    .filter((s) => s.attention && !previouslyAttention.has(s.id))
    .map((s) => `session-${s.id}`);
}

// Phase 5 (Track B, issue #194 5.4) — same shape as attentionTransitionPanelIds
// above: a pure "what's new since last tick" detector, so the transition
// logic (which live children have just appeared) is unit-testable without a
// live DockviewApi. Only LIVE children (parentSessionId set, status
// "active") are candidates — a child that appeared and was already killed
// between poll ticks has nothing worth opening a panel for.
export function newChildSessionIds(
  sessions: Pick<Session, "id" | "parentSessionId" | "status">[],
  previouslySeen: ReadonlySet<number>,
): number[] {
  return sessions
    .filter((s) => s.parentSessionId !== null && s.status === "active" && !previouslySeen.has(s.id))
    .map((s) => s.id);
}

// Given a live DockviewApi and a child session's parentSessionId, returns
// the dockview `position` for opening the child's NEW panel next to its
// parent's — the same reference-panel placement App.tsx's split-launch
// effect already uses (`position: { referencePanel, direction }`), not a
// new `addGroup`-based layout engine. Returns undefined when the parent's
// own panel isn't part of the CURRENT dockview instance (a different or
// inactive workspace, or a parent the user never opened) — the caller must
// skip auto-opening entirely in that case rather than falling back to a
// position-less addPanel(), which would silently land the child's terminal
// in whatever group is currently active (independent review finding, PR #430).
export function childPanelPosition(
  api: DockviewApi,
  parentSessionId: number,
): { referencePanel: IDockviewPanel; direction: "right" } | undefined {
  const referencePanel = api.getPanel(`session-${parentSessionId}`);
  return referencePanel ? { referencePanel, direction: "right" } : undefined;
}

// Pure gate for the auto-open-child-panel effect (App.tsx) — pulled out so
// each of its five independent conditions has its own unit test without a
// live DockviewApi (there is no App.test.tsx in this codebase). `restoring`
// is the fix for a same-tick workspace-switch race: `workspaceRestored`
// (computed by the caller) can read true for one render before that same
// workspace-restore effect's own `restoringRef.current` flips to false
// (deferred via setTimeout) — a child arriving in that exact tick would
// otherwise get its panel opened right before the restore's own autosave
// effect discards the change as the restore's "echo", so it never persists.
// Blocking here is safe to no-op: the caller only marks a child "seen" from
// inside its own gated branch, so a child skipped by `restoring` is still
// correctly detected as new the next tick once restoring flips false.
export function shouldAutoOpenChildPanels(input: {
  workspaceRestored: boolean;
  hasDockviewApi: boolean;
  autoOpenChildPanels: boolean;
  sessionsLoaded: boolean;
  restoring: boolean;
}): boolean {
  return (
    input.workspaceRestored &&
    input.hasDockviewApi &&
    input.autoOpenChildPanels &&
    input.sessionsLoaded &&
    !input.restoring
  );
}

export function openSessionPanel(
  api: DockviewApi,
  session: Session,
  isMobile: boolean,
  projects: { id: number; name: string | null }[],
): void {
  const panelId = `session-${session.id}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    if (isMobile) api.maximizeGroup(existing);
    return;
  }

  const projectName = projects.find((p) => p.id === session.projectId)?.name ?? undefined;
  // Desktop: float only when there's a tiled panel to peek across; otherwise
  // dock into the grid. `position: { direction: "right" }` (rather than a bare
  // add) forces grid placement even when the active group is currently
  // floating — a bare `addPanel` would add into the active group and land
  // back inside the floating window. Mobile keeps its existing bare add +
  // maximizeGroup — it never has floating groups and relies on the
  // single-group + mobile-tabs model, which an explicit position would break.
  const panel = api.addPanel({
    id: panelId,
    component: "terminal",
    tabComponent: "terminal",
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
    ...(!isMobile &&
      (hasTiledPanels(api) ? { floating: true } : { position: { direction: "right" } })),
  });
  if (isMobile) api.maximizeGroup(panel);
}

// Issue #212 — opens (or focuses) a session's structured-event timeline
// panel (SessionTimeline.tsx). Same open-or-focus-by-stable-id and
// float-if-tiled-else-dock shape as openSessionPanel above, just a distinct
// `timeline-<id>` panel id/component so it can coexist with that session's
// own terminal panel (and be opened/closed independently of it).
export function openTimelinePanel(api: DockviewApi, session: Session): void {
  const panelId = `timeline-${session.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) api.maximizeGroup(existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "timeline",
    title: `Timeline: ${session.name || session.command}`,
    params: { sessionIds: [session.id] },
    ...(!isMobile &&
      (hasTiledPanels(api) ? { floating: true } : { position: { direction: "right" } })),
  });
  if (isMobile) api.maximizeGroup(panel);
}

// Phase 3 (#181) — opens (or focuses) a session's CDP-controlled browser
// pane (BrowserPane.tsx, distinct from the iframe-based BrowserPanel/
// `browser` component above). Same open-or-focus-by-stable-id and
// float-if-tiled-else-dock shape as openTimelinePanel above; a `browserPane-
// <sessionId>` panel id lets it coexist with that session's own terminal
// and timeline panels. The pane connects over /ws/browser/:sessionId
// (routes/browser.ts, #180), which resolves the session's *project*
// browser — there's no separate project lookup needed here.
export function openBrowserPanePanel(api: DockviewApi, session: Session): void {
  const panelId = `browserPane-${session.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) api.maximizeGroup(existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "browserPane",
    title: `Agent Browser: ${session.name || session.command}`,
    params: { sessionId: session.id },
    ...(!isMobile &&
      (hasTiledPanels(api) ? { floating: true } : { position: { direction: "right" } })),
  });
  if (isMobile) api.maximizeGroup(panel);
}

// Phase 6 (6.5/#218) — opens (or focuses) a task's detail panel
// (TaskDetail.tsx). Called from TasksPanelWrapper (App.tsx) via
// props.containerApi — same "reach the full DockviewApi from inside a
// panel" shape as openTimelinePanel/openBrowserPanePanel above.
export function openTaskDetailPanel(api: DockviewApi, task: Task): void {
  const panelId = `task-detail-${task.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) api.maximizeGroup(existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "task-detail",
    title: `Task: ${task.title}`,
    params: { taskId: task.id },
    ...(!isMobile &&
      (hasTiledPanels(api) ? { floating: true } : { position: { direction: "right" } })),
  });
  if (isMobile) api.maximizeGroup(panel);
}

function buildPanelBase(session: Session, projects: { id: number; name: string | null }[]) {
  const projectName = projects.find((p) => p.id === session.projectId)?.name ?? undefined;
  return {
    id: `session-${session.id}`,
    component: "terminal" as const,
    tabComponent: "terminal" as const,
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
  };
}

export function dropSessionPanel(
  api: DockviewApi,
  session: Session,
  projects: { id: number; name: string | null }[],
  target: DropTarget | null,
): void {
  const panelId = `session-${session.id}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }

  const panelBase = buildPanelBase(session, projects);

  // Drag-and-drop always docks (issue #121) — the previous no-target branch
  // floated, which meant a drag onto empty space (or onto a floating group,
  // which reports no usable grid target) could never build a tiled layout.
  // Only treat the target group as a real drop target when it's actually in
  // the grid; a floating group's own quadrant target isn't one.
  if (target && target.group && target.group.api.location.type === "grid") {
    if (target.location === "edge") {
      api.addPanel({
        ...panelBase,
        position: {
          referenceGroup: target.group,
          direction: positionToDirection(target.position),
        },
      });
    } else {
      api.addPanel({
        ...panelBase,
        position: { referenceGroup: target.group, direction: "within" },
      });
    }
  } else {
    api.addPanel({ ...panelBase, position: { direction: "right" } });
  }
}

function collectFloatingPanelIds(
  floatingGroups: NonNullable<SerializedDockview["floatingGroups"]>,
): Set<string> {
  const ids = new Set<string>();
  for (const fg of floatingGroups) {
    if (fg.data) {
      if (fg.data.activeView) ids.add(fg.data.activeView);
      for (const v of fg.data.views) ids.add(v);
    }
    if (fg.grid) {
      const walk = (node: { type: string; data: unknown }): string[] => {
        if (node.type === "leaf") {
          const d = node.data as { views?: string[]; activeView?: string };
          return [...(d?.views ?? []), ...(d?.activeView ? [d.activeView] : [])];
        }
        if (node.type === "branch" && Array.isArray(node.data)) {
          return node.data.flatMap((child) => walk(child as { type: string; data: unknown }));
        }
        return [];
      };
      for (const id of walk(fg.grid.root as { type: string; data: unknown })) ids.add(id);
    }
  }
  return ids;
}

export function stripFloatingPanels(serialized: SerializedDockview): SerializedDockview {
  if (!serialized.floatingGroups || serialized.floatingGroups.length === 0) return serialized;

  const floatingIds = collectFloatingPanelIds(serialized.floatingGroups);
  const panels: Record<string, (typeof serialized.panels)[string]> = {};
  for (const [id, panel] of Object.entries(serialized.panels)) {
    if (!floatingIds.has(id)) panels[id] = panel;
  }

  const { floatingGroups: _fg, activeGroup, ...rest } = serialized;
  return {
    ...rest,
    panels,
    ...(typeof activeGroup === "string" && !floatingIds.has(activeGroup) ? { activeGroup } : {}),
  } as unknown as SerializedDockview;
}
