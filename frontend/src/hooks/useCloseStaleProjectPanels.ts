import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import type { Project } from "../api/index.js";
import { staleProjectPanelIds } from "../panelUtils.js";

// Extracted from App.tsx (issue #2407). The hook is called at the effect's
// original position so its order among App's other effects is unchanged.
// The effect body, dependency array, and any eslint-disable inside it are
// the original text.

export interface UseCloseStaleProjectPanelsParams {
  projects: Project[];
  projectsLoaded: boolean;
  projectsError: string | null;
  dockviewApi: DockviewApi | null;
}

export function useCloseStaleProjectPanels({
  projects,
  projectsLoaded,
  projectsError,
  dockviewApi,
}: UseCloseStaleProjectPanelsParams): void {
  // A project-scoped panel (`project-hub-<id>`, `file-editor-<id>`) outliving
  // its project, e.g. one merged into another (issue #2232), would render an
  // empty hub forever. Gated on projectsLoaded: `projects` starts [] and every
  // such panel would otherwise be closed before GET /api/projects resolves, or
  // after it fails (the list then stays empty, and every project looks gone).
  useEffect(() => {
    if (!dockviewApi || !projectsLoaded || projectsError !== null) return;
    const stale = staleProjectPanelIds(
      dockviewApi.panels.map((p) => p.id),
      projects.map((p) => p.id),
    );
    for (const id of stale) dockviewApi.getPanel(id)?.api.close();
  }, [projects, projectsLoaded, projectsError, dockviewApi]);
}
