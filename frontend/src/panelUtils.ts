import type { DockviewApi, DockviewGroupPanel, Position, SerializedDockview } from "dockview";
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
    params: { sessionId: session.id },
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
