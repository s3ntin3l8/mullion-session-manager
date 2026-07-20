import type { DockviewApi, DockviewGroupPanel, Position, SerializedDockview } from "dockview";
import { positionToDirection } from "dockview";
import type { Session } from "./api.js";
import { initialPaneTitle } from "./paneTitle.js";

export interface DropTarget {
  group: DockviewGroupPanel | undefined;
  location: "tab" | "header_space" | "content" | "edge";
  position: Position;
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
  const panel = api.addPanel({
    id: panelId,
    component: "terminal",
    tabComponent: "terminal",
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
    ...(!isMobile && { floating: true }),
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

  if (target && target.group) {
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
    api.addPanel({ ...panelBase, floating: true });
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
