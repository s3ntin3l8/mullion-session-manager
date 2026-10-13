import { useState } from "react";
import type { ComponentType } from "react";
import { AgentRulesPanel } from "./AgentRulesPanel.js";
import { DockConfigPanel } from "./DockConfigPanel.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ProjectBriefingPanel } from "./ProjectBriefingPanel.js";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { SkillsPanel } from "./SkillsPanel.js";

export type ProjectHubTab = "agent-rules" | "briefing" | "scaffold" | "dock" | "skills";

export interface ProjectHubPanelParams {
  projectId: number;
  tab?: ProjectHubTab;
  // Bumped by openProjectHubPanel each time it re-targets an already-open
  // panel, so a request for the SAME tab the params already name (after the
  // user navigated elsewhere) still switches back — same convention as
  // FileEditorPanel's `rev`.
  rev?: number;
}

interface TabDef {
  id: ProjectHubTab;
  label: string;
  Body: ComponentType<{ params: { projectId: number } }>;
}

const PROJECT_HUB_TABS: TabDef[] = [
  { id: "agent-rules", label: "Agent Rules", Body: AgentRulesPanel },
  { id: "briefing", label: "Briefing", Body: ProjectBriefingPanel },
  { id: "scaffold", label: "Scaffold", Body: ProjectSetupPanel },
  { id: "dock", label: "Dock", Body: DockConfigPanel },
  { id: "skills", label: "Skills", Body: SkillsPanel },
];

const DEFAULT_TAB: ProjectHubTab = "agent-rules";

// One tab's body behind its own ErrorBoundary, so one tab's crashing fetch
// doesn't take the others (or the whole panel) down.
function TabBody({ tab, projectId }: { tab: TabDef; projectId: number }) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <ErrorBoundary onReset={() => setResetKey((k) => k + 1)}>
      <tab.Body key={resetKey} params={{ projectId }} />
    </ErrorBoundary>
  );
}

export interface ProjectHubPanelProps {
  params: ProjectHubPanelParams;
  // Persists the user's tab choice with the dockview layout (the wrapper
  // forwards it to `api.updateParameters`).
  onTabChange?: (tab: ProjectHubTab) => void;
}

// One tabbed home for the infrequently-used per-project setup panels (Agent
// Rules, Briefing, Scaffold, Dock, Skills) that used to each take a dockview
// panel — and a palette row — of their own.
export function ProjectHubPanel({ params, onTabChange }: ProjectHubPanelProps) {
  const [activeTab, setActiveTab] = useState<ProjectHubTab>(params.tab ?? DEFAULT_TAB);
  // Visited tabs stay mounted (just hidden) so an unsaved draft in Agent
  // Rules / Dock / Briefing survives switching away and back.
  const [visited, setVisited] = useState<ReadonlySet<ProjectHubTab>>(() => new Set([activeTab]));

  // Adjusts state during render (see SourceControlSection's render-phase
  // adjustments / react.dev "adjusting state when a prop changes") rather
  // than an effect: a new `rev` re-targets the panel to `params.tab`.
  const [lastRev, setLastRev] = useState(params.rev);
  if (params.rev !== lastRev) {
    setLastRev(params.rev);
    if (params.tab && params.tab !== activeTab) setActiveTab(params.tab);
  }
  if (!visited.has(activeTab)) {
    setVisited(new Set([...visited, activeTab]));
  }

  const select = (tab: ProjectHubTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  return (
    <div className="project-hub">
      <div className="project-hub-tabs" role="tablist" aria-label="Project settings">
        {PROJECT_HUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`project-hub-tab-${t.id}`}
            aria-selected={activeTab === t.id}
            aria-controls={`project-hub-body-${t.id}`}
            className={`project-hub-tab${activeTab === t.id ? " active" : ""}`}
            onClick={() => select(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {PROJECT_HUB_TABS.filter((t) => visited.has(t.id)).map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`project-hub-body-${t.id}`}
          aria-labelledby={`project-hub-tab-${t.id}`}
          className="project-hub-body"
          hidden={activeTab !== t.id}
        >
          <TabBody tab={t} projectId={params.projectId} />
        </div>
      ))}
    </div>
  );
}
