import type { DockviewApi, DockviewGroupPanel, Position } from "dockview";
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
